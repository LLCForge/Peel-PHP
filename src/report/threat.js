// Tehdit analizi: çözülmüş çıktı ve eval katmanları AST üzerinde gezilir. Dış girdi (süper globaller, istek
// başlıkları, php://input) akışı kaba, akışa duyarsız bir yayılımla izlenir: dış girdiden atanan değişken de
// dış girdidir. Tehlikeli sink + dış girdi birleşimi en yüksek ağırlığı alır. Metin işaretleri (madenci,
// skimmer, ters kabuk komutu, SEO gizleme) düzenli ifadeyle aranır. Sandbox'ta denenen yan etkiler de kanıttır.
import { walk } from '../core/parse.js';
import { astOf, nodeText, pick, snippet, WHERE } from './text.js';

const t = (tr, en = tr) => ({ tr, en });

export const CLASSES = {
  'code-exec-input': t('Dış girdiyle kod çalıştırma', 'Code execution from external input'),
  'command-exec': t('Komut çalıştırma', 'Command execution'),
  'file-manager': t('Dosya yöneticisi', 'File manager'),
  'file-upload': t('Dosya yükleme / yazma', 'File upload / write'),
  mailer: t('Toplu posta / spam', 'Mailer / spam'),
  'seo-spam': t('SEO gizleme / spam', 'SEO cloaking / spam'),
  'remote-code': t('Uzaktan kod indirme', 'Remote code download'),
  'reverse-shell': t('Ters kabuk', 'Reverse shell'),
  'db-dump': t('Veritabanı erişimi / dökümü', 'Database access / dump'),
  backdoor: t('Kimlik doğrulama atlatma / arka kapı', 'Authentication bypass / backdoor'),
  'crypto-miner': t('Kripto madenci', 'Crypto miner'),
  'card-skimmer': t('Kart bilgisi hırsızlığı (skimmer)', 'Card skimmer'),
  defacement: t('Site karartma (deface)', 'Defacement'),
  'privilege-escalation': t('Yetki yükseltme / kısıt aşma', 'Privilege escalation / restriction bypass'),
  persistence: t('Kendini gizleme / kalıcılık', 'Self-hiding / persistence'),
};

const SUPER = new Set(['_GET', '_POST', '_COOKIE', '_REQUEST', '_FILES']);
const SERVER_INPUT = /^(?:HTTP_|QUERY_STRING$|REQUEST_URI$|PATH_INFO$|PHP_AUTH_)/;
const SHELL = new Set(['system', 'exec', 'shell_exec', 'passthru', 'popen', 'proc_open', 'pcntl_exec']);
const CODE = new Set(['assert', 'create_function']);
const CALLBACK = new Set(['call_user_func', 'call_user_func_array', 'array_map', 'array_filter', 'array_walk', 'usort', 'uasort', 'uksort', 'register_shutdown_function', 'register_tick_function', 'forward_static_call', 'forward_static_call_array']);
const WRITE = new Set(['file_put_contents', 'fwrite', 'fputs']);
const SOCKET = new Set(['fsockopen', 'pfsockopen', 'stream_socket_client', 'socket_connect', 'socket_create']);
const FETCH = new Set(['file_get_contents', 'curl_exec', 'fopen', 'file', 'readfile', 'stream_get_contents']);
const DB = new Set(['mysqli_connect', 'mysql_connect', 'pg_connect', 'mysqli_real_connect', 'sqlsrv_connect', 'oci_connect']);
const HASH = new Set(['md5', 'sha1', 'hash', 'crypt', 'md5_file', 'hash_hmac', 'password_hash']);
const FS_GROUPS = [
  ['scandir', 'opendir', 'readdir', 'glob', 'dir'],
  ['unlink', 'rmdir'],
  ['rename', 'copy'],
  ['chmod', 'chown', 'chgrp', 'fileperms', 'touch'],
  ['filesize', 'filemtime', 'is_writable', 'is_readable', 'disk_free_space'],
  ['file_put_contents', 'fwrite', 'fopen'],
  ['mkdir'],
  ['posix_getpwuid', 'posix_getgrgid'],
];

const lc = (s) => String(s).replace(/^\\/, '').toLowerCase();
const callName = (n) => (n.kind === 'call' && n.what?.kind === 'name' ? lc(n.what.name) : null);
const strVal = (n) => (n?.kind === 'string' ? n.value : null);

/** Düğüm doğrudan dış girdi mi? */
function isSource(n) {
  if (n.kind === 'variable' && SUPER.has(n.name)) return true;
  if (n.kind === 'offsetlookup' && n.what?.kind === 'variable' && n.what.name === '_SERVER') {
    const k = strVal(n.offset);
    return k !== null && SERVER_INPUT.test(k);
  }
  const c = callName(n);
  if (c === 'getallheaders' || c === 'apache_request_headers') return true;
  if ((c === 'file_get_contents' || c === 'fopen') && /^php:\/\/input/i.test(strVal(n.arguments?.[0]) ?? '')) return true;
  return false;
}

