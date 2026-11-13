// Fixture testleri: test/fixtures/*.php.x tam hattan (sandbox + davranış doğrulaması) geçer. Fixture'lar diskte
// XOR + base64'tür (zararlı koda benzeyen örnekler antivirüsü tetiklemesin), yalnızca bellekte çözülür.
//   node test/run.js            hepsi
//   node test/run.js eval-b64   tek fixture, log ve çıktısıyla
// Yönergeler PHP yorumu olarak yazılır (karşılaştırmadan önce çıktıdaki yorumlar atılır):
//   // EXPECT: echo 'hi';   çıktıda bulunmalı (boşluklar normalize edilir)
//   // GONE: base64_decode  çıktıda bulunmamalı
//   // KEEP: $_POST         çıktıda kalmalı (güvenlik: dış girdiye bağlı kod silinmemeli)
import { readdirSync, readFileSync } from 'node:fs';
import { createNodeSandbox } from '../src/sandbox/node-host.js';
import { fromBytes, toText } from '../src/core/bstr.js';
import { deobfuscate } from '../src/core/pipeline.js';
import { tokens } from '../src/core/parse.js';
import { decodeFixture } from './fixture-codec.js';

const dir = new URL('./fixtures/', import.meta.url);
const filter = process.argv[2];
const files = readdirSync(dir).filter((f) => f.endsWith('.php.x') && (!filter || f.includes(filter))).sort();

const directives = (src, key) => [...src.matchAll(new RegExp(`//\\s*${key}:\\s*(.+)$`, 'gm'))].map((m) => m[1].trim());
const norm = (s) => s.replace(/\s+/g, ' ').trim();

// yorumlar ve HTML dışı metin kalsın, yorumlar atılsın
function stripComments(code) {
  try {
    return tokens(code).map((t) => (Array.isArray(t) && (t[0] === 'T_COMMENT' || t[0] === 'T_DOC_COMMENT') ? '' : Array.isArray(t) ? t[1] : t)).join('');
  } catch {
    return code;
  }
}

const sb = createNodeSandbox();
let pass = 0;
const t0 = Date.now();
try {
  for (const f of files) {
    const src = decodeFixture(readFileSync(new URL(f, dir), 'utf8')).toString('latin1');
    const logs = [];
    const r = await deobfuscate(fromBytes(Buffer.from(src, 'latin1')), { sandbox: sb, onLog: (m, l) => logs.push(`[${l}] ${m}`) });
    const out = r.error ? '' : norm(toText(stripComments(r.code)));
    const fails = [];
    if (r.error) fails.push(`hata: ${r.error}`);
    if (!r.verified) fails.push('davranış doğrulanamadı');
    for (const e of directives(src, 'EXPECT')) if (!out.includes(norm(e))) fails.push(`EXPECT yok: ${e}`);
    for (const g of directives(src, 'GONE')) if (out.includes(norm(g))) fails.push(`GONE duruyor: ${g}`);
    for (const k of directives(src, 'KEEP')) if (!out.includes(norm(k))) fails.push(`KEEP silinmiş: ${k}`);
    if (!fails.length) pass++;
    console.log(`${fails.length ? 'FAIL' : 'ok  '} ${f} (${r.ms ?? 0} ms)${fails.length ? `\n     ${fails.join('\n     ')}` : ''}`);
    if (filter || fails.length) {
      if (filter) console.log(logs.join('\n'));
      console.log(toText(r.code ?? ''));
    }
  }
} finally {
  sb.close();
}
console.log(`\ntoplam ${Date.now() - t0}ms | ${pass}/${files.length}`);
if (pass !== files.length) process.exitCode = 1;
