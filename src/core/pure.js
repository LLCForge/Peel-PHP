// Yan etkisiz ve belirlenimli PHP fonksiyonları: argümanları sabitse sandbox'ta hesaplanıp literal yazılabilir.
// Listede olmayan (dosya, ağ, zaman, rastgele, çıktı, global durum) hiçbir şey katlanmaz.
export const PURE_FUNCTIONS = new Set([
  // kodlama ve sıkıştırma
  'base64_decode', 'base64_encode', 'str_rot13', 'strrev', 'gzinflate', 'gzdeflate', 'gzuncompress', 'gzcompress',
  'gzdecode', 'gzencode', 'zlib_decode', 'zlib_encode', 'urldecode', 'rawurldecode', 'urlencode', 'rawurlencode',
  'hex2bin', 'bin2hex', 'pack', 'unpack', 'convert_uudecode', 'convert_uuencode', 'quoted_printable_decode',
  'quoted_printable_encode', 'html_entity_decode', 'htmlspecialchars_decode', 'htmlentities', 'htmlspecialchars',
  'utf8_decode', 'utf8_encode', 'iconv', 'mb_convert_encoding', 'json_decode', 'json_encode', 'serialize',
  'openssl_decrypt', 'openssl_encrypt', 'md5', 'sha1', 'crc32', 'hash', 'hash_hmac',
  // dizge
  'chr', 'ord', 'strtolower', 'strtoupper', 'ucfirst', 'lcfirst', 'ucwords', 'trim', 'ltrim', 'rtrim', 'chop',
  'str_replace', 'str_ireplace', 'substr', 'substr_replace', 'substr_count', 'strtr', 'str_repeat', 'str_pad',
  'str_split', 'implode', 'join', 'explode', 'sprintf', 'vsprintf', 'strlen', 'strpos', 'stripos', 'strrpos',
  'strstr', 'stristr', 'strrchr', 'str_word_count', 'stripslashes', 'stripcslashes', 'addslashes', 'addcslashes',
  'quotemeta', 'nl2br', 'wordwrap', 'chunk_split', 'number_format', 'strcmp', 'strcasecmp', 'strncmp', 'str_contains',
  'str_starts_with', 'str_ends_with', 'mb_substr', 'mb_strlen', 'mb_strtolower', 'mb_strtoupper', 'preg_quote',
  'preg_replace', 'preg_split', 'preg_match_all', 'similar_text', 'levenshtein', 'soundex', 'metaphone',
  // sayı
  'intval', 'floatval', 'strval', 'boolval', 'dechex', 'hexdec', 'octdec', 'decoct', 'bindec', 'decbin',
  'base_convert', 'abs', 'round', 'floor', 'ceil', 'max', 'min', 'pow', 'sqrt', 'intdiv', 'fmod',
  // dizi
  'array_reverse', 'array_merge', 'array_slice', 'array_keys', 'array_values', 'array_flip', 'in_array',
  'array_search', 'range', 'count', 'sizeof', 'array_combine', 'array_fill', 'array_pad', 'array_unique',
  'array_sum', 'array_product', 'array_key_exists', 'array_chunk', 'array_count_values', 'array_diff',
  'array_intersect', 'is_array', 'is_string', 'is_int', 'is_numeric', 'gettype', 'ctype_digit', 'ctype_alpha',
]);

// preg_replace yalnızca /e içermeyen desenle saftır
export const PREG_E = /^(.).*\1[a-zA-Z]*e[a-zA-Z]*$/s;

// Çözümleme ortamını sorgulayan kontroller: sandbox'ta yanlış döner, kodun gerçek davranışında da analiz aracını aramaktır
export const ANTI_ANALYSIS_EXTENSIONS = new Set(['evalhook', 'eval_hook', 'xdebug', 'vld', 'bytekit', 'runkit', 'runkit7', 'uopz', 'zend debugger', 'zend_debugger', 'phpdbg', 'xhprof', 'tideways', 'blackfire']);