// atamanın hedefindeki temel değişken adı ($a, $a['x'], $a->b)
function baseVar(n) {
  while (n && (n.kind === 'offsetlookup' || n.kind === 'propertylookup')) n = n.what;
  return n?.kind === 'variable' && typeof n.name === 'string' ? n.name : null;
}

function tainted(node, vars) {
  if (!node) return false;
  let hit = false;
  walk(node, (m) => {
    if (hit) return false;
    if (isSource(m) || (m.kind === 'variable' && typeof m.name === 'string' && vars.has(m.name))) hit = true;
    return !hit;
  });
  return hit;
}

/** Akışa duyarsız yayılım: dış girdiden beslenen değişkenler */
function taintedVars(ast) {
  const vars = new Set();
  let all = false;
  const flows = [];
  walk(ast, (n) => {
    if (n.kind === 'assign' || n.kind === 'assignref') flows.push([baseVar(n.left), n.right]);
    if (n.kind === 'foreach') {
      for (const k of [n.key, n.value]) if (k) flows.push([baseVar(k), n.source]);
    }
    const c = callName(n);
    if (c === 'extract' && n.arguments?.some((a) => tainted(a, new Set()))) all = true;
    if (c === 'parse_str' && n.arguments?.length >= 2) flows.push([baseVar(n.arguments[1]), n.arguments[0]]);
    return true;
  });
  for (let round = 0; round < 8; round++) {
    let changed = false;
    for (const [name, rhs] of flows) {
      if (name && !vars.has(name) && tainted(rhs, vars)) {
        vars.add(name);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return { vars, all };
}

/** Bir kaynak için AST bulguları: [{ cls, weight, ev }] */
function astFindings(src, lang) {
  const ast = astOf(src);
  if (!ast) return [];
  const where = pick(WHERE[src.where], lang);
  const { vars, all } = taintedVars(ast);
  const isT = (n) => all || tainted(n, vars);
  const out = [];
  const add = (cls, weight, node, note = '') => out.push({ cls, weight, ev: `${where}: ${snippet(nodeText(src, node))}${note}` });
  const fs = new Set();
  const calls = new Set();
  const inputLabel = pick(t(' [dış girdi]', ' [external input]'), lang);

  walk(ast, (n) => {
    const c = callName(n);
    if (c) {
      calls.add(c);
      FS_GROUPS.forEach((g, i) => { if (g.includes(c)) fs.add(i); });
    }
    const args = n.arguments ?? [];
    if (n.kind === 'eval') {
      if (isT(n.source)) add('code-exec-input', 60, n, inputLabel);
      else if (walkHas(n.source, (m) => FETCH.has(callName(m)))) add('remote-code', 45, n);
    } else if (n.kind === 'include') {
      const target = strVal(n.target);
      if (isT(n.target)) add('code-exec-input', 55, n, inputLabel);
      else if (target && /^(?:https?|ftp|data|php):/i.test(target)) add('remote-code', 45, n);
    } else if (n.kind === 'encapsed' && n.type === 'shell') {
      add('command-exec', isT(n) ? 55 : 30, n, isT(n) ? inputLabel : '');
    } else if (c && SHELL.has(c)) {
      add('command-exec', isT(args[0]) ? 55 : 30, n, isT(args[0]) ? inputLabel : '');
    } else if (c && CODE.has(c)) {
      if (args.some(isT)) add('code-exec-input', 60, n, inputLabel);
    } else if (c === 'preg_replace' && /^(.)[\s\S]*\1[a-z]*e[a-z]*$/i.test(strVal(args[0]) ?? '')) {
      add('code-exec-input', args.slice(1).some(isT) ? 60 : 35, n, args.slice(1).some(isT) ? inputLabel : '');
    } else if (c && CALLBACK.has(c)) {
      if (isT(args[0])) add('code-exec-input', 55, n, inputLabel);
    } else if (n.kind === 'call' && n.what && n.what.kind !== 'name' && n.what.kind !== 'closure') {
      if (isT(n.what)) add('code-exec-input', 55, n, inputLabel);
    } else if (c === 'move_uploaded_file') {
      add('file-upload', 35, n);
    } else if (c && WRITE.has(c)) {
      if (isT(args[0]) || isT(args[1])) add('file-upload', 35, n, inputLabel);
      if (/\.htaccess|\.user\.ini|wp-config\.php/i.test(nodeText(src, n))) add('persistence', 25, n);
      if (/index\.(?:php|html?)/i.test(nodeText(src, n))) add('defacement', 15, n);
    } else if (c === 'copy' && args.some(isT)) {
      add('file-upload', 30, n, inputLabel);
    } else if (c === 'mail') {
      add('mailer', args.some(isT) ? 35 : 10, n, args.some(isT) ? inputLabel : '');
    } else if (c && DB.has(c) && args.some(isT)) {
      add('db-dump', 25, n, inputLabel);
    } else if (n.kind === 'new' && /^(?:pdo|mysqli)$/i.test(lc(n.what?.name ?? '')) && args.some(isT)) {
      add('db-dump', 25, n, inputLabel);
    } else if ((c === 'copy' || c === 'file_put_contents') && /__FILE__/.test(nodeText(src, n))) {
      add('persistence', 20, n);
    } else if (c === 'touch' && args.length >= 2) {
      add('persistence', 20, n);
    } else if (c === 'symlink') {
      add('privilege-escalation', 15, n);
    } else if (c && /^posix_set(?:e?uid|e?gid)$/.test(c)) {
      add('privilege-escalation', 35, n);
    }
    // parola özeti karşılaştırması: md5($_POST['p']) == '…32 hex…'
    if (n.kind === 'bin' && ['==', '===', '!=', '!=='].includes(n.type)) {
      for (const [a, b] of [[n.left, n.right], [n.right, n.left]]) {
        if (HASH.has(callName(a) ?? '') && isT(a) && /^[0-9a-f]{32}$|^[0-9a-f]{40}$|^[0-9a-f]{64}$/i.test(strVal(b) ?? '')) add('backdoor', 30, n, inputLabel);
      }
    }
    return true;
  });

  if ([...calls].some((c) => SOCKET.has(c)) && [...calls].some((c) => SHELL.has(c))) {
    out.push({ cls: 'reverse-shell', weight: 50, ev: `${where}: ${[...calls].filter((c) => SOCKET.has(c) || SHELL.has(c)).join(', ')}` });
  }
  if (fs.size >= 4) out.push({ cls: 'file-manager', weight: fs.size >= 5 ? 30 : 20, ev: `${where}: ${fs.size} ${pick(t('dosya sistemi işlem grubu', 'file-system operation groups'), lang)}` });
  return out;
}

function walkHas(node, pred) {
  let hit = false;
  walk(node, (m) => { if (!hit && pred(m)) hit = true; return !hit; });
  return hit;
}

// Metin işaretleri: [sınıf, ağırlık, regex]
const TEXT = [
  ['reverse-shell', 60, /\/dev\/tcp\/|\bbash\s+-i\b|\bnc(?:at)?\s+(?:-\w+\s+)*-[ec]\s|\/bin\/(?:ba)?sh\s+-i\b|\bsocat\s+(?:tcp|exec)/i],
  ['crypto-miner', 50, /stratum\+(?:tcp|ssl):\/\/|coin-?hive|CoinHive\.Anonymous|\bxmrig\b|cryptonight|crypto-?loot|webminepool|minero\.cc/i],
  ['seo-spam', 25, /(?:googlebot|bingbot|yandexbot|baiduspider|slurp|msnbot)[\s\S]{0,400}?HTTP_(?:USER_AGENT|REFERER)|HTTP_(?:USER_AGENT|REFERER)[\s\S]{0,400}?(?:googlebot|bingbot|yandex|baiduspider|slurp|msnbot)/i],
  ['seo-spam', 15, /\b(?:viagra|cialis|payday\s+loans?|replica\s+(?:watches|handbags)|slot\s+gacor|judi\s+online)\b/i],
  ['db-dump', 25, /\bmysqldump\b|\bSHOW\s+(?:TABLES|DATABASES)\b|\bINTO\s+OUTFILE\b/i],
  ['backdoor', 35, /\bwp_(?:create|insert)_user\s*\([\s\S]{0,300}?administrator|INSERT\s+INTO\s+`?\w*users`?[\s\S]{0,300}?administrator/i],
  ['backdoor', 20, /\$auth_pass\s*=/],
  ['defacement', 30, /\b(?:hacked|defaced|h4ck3d|0wn3d)\s+by\b/i],
  ['privilege-escalation', 35, /\/etc\/(?:shadow|sudoers)\b|\bLD_PRELOAD\b|\bpkexec\b|dirty_?cow|FFI::cdef|\bchmod\s+[ug]?\+?s\b|\bchmod\s+[24][0-7]{3}\b/i],
  ['privilege-escalation', 15, /\/etc\/passwd\b|disable_functions|open_basedir/i],
  ['persistence', 20, /\bcrontab\b|ignore_user_abort\s*\(\s*(?:1|true)\s*\)[\s\S]{0,300}?set_time_limit\s*\(\s*0\s*\)|header\(\s*['"]HTTP\/1\.[01]\s+404/i],
];

// skimmer: en az iki ayrı kart alanı adı + dışarı gönderme
function skimmer(text) {
  const fields = new Set((text.match(/cc_?number|card_?number|cardnum|cc_?cid|\bcvv2?\b|\bcvc\b|cc_?exp|exp(?:iry|iration)?_?(?:month|year)|payment\[cc_\w+\]/gi) ?? []).map((s) => s.toLowerCase()));
  if (fields.size < 2) return null;
  const exfil = /\bmail\s*\(|curl_exec|fsockopen|file_put_contents|atob\s*\(|new\s+Image\s*\(|navigator\.sendBeacon|XMLHttpRequest/i.test(text);
  if (!exfil && fields.size < 3) return null;
  return { weight: exfil ? 55 : 20, ev: [...fields].slice(0, 5).join(', ') };
}

/**
 * @param {Array} sources text.js sourcesOf çıktısı
 * @param {object} behaviour analyze'daki sandbox davranışı
 * @param {Array} detection detect() çıktısı
 */
export function threat(sources, behaviour, detection, lang = 'tr') {
  const findings = [];
  // girdi katmanlıysa çözülmüş kaynaklar (katmanlar + çıktı) yeterlidir; girdi yalnız ise o da taranır
  const code = sources.length > 1 ? sources.filter((s) => s.where !== 'input') : sources;
  for (const src of code) {
    findings.push(...astFindings(src, lang));
    const where = pick(WHERE[src.where], lang);
    for (const [cls, weight, re] of TEXT) {
      const m = src.text.match(re);
      if (m) findings.push({ cls, weight, ev: `${where}: ${snippet(m[0], 80)}` });
    }
    const sk = skimmer(src.text);
    if (sk) findings.push({ cls: 'card-skimmer', weight: sk.weight, ev: `${where}: ${sk.ev}` });
  }
  const bw = pick(WHERE.behaviour, lang);
  for (const c of behaviour.commands) findings.push({ cls: 'command-exec', weight: 40, ev: `${bw}: ${c.api}(${snippet(c.command, 80)})` });
  for (const m of behaviour.mail) findings.push({ cls: 'mailer', weight: 15, ev: `${bw}: mail(${snippet(m.to, 60)})` });
  // ham soket bağlantısı kod indirme değildir: komut çalıştırmayla birlikteyse ters kabuk kanıtıdır
  const sockets = behaviour.network.filter((n) => n.target && SOCKET.has(n.api));
  if (sockets.length && behaviour.commands.length) for (const n of sockets.slice(0, 3)) findings.push({ cls: 'reverse-shell', weight: 50, ev: `${bw}: ${n.api}(${snippet(n.target, 80)})` });
  const fetched = behaviour.network.filter((n) => n.target && !SOCKET.has(n.api));
  if (fetched.length) {
    const runs = sources.some((s) => s.where === 'layer') || findings.some((f) => f.cls === 'remote-code');
    for (const n of fetched.slice(0, 5)) findings.push({ cls: 'remote-code', weight: runs ? 45 : 20, ev: `${bw}: ${n.api}(${snippet(n.target, 80)})` });
  }
  for (const f of behaviour.files) {
    if (/\.htaccess|\.user\.ini|wp-config\.php/i.test(f.path)) findings.push({ cls: 'persistence', weight: 25, ev: `${bw}: ${f.api}(${snippet(f.path, 80)})` });
  }

  const byClass = new Map();
  for (const f of findings) {
    const c = byClass.get(f.cls) ?? { id: f.cls, title: pick(CLASSES[f.cls], lang), weight: 0, evidence: [] };
    c.weight = Math.max(c.weight, f.weight);
    if (c.evidence.length < 6 && !c.evidence.includes(f.ev)) c.evidence.push(f.ev);
    byClass.set(f.cls, c);
  }
  const classes = [...byClass.values()].sort((a, b) => b.weight - a.weight);
  // en güçlü sınıf tam, diğerleri yarım ağırlıkla; bilinen webshell ailesi ayrıca puan ekler
  let score = classes.reduce((s, c, i) => s + (i === 0 ? c.weight : c.weight / 2), 0);
  const shell = Math.max(0, ...detection.filter((d) => d.kind === 'webshell').map((d) => d.confidence));
  score += shell * 50;
  score = Math.min(100, Math.round(score));
  const level = score === 0 ? 'none' : score < 20 ? 'low' : score < 45 ? 'medium' : score < 70 ? 'high' : 'critical';
  return { score, level, classes };
}
