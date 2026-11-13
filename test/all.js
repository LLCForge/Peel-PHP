// Tüm birim testleri: test/*.test.js dosyaları sırayla ayrı süreçte çalışır.
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('.', import.meta.url));
const files = readdirSync(dir).filter((f) => f.endsWith('.test.js')).sort();
let ok = 0;
for (const f of files) {
  const r = spawnSync(process.execPath, [`${dir}/${f}`], { encoding: 'utf8', timeout: 300_000 });
  const pass = r.status === 0;
  if (pass) ok++;
  process.stdout.write(`${pass ? 'ok  ' : 'FAIL'} ${f}${pass ? '' : `\n${r.stdout}${r.stderr}`}\n`);
}
console.log(`\nbirim testleri: ${ok}/${files.length}`);
if (ok !== files.length) process.exitCode = 1;
