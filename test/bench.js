// Gerçek PHP obfuscator çıktılarıyla uçtan uca ölçüm (örnekler: scripts/make-bench.js ile üretilir, test/bench/*.php.x).
//   npm run bench               hepsi
//   npm run bench yakpro        adı filtreyi içerenler
//   npm run bench -- --show ad  tek örneğin girdisini ve çıktısını yazdırır (diske düz yazılmaz)
// Her satır: davranış (çözülmüş kodun sandbox stdout'u özgün kaynağınkiyle aynı mı), beklenen özgün literallerin
// kaçı çıktıda (yorumlar hariç), kalan eval/katman sayısı (ilk → son), goto sayısı, süre.
// Gizlenmiş programın kendisi özgünden farklı yazıyorsa (araç hatası) beklenen çıktı gizlenmiş kodunkidir: "self".
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createNodeSandbox } from '../src/sandbox/node-host.js';
import { fromBytes, toText } from '../src/core/bstr.js';
import { deobfuscate } from '../src/core/pipeline.js';
import { tokens } from '../src/core/parse.js';
import { decodeFixture, encodeFixture } from './fixture-codec.js';
import { SOURCES } from './bench/sources.js';

const dir = new URL('./bench/', import.meta.url);
const outDir = new URL('./bench-out/', import.meta.url);
const args = process.argv.slice(2);
const show = args[0] === '--show' ? args[1] : null;
const filter = show ?? args[0];
const manifest = JSON.parse(readFileSync(new URL('manifest.json', dir), 'utf8'));
const names = readdirSync(dir).filter((f) => f.endsWith('.php.x')).map((f) => f.slice(0, -6))
  .filter((n) => manifest[n] && (!filter || n.includes(filter))).sort();

function codeOnly(code) {
  try {
    return tokens(code).map((t) => (Array.isArray(t) ? (t[0] === 'T_COMMENT' || t[0] === 'T_DOC_COMMENT' ? '' : t[1]) : t)).join('');
  } catch {
    return code;
  }
}
const countGoto = (code) => {
  try { return tokens(code).filter((t) => Array.isArray(t) && t[0] === 'T_GOTO').length; } catch { return NaN; }
};

const sb = createNodeSandbox();
const rows = [];
const expectCache = new Map();
mkdirSync(outDir, { recursive: true });
try {
  for (const name of names) {
    const meta = manifest[name];
    const src = SOURCES[meta.source];
    const input = fromBytes(decodeFixture(readFileSync(new URL(`${name}.php.x`, dir), 'utf8')));
    const logs = [];
    const t0 = Date.now();
    let r;
    try {
      r = await deobfuscate(input, { sandbox: sb, onLog: (m, l) => logs.push(`[${l}] ${m}`) });
    } catch (e) {
      rows.push({ name, same: false, why: e.message });
      continue;
    }
    const ms = Date.now() - t0;
    if (r.error) { rows.push({ name, same: false, why: r.error }); continue; }
    const key = `${meta.source}@${r.version}`;
    if (!expectCache.has(key)) expectCache.set(key, (await sb.run({ code: fromBytes(Buffer.from(src.code)), version: r.version })).stdout);
    const expected = expectCache.get(key);
    const own = (await sb.run({ code: input, version: r.version })).stdout;
    const got = (await sb.run({ code: r.code, version: r.version })).stdout;
    const self = own !== expected;
    const text = toText(codeOnly(r.code));
    const found = src.needles.filter((n) => text.includes(n));
    const evals = (t) => t?.evals.length ?? '-';
    rows.push({
      name,
      same: got === (self ? own : expected) ? (self ? 'self' : 'yes') : 'NO',
      needles: `${found.length}/${src.needles.length}`,
      evals: `${evals(r.trace.first)}→${evals(r.trace.final)}`,
      goto: `${countGoto(input)}→${countGoto(r.code)}`,
      kb: `${(input.length / 1024).toFixed(1)}→${(r.code.length / 1024).toFixed(1)}`,
      ms,
      rollbacks: logs.filter((l) => l.includes('geri alındı')).length,
    });
    writeFileSync(new URL(`${name}.out.php.x`, outDir), encodeFixture(Buffer.from(r.code, 'latin1')));
    writeFileSync(new URL(`${name}.log`, outDir), logs.join('\n'));
    if (show) {
      console.log(`---- girdi (${meta.tool})\n${toText(input)}\n---- log\n${logs.join('\n')}\n---- çıktı\n${r.text}`);
      if (got !== expected) console.log(`---- beklenen stdout\n${expected}\n---- çıktının stdout'u\n${got}`);
      const missing = src.needles.filter((n) => !text.includes(n));
      if (missing.length) console.log(`---- eksik literaller: ${missing.join(' | ')}`);
    }
  }
} finally {
  sb.close();
}
console.table(rows);
const ok = rows.filter((r) => (r.same === 'yes' || r.same === 'self') && r.needles && r.needles.split('/')[0] === r.needles.split('/')[1]).length;
console.log(`aynı davranış: ${rows.filter((r) => r.same === 'yes' || r.same === 'self').length}/${rows.length} | tüm literaller: ${ok}/${rows.length}`);
if (ok !== rows.length) process.exitCode = 1;
