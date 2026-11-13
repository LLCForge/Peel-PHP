// Sandbox'ta kullanıcı kodundan önce çalışan PHP katmanı.
// - eval / assert / create_function çağrılarına giden kodu kaydeder; eval'in kendisi değişmez, böylece
//   çözülen kod çağıranın değişken kapsamında çalışır (katmanlı encoder'lar global değişkenlere güvenir)
// - ağ, komut, posta ve dosya yazma çağrıları kaydedilir, gerçekte yapılmaz (PHP 8: kapatılan fonksiyonun
//   yerine kayıt tutan taklit tanımlanır; PHP 5/7'de kapatılan fonksiyon çağrısı uyarı olarak yakalanır)
// - sonuç /peel/trace.json dosyasına yazılır (kapanışta: exit/die ve fatal hatalardan sonra da)
// PHP 5.2 ile uyumlu sözdizimi: closure, [] dizi, namespace, ... yok.

export const TRACE_PATH = '/peel/trace.json';
export const RUNNER_PATH = '/peel/run.php';
export const INPUT_PATH = '/app/index.php';
export const ORIGINAL_PATH = '/peel/original.php';

// PHP 8'de kapatılıp yerine kaydedici tanımlanan fonksiyonlar
export const STUBBED = [
  'exec', 'shell_exec', 'system', 'passthru', 'popen', 'proc_open', 'pcntl_exec',
  'fsockopen', 'pfsockopen', 'stream_socket_client', 'stream_socket_server',
  'curl_init', 'curl_setopt', 'curl_setopt_array', 'curl_exec', 'curl_multi_exec',
  'file_get_contents', 'file_put_contents', 'unlink', 'rename', 'chmod', 'mkdir', 'rmdir', 'copy', 'move_uploaded_file',
  'mail', 'header', 'setcookie', 'setrawcookie', 'sleep', 'usleep', 'set_time_limit', 'dl', 'ini_set', 'putenv',
  'socket_create', 'socket_connect', 'gethostbyname', 'dns_get_record', 'getmxrr',
  // belirlenimlilik: her çalıştırma aynı sonucu vermeli (davranış karşılaştırması buna dayanır)
  'time', 'microtime', 'hrtime', 'date', 'uniqid', 'random_int', 'random_bytes', 'openssl_random_pseudo_bytes', 'lcg_value',
];

// sabit saat: 2024-01-01 00:00:00 UTC
export const FIXED_TIME = 1704067200;

