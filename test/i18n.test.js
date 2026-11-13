// Arayüz çevirileri: TR ve EN aynı anahtarlara ve aynı {yer tutuculara} sahip olmalı; arayüz kodunda
// kullanılan her sabit anahtar (t('...'), data-i18n*) sözlükte bulunmalı.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { _dict } from '../src/i18n.js';

const { tr, en } = _dict;
const vars = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');

assert.deepEqual(Object.keys(tr).sort(), Object.keys(en).sort(), 'TR ve EN anahtarları farklı');
for (const k of Object.keys(tr)) assert.equal(vars(tr[k]), vars(en[k]), `yer tutucular farklı: ${k}`);

const root = new URL('../', import.meta.url);
const files = ['index.html', 'src/main.js', ...readdirSync(new URL('src/ui/', root)).filter((f) => f.endsWith('.js')).map((f) => `src/ui/${f}`)];
const used = new Set();
for (const f of files) {
  const src = readFileSync(new URL(f, root), 'utf8');
  for (const m of src.matchAll(/\bt\('([a-zA-Z][\w.]*)'/g)) used.add(m[1]);
  for (const m of src.matchAll(/data-i18n(?:-label|-title|-placeholder)?="([\w.]+)"/g)) used.add(m[1]);
  for (const m of src.matchAll(/cmd\('([\w.]+)'/g)) used.add(`cmd.${m[1]}`);
}
const missing = [...used].filter((k) => !(k in tr));
assert.deepEqual(missing, [], `sözlükte olmayan anahtarlar: ${missing.join(', ')}`);
console.log(`i18n: ${Object.keys(tr).length} anahtar, ${used.size} sabit kullanım denetlendi`);
