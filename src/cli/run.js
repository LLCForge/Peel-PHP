// peel-php komut satırı: tarayıcıdakiyle aynı motor, aynı php-wasm sandbox.
// Dosyalar bayt olarak okunur ve yazılır (bstr): geçersiz UTF-8 ve ikili veri bozulmaz.
import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve, basename } from 'node:path';
import { peel } from '../index.js';
import { toBytes } from '../core/bstr.js';
import { createNodeSandbox } from '../sandbox/node-host.js';
import { VERSIONS } from '../sandbox/api.js';
import { parseArgs, UsageError } from './args.js';

export const EXIT = { OK: 0, ERROR: 1, USAGE: 2, THREAT: 4 };
export const MAX_INPUT = 50 * 1024 * 1024;
const LEVELS = ['none', 'low', 'medium', 'high', 'critical'];
const PHP_FILE = /\.(?:php\d?|phtml|inc)$/i;

const SPEC = {
  out: { alias: 'o', type: 'string' },
  'out-dir': { alias: 'd', type: 'string' },
  report: { alias: 'r', type: 'string' },
  json: { type: 'bool' },
  lang: { type: 'string' },
  sandbox: { type: 'bool' },
  version: { type: 'string' },
  'fail-on': { type: 'string' },
  quiet: { alias: 'q', type: 'bool' },
  help: { alias: 'h', type: 'bool' },
};

const HELP = {
  tr: `peel-php <dosya|dizin|-> [seçenekler]

Gizlenmiş PHP kodunu php-wasm sandbox'ında çalıştırarak katmanlarını açar ve analiz raporu üretir.
Ağ, komut, posta ve dosya yazma çağrıları gerçekleştirilmez, yalnızca kaydedilir.

  -o, --out <dosya>       çözülmüş kodu dosyaya yaz (tek girdi; yoksa stdout)
  -d, --out-dir <dizin>   çözülmüş kodları dizine yaz (dizin girdisinde yapı korunur)
  -r, --report <dosya>    JSON raporu dosyaya yaz (dizin girdisinde dizi)
      --json              JSON raporu stdout'a yaz (kod yazılmaz; -o/-d ile birlikte kullanılabilir)
      --lang tr|en        rapor dili (varsayılan tr)
      --no-sandbox        kodu çalıştırma, yalnızca statik dönüşümler
      --version <sürüm>   PHP sürümünü sabitle: ${VERSIONS.join(' | ')} (varsayılan: otomatik)
      --fail-on <düzey>   tehdit düzeyi bu eşiğe ulaşırsa çıkış kodu 4: low | medium | high | critical
  -q, --quiet             ilerleme ve özet yazma
  -h, --help              bu yardım

Çıkış kodları: 0 tamam, 1 hata, 2 kullanım hatası, 4 --fail-on eşiğine ulaşıldı (hatadan önceliklidir).
Ticari şifreleme (ionCube, SourceGuardian, Zend Guard…) tanınır ama bilinçli olarak çözülmez.`,
  en: `peel-php <file|dir|-> [options]

Peels obfuscated PHP by running it inside a php-wasm sandbox and produces an analysis report.
Network, command, mail and file-write calls are recorded, never performed.

  -o, --out <file>        write the decoded code to a file (single input; otherwise stdout)
  -d, --out-dir <dir>     write decoded files to a directory (directory input keeps its structure)
  -r, --report <file>     write the JSON report to a file (an array for directory input)
      --json              print the JSON report to stdout (no code; may be combined with -o/-d)
      --lang tr|en        report language (default tr)
      --no-sandbox        do not execute the code, static transforms only
      --version <ver>     pin the PHP version: ${VERSIONS.join(' | ')} (default: automatic)
      --fail-on <level>   exit with code 4 when the threat level reaches: low | medium | high | critical
  -q, --quiet             no progress or summary output
  -h, --help              this help

Exit codes: 0 ok, 1 error, 2 usage error, 4 --fail-on threshold reached (takes precedence over errors).
Commercial encoders (ionCube, SourceGuardian, Zend Guard…) are identified but intentionally not decoded.`,
};

async function readBytes(path) {
  if (path === '-') {
    const chunks = [];
    let n = 0;
    for await (const c of process.stdin) {
      n += c.length;
      if (n > MAX_INPUT) throw new Error('Girdi çok büyük');
      chunks.push(c);
    }
    return new Uint8Array(Buffer.concat(chunks));
  }
  const s = await stat(path);
  if (!s.isFile()) throw new Error(`Dosya değil: ${path}`);
  if (s.size > MAX_INPUT) throw new Error(`Dosya çok büyük: ${path}`);
  return new Uint8Array(await readFile(path));
}

