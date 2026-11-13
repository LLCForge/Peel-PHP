// CLI testleri: node test/cli.test.js
// Zararlı koda benzeyen örnekler diske yazılmaz: kodlu fixture bellekte çözülüp stdin'den verilir.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeFixture } from './fixture-codec.js';

const BIN = fileURLToPath(new URL('../bin/peel-php.js', import.meta.url));
const cli = (args, input) => spawnSync(process.execPath, [BIN, ...args], { input, timeout: 240_000 });
const fixture = (name) => decodeFixture(readFileSync(new URL(`./analyze-fixtures/${name}.php.x`, import.meta.url), 'utf8'));

const tmp = mkdtempSync(join(tmpdir(), 'peel-php-cli-'));
try {
  // kullanım ve hata çıkış kodları
  assert.equal(cli(['-h']).status, 0);
  assert.match(cli(['--help', '--lang', 'en']).stdout.toString(), /Exit codes/);
  assert.equal(cli([]).status, 2);
  assert.equal(cli(['x.php', '--lang', 'de']).status, 2);
  assert.equal(cli(['x.php', '--version', '9.9']).status, 2);
  assert.equal(cli(['x.php', '--bogus']).status, 2);
  assert.equal(cli([join(tmp, 'yok.php'), '--no-sandbox', '-q']).status, 1);

  // toplu iş: dizin yapısı korunur, PHP dışı dosyalar atlanır, ikili baytlar korunur
  const src = join(tmp, 'src');
  mkdirSync(join(src, 'a', 'b'), { recursive: true });
  writeFileSync(join(src, 'a', 'b', 'x.php'), "<?php echo 'x';\n");
  const binary = Buffer.concat([Buffer.from("<?php\n$s = '"), Buffer.from([0xff, 0xfe, 0x00, 0x80, 0xc3]), Buffer.from("';\necho strlen($s);\n")]);
  writeFileSync(join(src, 'top.php'), binary);
  writeFileSync(join(src, 'readme.txt'), 'not php');
  const out = join(tmp, 'out');
  const rep = join(tmp, 'rep.json');
  let r = cli([src, '-d', out, '-r', rep, '--no-sandbox', '-q']);
  assert.equal(r.status, 0, r.stderr.toString());
  assert.ok(existsSync(join(out, 'a', 'b', 'x.php')));
  assert.ok(!existsSync(join(out, 'readme.txt')));
  assert.ok(readFileSync(join(out, 'top.php')).includes(Buffer.from([0xff, 0xfe, 0x00, 0x80, 0xc3])));
  const reports = JSON.parse(readFileSync(rep, 'utf8'));
  assert.deepEqual(reports.map((e) => e.file), ['a/b/x.php', 'top.php']);
  assert.ok(reports.every((e) => e.ok && e.report.threat.level === 'none'));

  // tek dosya: çözülmüş kod stdout'a, -o ile dosyaya
  r = cli([join(src, 'a', 'b', 'x.php'), '--no-sandbox', '-q']);
  assert.equal(r.status, 0);
  assert.match(r.stdout.toString(), /echo 'x';/);
  r = cli([join(src, 'top.php'), '-o', join(tmp, 'one.php'), '--no-sandbox', '-q']);
  assert.equal(r.status, 0);
  assert.ok(readFileSync(join(tmp, 'one.php')).includes(Buffer.from([0xff, 0xfe, 0x00, 0x80, 0xc3])));

  // stdin + --json + --fail-on: eşik aşılınca çıkış kodu 4
  r = cli(['-', '--json', '--fail-on', 'high', '--no-sandbox'], fixture('chopper'));
  assert.equal(r.status, 4, r.stderr.toString());
  const j = JSON.parse(r.stdout.toString());
  assert.equal(j.file, '-');
  assert.ok(j.report.detection.some((d) => d.id === 'china-chopper'));
  assert.equal(cli(['-', '--fail-on', 'critical', '--no-sandbox', '-q'], fixture('benign')).status, 0);

  // sandbox ile: katman açılır, rapor İngilizce
  r = cli(['-', '--json', '--lang', 'en', '--version', '8.3'], fixture('layered'));
  assert.equal(r.status, 0, r.stderr.toString());
  const l = JSON.parse(r.stdout.toString());
  assert.equal(l.version, '8.3');
  assert.ok(l.report.metrics.evals >= 1);
  assert.ok(l.report.threat.classes.some((c) => c.id === 'command-exec'));
  assert.match(l.report.summary, /Threat level/);
  console.log('cli: ok');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
