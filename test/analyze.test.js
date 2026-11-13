// Analiz raporu testleri: node test/analyze.test.js
// Örnekler test/analyze-fixtures/*.php.x (XOR + base64, scripts/make-analyze-fixtures.js) ve yalnızca bellekte çözülür.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { peel } from '../src/index.js';
import { createNodeSandbox } from '../src/sandbox/node-host.js';
import { protection } from '../src/report/protection.js';
import { sha256, base58check, iocs } from '../src/report/iocs.js';
import { decodeFixture } from './fixture-codec.js';

const load = (name) => new Uint8Array(decodeFixture(readFileSync(new URL(`./analyze-fixtures/${name}.php.x`, import.meta.url), 'utf8')));
const ids = (r) => r.detection.map((d) => d.id);
const cls = (r) => r.threat.classes.map((c) => c.id);
const conf = (r, id) => r.detection.find((d) => d.id === id)?.confidence ?? 0;

// --- yardımcılar ---
assert.equal(Buffer.from(sha256(new TextEncoder().encode('abc'))).toString('hex'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
assert.equal(base58check('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa'), 0); // genesis adresi
assert.equal(base58check('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNb'), -1);
// base64 bloğun içinden geçen aday cüzdan sayılmaz
assert.deepEqual(iocs(['x="QUJD1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNaQUJD"']).wallets, []);
assert.deepEqual(iocs(['x="1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa"']).wallets, ['BTC:1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa']);

// --- ticari koruma (statik) ---
const zend = protection('<?php @Zend;\n4123;\n/* This file was encoded by Zend Guard */', 'tr');
assert.equal(zend.product, 'Zend Guard');
assert.equal(zend.decodable, false);
assert.ok(zend.notes.some((n) => n.includes('4123')));
assert.equal(protection("<?php bolt_decrypt( __FILE__ , 'k'); return 0;\n##!!!##", 'en').product, 'phpBolt');
assert.equal(protection("<?php if (!extension_loaded('swoole_loader')) die('swoole_loader74.so');", 'en').product, 'Swoole Compiler');
assert.equal(protection('<?php echo 1;', 'tr'), null);

const sb = createNodeSandbox();
const run = async (name, lang = 'tr') => (await peel(load(name), { sandbox: sb, lang })).report;
try {
  // SourceGuardian: tanınır, çözülmez, şifresiz meta veriler
  let r = await run('sourceguardian');
  assert.equal(r.protection.product, 'SourceGuardian');
  assert.equal(r.protection.decodable, false);
  assert.match(r.protection.loader, /ixed/);
  assert.ok(r.protection.notes.some((n) => n.includes('0123456789ABCDEF')));
  assert.ok(r.protection.notes.some((n) => n.includes('https://www.sourceguardian.com/loaders/download.php')));
  assert.deepEqual(r.iocs.domains, []);
  assert.match(r.summary, /SourceGuardian/);

  r = await run('ioncube', 'en');
  assert.equal(r.protection.product, 'ionCube');
  assert.ok(r.protection.notes.some((n) => n.includes('7.1, 8.1, 8.2')));
  assert.match(r.summary, /intentionally not decoded/);

  // encoder / obfuscator aileleri
  r = await run('yakpro');
  assert.ok(conf(r, 'yakpro') > 0.9);
  assert.equal(r.detection.find((d) => d.id === 'yakpro').version, '2.0.14');
  assert.ok(ids(r).includes('goto'));
  assert.deepEqual(r.iocs.urls, []); // proje adresi zararsız
  r = await run('fopo');
  assert.ok(conf(r, 'fopo') > 0.9);
  assert.equal(r.threat.level, 'none');

  // webshell aileleri ve tehdit
  r = await run('wso-like');
  assert.ok(conf(r, 'wso') >= 0.8 && conf(r, 'filesman') >= 0.8);
  assert.ok(cls(r).includes('command-exec'));
  assert.equal(r.threat.level, 'critical');
  r = await run('chopper');
  assert.ok(ids(r).includes('china-chopper'));
  assert.equal(r.threat.classes[0].id, 'code-exec-input');
  assert.ok(r.threat.classes[0].evidence[0].includes('[dış girdi]'));

  // katmanlı: eval içindeki kod analiz edilir, değişken üzerinden taşınan dış girdi izlenir, sandbox ağ denemesi IOC olur
  r = await run('layered');
  assert.ok(ids(r).includes('eval-chain'));
  assert.ok(r.threat.classes.find((c) => c.id === 'command-exec').evidence.some((e) => e.includes('[dış girdi]')));
  assert.ok(cls(r).includes('remote-code'));
  assert.equal(r.behaviour.network[0].target, 'http://payload.evil-example.net/stage2.txt');
  assert.deepEqual(r.iocs.domains, ['payload.evil-example.net']);
  assert.ok(r.metrics.evals >= 1);

  r = await run('mailer');
  assert.ok(cls(r).includes('mailer'));
  r = await run('reverse-shell');
  assert.equal(r.threat.classes[0].id, 'reverse-shell');
  assert.deepEqual(r.iocs.ips, ['198.51.100.23']);
  r = await run('miner');
  assert.ok(cls(r).includes('crypto-miner'));
  r = await run('skimmer');
  assert.ok(cls(r).includes('card-skimmer'));
  assert.deepEqual(r.iocs.emails, ['collect@skim-example.net']);
  r = await run('backdoor');
  assert.ok(cls(r).includes('backdoor'));
  r = await run('preg-e');
  assert.ok(cls(r).includes('code-exec-input'));

  // IOC türleri ve yanlış pozitif ayıklama
  r = await run('iocs');
  assert.ok(r.iocs.urls.includes('https://c2.bad-domain-example.top/gate.php?id=1'));
  assert.ok(r.iocs.benign.includes('www.php.net'));
  assert.ok(!r.iocs.domains.includes('www.php.net'));
  assert.deepEqual(r.iocs.ips, ['203.0.113.77']);
  assert.deepEqual(r.iocs.emails, ['drop.box@collector-mail.net']);
  assert.equal(r.iocs.wallets.filter((w) => w.startsWith('BTC:')).length, 1); // bozuk sağlama ve base64 içindeki aday atılır
  assert.ok(r.iocs.wallets.some((w) => w.startsWith('ETH:0x5290')));
  assert.ok(r.iocs.wallets.some((w) => w.startsWith('TRX:T')));
  assert.ok(r.iocs.telegram.includes('chat_id:-1001234567890'));
  assert.ok(r.iocs.telegram.some((x) => x.startsWith('bot:1234567890:')));
  assert.equal(r.iocs.discord.length, 1);

  // zararsız kod: tespit ve tehdit yok, özet iki dilde dolu
  r = await run('benign');
  assert.deepEqual(r.detection, []);
  assert.equal(r.threat.score, 0);
  assert.match(r.summary, /tehdit düzeyi yok/);
  r = await run('benign', 'en');
  assert.match(r.summary, /threat level none/);
  assert.equal(r.lang, 'en');
  console.log('analyze: ok');
} finally {
  sb.close();
}