/** Dizindeki PHP dosyaları (özyinelemeli, sembolik bağlar izlenmez), sıralı */
async function listPhp(root) {
  const out = [];
  const walkDir = async (dir) => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(dir, e.name);
      if (e.isDirectory()) await walkDir(p);
      else if (e.isFile() && PHP_FILE.test(e.name)) out.push(p);
    }
  };
  await walkDir(root);
  return out;
}

async function writeOut(path, bytes) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
}

const levelOf = (entry) => entry.report?.threat?.level ?? 'none';

export async function runCli(argv) {
  const { opts, positional } = parseArgs(argv, SPEC);
  const lang = opts.lang === undefined ? 'tr' : opts.lang;
  if (lang !== 'tr' && lang !== 'en') throw new UsageError(`--lang tr ya da en olmalı: ${lang}`);
  if (opts.help) { console.log(HELP[lang]); return EXIT.OK; }
  if (positional.length !== 1) throw new UsageError(`${HELP[lang]}\n\nTek bir girdi gerekli (dosya, dizin ya da -).`);
  if (opts.version !== undefined && !VERSIONS.includes(opts.version)) throw new UsageError(`--version şunlardan biri olmalı: ${VERSIONS.join(', ')}`);
  if (opts['fail-on'] !== undefined && !LEVELS.slice(1).includes(opts['fail-on'])) throw new UsageError('--fail-on şunlardan biri olmalı: low, medium, high, critical');

  const target = positional[0];
  const isDir = target !== '-' && (await stat(target).catch(() => null))?.isDirectory();
  if (isDir && opts.out) throw new UsageError('Dizin girdisinde -o yerine -d kullanın');
  const log = (m) => { if (!opts.quiet) process.stderr.write(`${m}\n`); };

  let sandbox = null;
  if (opts.sandbox !== false) {
    const sb = createNodeSandbox();
    sandbox = opts.version ? { ...sb, versions: [opts.version] } : sb;
  }
  const entries = [];
  try {
    const files = isDir ? await listPhp(target) : [target];
    if (isDir && !files.length) log(lang === 'en' ? 'No PHP files found.' : 'PHP dosyası bulunamadı.');
    for (const file of files) {
      const name = file === '-' ? '-' : isDir ? relative(target, file).split('\\').join('/') : file;
      const entry = { file: name, ok: false };
      entries.push(entry);
      let bytes;
      try {
        bytes = await readBytes(file);
      } catch (e) {
        entry.error = e.message;
        log(`${name}: ${e.message}`);
        continue;
      }
      const r = await peel(bytes, { sandbox: sandbox ?? false, lang });
      Object.assign(entry, { ok: !r.error, error: r.error, verified: Boolean(r.verified), version: r.version ?? null, ms: r.ms ?? 0, report: r.report });
      const code = toBytes(r.code);
      if (opts['out-dir']) {
        const rel = isDir ? relative(target, file) : file === '-' ? 'stdin.php' : basename(file);
        const dest = resolve(opts['out-dir'], rel);
        if (relative(resolve(opts['out-dir']), dest).startsWith('..')) throw new Error(`Çıktı dizini dışına yazma: ${rel}`);
        await writeOut(dest, code);
      }
      if (opts.out) await writeOut(opts.out, code);
      else if (!isDir && !opts['out-dir'] && !opts.json) process.stdout.write(code);
      const t = r.report.threat;
      log(`${isDir ? `${name}: ` : ''}[${t.level} ${t.score}/100]${r.error ? ` ${r.error};` : ''} ${r.report.summary}`);
    }
  } finally {
    sandbox?.close();
  }

  const payload = isDir ? entries : entries[0];
  const json = `${JSON.stringify(payload, null, 2)}\n`;
  if (opts.report) await writeOut(opts.report, json);
  if (opts.json) process.stdout.write(json);

  const failOn = opts['fail-on'];
  if (failOn && entries.some((e) => LEVELS.indexOf(levelOf(e)) >= LEVELS.indexOf(failOn))) return EXIT.THREAT;
  return entries.some((e) => !e.ok) ? EXIT.ERROR : EXIT.OK;
}