export const PRELUDE = String.raw`<?php
$GLOBALS['__peel'] = array('evals' => array(), 'fx' => array(), 'errors' => array(), 'sites' => array(), 'obs' => array());

// gözlem: dönüşümün koşul değerini çalışma anında görmesi için (yalnızca analiz çalıştırmalarında eklenir)
function __peel_obs($id, $v) {
  if (!isset($GLOBALS['__peel']['obs'][$id])) $GLOBALS['__peel']['obs'][$id] = array();
  if (count($GLOBALS['__peel']['obs'][$id]) < 50) $GLOBALS['__peel']['obs'][$id][] = $v ? 1 : 0;
  return $v;
}

function __peel_log($kind, $args) {
  $n = count($GLOBALS['__peel']['fx']);
  if ($n >= 2000) return;
  $out = array();
  foreach ($args as $a) {
    if (is_string($a)) $out[] = strlen($a) > 4000 ? substr($a, 0, 4000) : $a;
    elseif (is_scalar($a) || $a === null) $out[] = $a;
    else $out[] = gettype($a);
  }
  $GLOBALS['__peel']['fx'][] = array($kind, $out);
}

// eval/assert/create_function'a giden kodu kaydeder ve iç içe eval'leri de yakalanacak biçimde döndürür
function __peel_rec($code, $site) {
  if (!is_string($code)) return $code;
  $id = count($GLOBALS['__peel']['evals']);
  if ($id >= 5000) return $code;
  $GLOBALS['__peel']['evals'][] = array('site' => $site, 'code' => base64_encode($code));
  return __peel_instrument($code, 'e' . $id . '.', false);
}

// token düzeyinde: eval( X ) -> eval(__peel_rec( X , 'site')) ; create_function/assert de aynı biçimde
function __peel_instrument($src, $prefix, $isFile) {
  if (!function_exists('token_get_all')) return $src;
  $tokens = token_get_all($isFile ? $src : '<?php ' . $src);
  $out = '';
  $n = 0;
  $depth = 0;
  $wrap = array();
  $pending = null;
  $halted = false;
  $skipFirst = !$isFile;
  $pos = 0;
  foreach ($tokens as $i => $t) {
    if ($skipFirst) { $skipFirst = false; continue; }
    $text = is_array($t) ? $t[1] : $t;
    $at = $pos;
    $pos += strlen($text);
    if ($halted) { $out .= $text; continue; }
    if (is_array($t) && $t[0] === T_HALT_COMPILER) { $halted = true; $out .= $text; continue; }
    if (is_array($t) && ($t[0] === T_EVAL || ($t[0] === T_STRING && (strtolower($t[1]) === 'assert' || strtolower($t[1]) === 'create_function')))) {
      $prev = $i > 0 ? $tokens[$i - 1] : null;
      $isMethod = is_array($prev) && ($prev[0] === T_OBJECT_OPERATOR || $prev[0] === T_DOUBLE_COLON || $prev[0] === T_FUNCTION);
      if (!$isMethod) { $pending = ($t[0] === T_EVAL ? 'eval' : strtolower($t[1])); $pendingAt = $at; }
      $out .= $text;
      continue;
    }
    if ($pending !== null) {
      if (is_array($t) && ($t[0] === T_WHITESPACE || $t[0] === T_COMMENT)) { $out .= $text; continue; }
      if ($text === '(') {
        $depth++;
        $site = $prefix . $n;
        $n++;
        if (count($GLOBALS['__peel']['sites']) < 20000) $GLOBALS['__peel']['sites'][$site] = array($pending, $pendingAt, 0);
        if ($pending === 'create_function') {
          $out .= '(';
          $wrap[] = array($depth, 'cf', $site);
        } else {
          $out .= '(__peel_rec(';
          $wrap[] = array($depth, 'rec', $site);
        }
        $pending = null;
        continue;
      }
      $pending = null;
    }
    if ($text === '(' ) { $depth++; $out .= $text; continue; }
    if ($text === ')') {
      $last = count($wrap) - 1;
      if ($last >= 0 && $wrap[$last][0] === $depth) {
        $w = array_pop($wrap);
        if ($w[1] === 'rec') $out .= ", '" . $w[2] . "'))";
        else $out .= ')';
        if (isset($GLOBALS['__peel']['sites'][$w[2]])) $GLOBALS['__peel']['sites'][$w[2]][2] = $pos;
        $depth--;
        continue;
      }
      $depth--;
      $out .= $text;
      continue;
    }
    // create_function('$a', 'body'): ikinci argüman (gövde) kaydedilir
    if ($text === ',' && count($wrap) && $wrap[count($wrap) - 1][1] === 'cf' && $wrap[count($wrap) - 1][0] === $depth) {
      $w = array_pop($wrap);
      $out .= ', __peel_rec(';
      $wrap[] = array($depth, 'rec', $w[2]);
      continue;
    }
    $out .= $text;
  }
  return $out;
}

function __peel_shutdown() {
  $e = error_get_last();
  if ($e) $GLOBALS['__peel']['errors'][] = array($e['type'], $e['message'], $e['line']);
  $fx = array();
  foreach ($GLOBALS['__peel']['fx'] as $f) { $a = array(); foreach ($f[1] as $x) $a[] = is_string($x) ? base64_encode($x) : $x; $fx[] = array($f[0], $a); }
  $errs = array();
  foreach ($GLOBALS['__peel']['errors'] as $er) $errs[] = array($er[0], base64_encode($er[1]), $er[2]);
  $data = array('evals' => $GLOBALS['__peel']['evals'], 'sites' => $GLOBALS['__peel']['sites'], 'fx' => $fx, 'errors' => $errs, 'obs' => $GLOBALS['__peel']['obs'], 'version' => PHP_VERSION);
  $json = function_exists('json_encode') ? json_encode($data) : serialize($data);
  $f = fopen('${TRACE_PATH}', 'w');
  if ($f) { fwrite($f, $json); fclose($f); }
}
register_shutdown_function('__peel_shutdown');
mt_srand(1);
srand(1);

function __peel_on_error($no, $msg, $file, $line) {
  if (count($GLOBALS['__peel']['errors']) < 200) $GLOBALS['__peel']['errors'][] = array($no, $msg, $line);
  if (preg_match('/^(\w+)\(\) has been disabled/', $msg, $m)) __peel_log($m[1], array());
  return true;
}
set_error_handler('__peel_on_error');
`;

