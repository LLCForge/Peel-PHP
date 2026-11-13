// Sandbox öz-denetimi: node test/sandbox.test.js
import assert from 'node:assert/strict';
import { createNodeSandbox } from '../src/sandbox/node-host.js';

const sb = createNodeSandbox();
try {
  // eval yakalama: iç içe katmanlar, kapsam korunur
  const r = await sb.run({ code: `<?php $a = 'x'; eval(base64_decode('${Buffer.from("$b = $a . 'y'; eval('echo $b;');").toString('base64')}')); echo '|', $b;` });
  assert.equal(r.stdout, 'xy|xy');
  assert.deepEqual(r.trace.evals.map((e) => e.site), ['f.0', 'e0.0']);
  assert.equal(Buffer.from(r.trace.evals[1].code, 'base64').toString(), 'echo $b;');
  // ağ, komut ve posta kaydedilir, yapılmaz
  const n = await sb.run({ code: `<?php var_dump(file_get_contents('http://evil.example/x')); fsockopen('evil.example', 80); echo shell_exec('id'); mail('a@b.c', 's', 'm');` });
  assert.match(n.stdout, /bool\(false\)/);
  assert.deepEqual(n.trace.fx.map((f) => f[0]), ['file_get_contents', 'fsockopen', 'shell_exec', 'mail']);
  assert.equal(Buffer.from(n.trace.fx[0][1][0], 'base64').toString(), 'http://evil.example/x');
  // __FILE__ kendini okuyabilir, __halt_compiler sonrası korunur
  const h = await sb.run({ code: `<?php $d = file_get_contents(__FILE__); echo substr($d, __COMPILER_HALT_OFFSET__); __halt_compiler();DATA` });
  assert.equal(h.stdout, 'DATA');
  // sonsuz döngü: bekçi worker'ı öldürür, sonraki istek yeni motorda çalışır
  const t0 = Date.now();
  const loop = await sb.run({ code: '<?php while (true) {}', timeoutMs: 1500 });
  assert.equal(loop.ok, false);
  assert.ok(loop.timedOut);
  assert.ok(Date.now() - t0 < 20000);
  const after = await sb.run({ code: '<?php echo 1 + 1;' });
  assert.equal(after.stdout, '2');
  // eski sürümler: PHP 5.2'de preg_replace /e çalışır
  const old = await sb.run({ code: `<?php echo PHP_VERSION, '|'; eval('echo 5;');`, version: '5.2' });
  assert.match(old.stdout, /^5\.2.*\|5$/);
  // toplu ifade değerlendirme
  const ev = await sb.evaluate({ exprs: [`base64_decode('aGk=')`, `str_rot13('uv')`, `undefined_fn()`] });
  assert.equal(ev[0][0], true);
  assert.equal(Buffer.from(ev[0][1], 'base64').toString(), 's:2:"hi";');
  assert.equal(ev[2][0], false);
  console.log('sandbox: ok');
} finally {
  sb.close();
}
