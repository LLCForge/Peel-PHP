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
$GLOBALS['__peel'] = array('evals' => array(), 'fx' => array(), 'errors' => array(), 'sites' => array(), 'obs' => array(), 'incs' => array());

// gözlem: dönüşümün koşul değerini çalışma anında görmesi için (yalnızca analiz çalıştırmalarında eklenir)
function __peel_obs($id, $v) {
  if (!isset($GLOBALS['__peel']['obs'][$id])) $GLOBALS['__peel']['obs'][$id] = array();
  if (count($GLOBALS['__peel']['obs'][$id]) < 50) $GLOBALS['__peel']['obs'][$id][] = $v ? 1 : 0;
  return $v;
}

// değer gözlemi: dizgeler base64 ile ("s..."), diğerleri tür adıyla ("t...")
function __peel_val($id, $v) {
  if (!isset($GLOBALS['__peel']['obs'][$id])) $GLOBALS['__peel']['obs'][$id] = array();
  if (count($GLOBALS['__peel']['obs'][$id]) < 20) $GLOBALS['__peel']['obs'][$id][] = is_string($v) ? 's' . base64_encode($v) : 't' . gettype($v);
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

// preg_replace /e (PHP < 5.5): değiştirme metni her eşleşmede PHP kodu olarak çalışır. Tek eşleşmede çalışan kod
// (geri başvurular yerine konmuş, PHP'nin yaptığı gibi addslashes ile) eval gibi kaydedilir; birden çok eşleşmede
// ikinci bir işaret kaydı eklenir ki site tek koda indirgenip satır içine alınmasın.
function __peel_preg($site, $pat, $rep, $subj, $limit = -1, &$count = null) {
  if (is_string($pat) && is_string($rep) && preg_match('/^([^a-zA-Z0-9\s\\\\])(.*)\1([a-zA-Z]*)$/s', $pat, $m) && strpos($m[3], 'e') !== false) {
    $p = $m[1] . $m[2] . $m[1] . str_replace('e', '', $m[3]);
    $subjects = is_array($subj) ? $subj : array($subj);
    $codes = array();
    foreach ($subjects as $sub) {
      if (@preg_match_all($p, (string) $sub, $all, PREG_SET_ORDER)) foreach ($all as $g) $codes[] = __peel_backref($rep, $g);
    }
    foreach (array_slice($codes, 0, 2) as $c) {
      if (count($GLOBALS['__peel']['evals']) < 5000) $GLOBALS['__peel']['evals'][] = array('site' => $site, 'code' => base64_encode($c . ';'));
    }
    if (count($codes) >= 2 && $codes[0] === $codes[1]) $GLOBALS['__peel']['evals'][] = array('site' => $site, 'code' => base64_encode('/* peel: çok eşleşme */'));
  }
  return preg_replace($pat, $rep, $subj, $limit, $count);
}

function __peel_backref($r, $g) {
  $out = '';
  $n = strlen($r);
  for ($i = 0; $i < $n; $i++) {
    $c = $r[$i];
    if (($c === '\\' || $c === '$') && $i + 1 < $n && strpos('0123456789', $r[$i + 1]) !== false) {
      $k = $r[$i + 1];
      $i++;
      if ($i + 1 < $n && strpos('0123456789', $r[$i + 1]) !== false) { $k .= $r[$i + 1]; $i++; }
      $out .= isset($g[(int) $k]) ? addslashes($g[(int) $k]) : '';
      continue;
    }
    if ($c === '$' && $i + 2 < $n && $r[$i + 1] === '{' && preg_match('/^\$\{(\d+)\}/', substr($r, $i), $mm)) {
      $out .= isset($g[(int) $mm[1]]) ? addslashes($g[(int) $mm[1]]) : '';
      $i += strlen($mm[0]) - 1;
      continue;
    }
    $out .= $c;
  }
  return $out;
}

// include/require: çalışma anında yazılan dosyalar (geçici dosyaya yazıp include eden encoder'lar) eval gibi
// kaydedilir. Kayıt, başına kapanış etiketi eklenmiş içeriktir: eval böyle bir kodu include ile aynı biçimde çalıştırır. Dosyanın kendisi atlanır.
function __peel_inc($path, $site) {
  if (!is_string($path)) return $path;
  $real = __peel_fs::real($path);
  if ($real === '${INPUT_PATH}' || $real === false) return $path;
  $src = __peel_fs::read($path);
  if ($src === false) return $path;
  $id = count($GLOBALS['__peel']['evals']);
  if ($id >= 5000) return $path;
  $GLOBALS['__peel']['evals'][] = array('site' => $site, 'code' => base64_encode('?' . '>' . $src));
  $GLOBALS['__peel']['incs'][$real] = 'e' . $id . '.';
  return $path;
}

// "file" akış sarmalayıcısı: kod kendi dosyasını (bütünlük denetimi, __halt_compiler verisi) okuduğunda özgün baytları
// görür; yalnızca include ile açılan dosya araçlanmış hâliyle sunulur. Diğer her işlem gerçek dosyaya geçer.
class __peel_fs {
  var $context;
  var $h = null;
  var $buf = null;
  var $at = 0;
  static function on() { @stream_wrapper_unregister('file'); stream_wrapper_register('file', '__peel_fs'); }
  static function off() { @stream_wrapper_restore('file'); }
  static function real($path) { __peel_fs::off(); $r = realpath($path); __peel_fs::on(); return $r; }
  static function read($path) {
    __peel_fs::off();
    $h = @fopen($path, 'rb');
    $s = $h ? stream_get_contents($h) : false;
    if ($h) fclose($h);
    __peel_fs::on();
    return $s;
  }
  function stream_open($path, $mode, $options, &$opened) {
    // 128 = STREAM_OPEN_FOR_INCLUDE
    if ($options & 128) {
      $real = __peel_fs::real($path);
      $src = __peel_fs::read($path);
      if ($src === false) return false;
      if ($real === '${INPUT_PATH}') $this->buf = __peel_instrument($src, 'f.', true, 0);
      elseif (isset($GLOBALS['__peel']['incs'][$real])) $this->buf = __peel_instrument($src, $GLOBALS['__peel']['incs'][$real], true, 2);
      else $this->buf = $src;
      $opened = $real;
      return true;
    }
    __peel_fs::off();
    $this->h = ($options & STREAM_REPORT_ERRORS) ? fopen($path, $mode, (bool) ($options & STREAM_USE_PATH)) : @fopen($path, $mode, (bool) ($options & STREAM_USE_PATH));
    __peel_fs::on();
    if ($this->h && ($options & STREAM_USE_PATH)) $opened = $path;
    return $this->h !== false;
  }
  function stream_read($n) {
    if ($this->buf !== null) { $r = (string) substr($this->buf, $this->at, $n); $this->at += strlen($r); return $r; }
    return fread($this->h, $n);
  }
  function stream_write($d) { return $this->buf !== null ? 0 : fwrite($this->h, $d); }
  function stream_eof() { return $this->buf !== null ? $this->at >= strlen($this->buf) : feof($this->h); }
  function stream_tell() { return $this->buf !== null ? $this->at : ftell($this->h); }
  function stream_seek($o, $w) {
    if ($this->buf === null) return fseek($this->h, $o, $w) === 0;
    $n = $w === SEEK_SET ? $o : ($w === SEEK_CUR ? $this->at + $o : strlen($this->buf) + $o);
    if ($n < 0) return false;
    $this->at = $n;
    return true;
  }
  function stream_stat() { return $this->buf !== null ? array('size' => strlen($this->buf), 'mode' => 0100644) : fstat($this->h); }
  function stream_flush() { return $this->buf !== null ? true : fflush($this->h); }
  function stream_close() { if ($this->h) fclose($this->h); $this->h = null; }
  function stream_lock($op) { return $this->buf !== null ? false : flock($this->h, $op); }
  function stream_truncate($n) { return $this->buf !== null ? false : ftruncate($this->h, $n); }
  function stream_set_option($o, $a, $b) { return false; }
  function stream_cast($as) { return $this->h ? $this->h : false; }
  function stream_metadata($path, $option, $value) {
    __peel_fs::off();
    if ($option === 1) $r = @touch($path, isset($value[0]) ? $value[0] : null, isset($value[1]) ? $value[1] : null);
    elseif ($option === 6) $r = @chmod($path, $value);
    else $r = false;
    __peel_fs::on();
    return $r;
  }
  function url_stat($path, $flags) {
    __peel_fs::off();
    $r = ($flags & STREAM_URL_STAT_LINK) ? @lstat($path) : @stat($path);
    __peel_fs::on();
    return $r;
  }
  function unlink($path) { __peel_fs::off(); $r = unlink($path); __peel_fs::on(); return $r; }
  function rename($a, $b) { __peel_fs::off(); $r = rename($a, $b); __peel_fs::on(); return $r; }
  function mkdir($path, $mode, $options) { __peel_fs::off(); $r = mkdir($path, $mode, (bool) ($options & STREAM_MKDIR_RECURSIVE)); __peel_fs::on(); return $r; }
  function rmdir($path, $options) { __peel_fs::off(); $r = rmdir($path); __peel_fs::on(); return $r; }
  function dir_opendir($path, $options) { __peel_fs::off(); $this->h = @opendir($path); __peel_fs::on(); return $this->h !== false; }
  function dir_readdir() { return readdir($this->h); }
  function dir_rewinddir() { rewinddir($this->h); return true; }
  function dir_closedir() { closedir($this->h); return true; }
}

// __halt_compiler sonrası verinin özgün dosyadaki konumu (araçlanmış kopyada kayar)
function __peel_halt_offset($tokens) {
  $pos = 0;
  $state = 0;
  foreach ($tokens as $t) {
    $text = is_array($t) ? $t[1] : $t;
    $pos += strlen($text);
    if ($state === 0) { if (is_array($t) && $t[0] === T_HALT_COMPILER) $state = 1; continue; }
    if (is_array($t) && ($t[0] === T_WHITESPACE || $t[0] === T_COMMENT || $t[0] === T_DOC_COMMENT)) continue;
    if ($state === 1 && $text === '(') { $state = 2; continue; }
    if ($state === 2 && $text === ')') { $state = 3; continue; }
    if ($state === 3 && ($text === ';' || (is_array($t) && $t[0] === T_CLOSE_TAG))) return $pos;
    return null;
  }
  return null;
}

// token düzeyinde: eval( X ) -> eval(__peel_rec( X , 'site')) ; create_function/assert ve include( X ) de aynı biçimde
function __peel_instrument($src, $prefix, $isFile, $base = 0) {
  if (!function_exists('token_get_all')) return $src;
  $tokens = token_get_all($isFile ? $src : '<?php ' . $src);
  $haltAt = $isFile ? __peel_halt_offset($tokens) : null;
  $out = '';
  $n = 0;
  $depth = 0;
  $wrap = array();
  $pending = null;
  $halted = false;
  $skipFirst = !$isFile;
  $pos = $base;
  $incs = array(T_INCLUDE => 'include', T_INCLUDE_ONCE => 'include_once', T_REQUIRE => 'require', T_REQUIRE_ONCE => 'require_once');
  foreach ($tokens as $i => $t) {
    if ($skipFirst) { $skipFirst = false; continue; }
    $text = is_array($t) ? $t[1] : $t;
    $at = $pos;
    $pos += strlen($text);
    if ($halted) { $out .= $text; continue; }
    if (is_array($t) && $t[0] === T_HALT_COMPILER) { $halted = true; $out .= $text; continue; }
    // __COMPILER_HALT_OFFSET__ özgün dosyadaki konumu göstermeli (kod kendi dosyasını özgün hâliyle okur)
    if ($haltAt !== null && is_array($t) && $t[0] === T_STRING && strtoupper($t[1]) === '__COMPILER_HALT_OFFSET__') { $out .= '(' . $haltAt . ')'; continue; }
    if (is_array($t) && isset($incs[$t[0]])) { $pending = $incs[$t[0]]; $pendingAt = $at; $out .= $text; continue; }
    if (is_array($t) && ($t[0] === T_EVAL || ($t[0] === T_STRING && (strtolower($t[1]) === 'assert' || strtolower($t[1]) === 'create_function' || strtolower($t[1]) === 'preg_replace')))) {
      $prev = $i > 0 ? $tokens[$i - 1] : null;
      $isMethod = is_array($prev) && ($prev[0] === T_OBJECT_OPERATOR || $prev[0] === T_DOUBLE_COLON || $prev[0] === T_FUNCTION || $prev[0] === T_NEW);
      if (!$isMethod) { $pending = ($t[0] === T_EVAL ? 'eval' : strtolower($t[1])); $pendingAt = $at; }
      // preg_replace( ... ) → __peel_preg('site', ...): /e değiştirmesiyle çalışan kod kaydedilir
      $out .= (!$isMethod && $pending === 'preg_replace') ? '__peel_preg' : $text;
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
        } elseif ($pending === 'preg_replace') {
          $out .= "('" . $site . "', ";
          $wrap[] = array($depth, 'plain', $site);
        } elseif (in_array($pending, $incs, true)) {
          $out .= '(__peel_inc(';
          $wrap[] = array($depth, 'rec', $site);
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
  @stream_wrapper_restore('file');
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

// Çalıştırıcı: özgün dosya aynı yola yazılır; include edilirken "file" sarmalayıcısı araçlanmış hâlini sunar (__FILE__ ve
// kodun kendi dosyasını okuması özgün baytları görür; __halt_compiler sonrasındaki veri dokunulmadan kalır)
export const RUNNER = String.raw`<?php
require '/peel/prelude.php';
$__peel_src = implode('', file('${ORIGINAL_PATH}'));
$__peel_h = fopen('${INPUT_PATH}', 'wb');
fwrite($__peel_h, $__peel_src);
fclose($__peel_h);
unset($__peel_src, $__peel_h);
chdir('/app');
__peel_fs::on();
include '${INPUT_PATH}';
`;