// PHP 8+: kapatılan fonksiyonların yerine kayıt tutan taklitler (eski sürümlerde yeniden tanımlama fatal hatadır)
export const STUBS_PHP8 = String.raw`
function __peel_is_url($f) { return is_string($f) && preg_match('#^[a-z][a-z0-9+.-]*://#i', $f) && stripos($f, 'file://') !== 0; }
function exec($c, &$o = null, &$r = null) { __peel_log('exec', array($c)); $o = array(); $r = 0; return ''; }
function shell_exec($c) { __peel_log('shell_exec', array($c)); return ''; }
function system($c, &$r = null) { __peel_log('system', array($c)); $r = 0; return ''; }
function passthru($c, &$r = null) { __peel_log('passthru', array($c)); $r = 0; return null; }
function popen($c, $m) { __peel_log('popen', array($c)); return false; }
function proc_open($c, $d, &$p, ...$a) { __peel_log('proc_open', array(is_array($c) ? implode(' ', $c) : $c)); return false; }
function pcntl_exec($p, $a = array(), $e = array()) { __peel_log('pcntl_exec', array($p)); return false; }
function fsockopen($h, $p = -1, &$en = null, &$es = null, $t = null) { __peel_log('fsockopen', array($h, $p)); $en = 111; $es = 'Connection refused'; return false; }
function pfsockopen($h, $p = -1, &$en = null, &$es = null, $t = null) { __peel_log('pfsockopen', array($h, $p)); return false; }
function stream_socket_client($r, &$en = null, &$es = null, ...$a) { __peel_log('stream_socket_client', array($r)); return false; }
function stream_socket_server($r, &$en = null, &$es = null, ...$a) { __peel_log('stream_socket_server', array($r)); return false; }
function curl_init($u = null) { __peel_log('curl_init', array($u)); return 'peel-curl'; }
function curl_setopt($h, $o, $v) { if (is_string($v) || is_int($v)) __peel_log('curl_setopt', array($o, $v)); return true; }
function curl_setopt_array($h, $o) { foreach ($o as $k => $v) if (is_string($v) || is_int($v)) __peel_log('curl_setopt', array($k, $v)); return true; }
function curl_exec($h) { __peel_log('curl_exec', array()); return false; }
function curl_multi_exec($m, &$r) { $r = 0; return 0; }
function file_get_contents($f, ...$a) {
  if (__peel_is_url($f)) { __peel_log('file_get_contents', array($f)); return false; }
  $lines = @file($f);
  return $lines === false ? false : implode('', $lines);
}
function file_put_contents($f, $d, $fl = 0, $c = null) {
  $s = is_array($d) ? implode('', $d) : (string) $d;
  __peel_log('file_put_contents', array($f, $s));
  $h = @fopen($f, ($fl & FILE_APPEND) ? 'a' : 'w');
  if (!$h) return false;
  fwrite($h, $s); fclose($h);
  return strlen($s);
}
function unlink($f, $c = null) { __peel_log('unlink', array($f)); return true; }
function rename($a, $b, $c = null) { __peel_log('rename', array($a, $b)); return true; }
function chmod($f, $m) { __peel_log('chmod', array($f, $m)); return true; }
function mkdir($d, $m = 0777, $r = false, $c = null) { __peel_log('mkdir', array($d)); return true; }
function rmdir($d, $c = null) { __peel_log('rmdir', array($d)); return true; }
function copy($a, $b, $c = null) { __peel_log('copy', array($a, $b)); return true; }
function move_uploaded_file($a, $b) { __peel_log('move_uploaded_file', array($a, $b)); return false; }
function mail($to, $s, $m, $h = '', $p = '') { __peel_log('mail', array($to, $s, $m)); return true; }
function header($h, $r = true, $c = 0) { __peel_log('header', array($h)); }
function setcookie($n, $v = '', ...$a) { __peel_log('setcookie', array($n, $v)); return true; }
function setrawcookie($n, $v = '', ...$a) { __peel_log('setcookie', array($n, $v)); return true; }
function sleep($s) { return 0; }
function usleep($s) { }
function set_time_limit($s) { return true; }
function dl($e) { __peel_log('dl', array($e)); return false; }
function ini_set($k, $v) { __peel_log('ini_set', array($k, $v)); return false; }
function putenv($s) { __peel_log('putenv', array($s)); return true; }
function socket_create($a, $b, $c) { __peel_log('socket_create', array()); return false; }
function socket_connect($s, $a, $p = null) { __peel_log('socket_connect', array($a, $p)); return false; }
function gethostbyname($h) { __peel_log('gethostbyname', array($h)); return $h; }
function dns_get_record($h, ...$a) { __peel_log('dns_get_record', array($h)); return false; }
function getmxrr($h, &$m, &$w = null) { __peel_log('getmxrr', array($h)); $m = array(); return false; }
function time() { return ${FIXED_TIME}; }
function microtime($f = false) { return $f ? ${FIXED_TIME}.0 : '0.00000000 ${FIXED_TIME}'; }
function hrtime($a = false) { return $a ? 0 : array(0, 0); }
function date($f, $t = null) { return gmdate($f, $t === null ? ${FIXED_TIME} : $t); }
function uniqid($p = '', $m = false) { static $n = 0; $n++; return $p . sprintf('%013x', $n); }
function random_int($a, $b) { return mt_rand($a, $b); }
function random_bytes($n) { $s = ''; for ($i = 0; $i < $n; $i++) $s .= chr(mt_rand(0, 255)); return $s; }
function openssl_random_pseudo_bytes($n, &$c = null) { $c = true; return random_bytes($n); }
function lcg_value() { return mt_rand() / mt_getrandmax(); }
if (!function_exists('create_function')) {
  function create_function($args, $code) {
    return eval('return function(' . $args . ') {' . $code . '};');
  }
}
`;

// Çalıştırıcı: özgün dosya token düzeyinde araçlanır ve aynı yola yazılıp include edilir (__FILE__ korunur,
// __halt_compiler sonrasındaki veri dokunulmadan kalır)
export const RUNNER = String.raw`<?php
require '/peel/prelude.php';
$__peel_src = implode('', file('${ORIGINAL_PATH}'));
$__peel_h = fopen('${INPUT_PATH}', 'w');
fwrite($__peel_h, __peel_instrument($__peel_src, 'f.', true));
fclose($__peel_h);
unset($__peel_src, $__peel_h);
chdir('/app');
include '${INPUT_PATH}';
`;
