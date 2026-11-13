// Dizge/ad tabloları: $GLOBALS['x'] = ['base64_decode', ...]; $GLOBALS['x'][0](...), $_123 = array(...); $_123[2],
// FOPO tarzı dizge tablosu $O = '...'; $O{4} . $O[9] — sabit indeksli okumalar değerle değişir.
// Yalnızca tablo hiç değişmiyorsa: program kapsamında tek, koşulsuz, literal atama; başka yazma/referans/unset yok;
// $GLOBALS yalnızca sabit anahtarla okunuyor; dosyada dinamik değişken erişimi ($$x, extract, eval, include) yok.
// Fonksiyonlardan (global/$GLOBALS) okunan tablolarda atamadan önce yalnızca bildirim ve literal atama bulunmalı.
import { tryParse, walk, span, applyEdits } from '../core/parse.js';
import { phpString } from '../core/values.js';

export const id = 'tables';

const DYNAMIC_CALLS = new Set(['extract', 'compact', 'get_defined_vars', 'parse_str', 'mb_parse_str', 'array_walk', 'array_walk_recursive']);
const FUNC_NAME = /^[a-zA-Z_\x80-\xff][a-zA-Z0-9_\x80-\xff]*$/;
const NOT_CALLABLE = new Set(['echo', 'print', 'eval', 'include', 'include_once', 'require', 'require_once', 'isset', 'unset', 'empty', 'exit', 'die', 'list', 'array']);
const FN = new Set(['function', 'closure', 'arrowfunc', 'method']);
// argümanını referansla alan (değiştirebilen) yaygın yerleşikler
const BYREF = /^(sort|rsort|usort|uasort|uksort|ksort|krsort|asort|arsort|natsort|natcasesort|shuffle|array_push|array_pop|array_shift|array_unshift|array_splice|array_walk|array_walk_recursive|array_multisort|preg_match|preg_match_all|preg_replace|preg_replace_callback|str_replace|str_ireplace|settype|end|reset|next|prev|each|extract|parse_str|mb_parse_str|similar_text|openssl_\w+|exec|system|passthru|getimagesize|headers_sent|fscanf|sscanf|stream_select|socket_\w+|dns_get_record|getmxrr|flock|is_callable|mb_convert_variables|array_splice)$/;

const isLit = (n) => ['string', 'number', 'boolean', 'nullkeyword'].includes(n?.kind);
const isGlobals = (n) => n?.kind === 'variable' && n.name === 'GLOBALS';

// PHP dizi anahtarı: "5" → 5, true → 1, null → ""
function keyOf(n) {
  if (n.kind === 'number') { const v = Number(n.value); return Number.isInteger(v) ? v : null; }
  if (n.kind === 'string') return /^(0|-?[1-9]\d*)$/.test(n.value) ? Number(n.value) : n.value;
  if (n.kind === 'boolean') return n.value ? 1 : 0;
  if (n.kind === 'nullkeyword') return '';
  return null;
}

// literal dizi → Map(anahtar → düğüm); literal olmayan anahtar ya da açma varsa null
function arrayTable(arr) {
  const m = new Map();
  let next = 0;
  for (const e of arr.items) {
    if (!e || e.kind !== 'entry' || e.byRef || e.unpack) return null;
    let k;
    if (e.key) { k = keyOf(e.key); if (k === null) return null; } else k = next;
    if (typeof k === 'number' && k >= next) next = k + 1;
    m.set(k, e.value);
  }
  return m;
}

export async function run(code, ctx) {
  const parsed = tryParse(code);
  if (!parsed) return code;
  const { ast } = parsed;
  const parents = new Map();
  let unsafe = false;
  walk(ast, (n, p, key) => {
    parents.set(n, [p, key]);
    if (n.kind === 'variable' && typeof n.name !== 'string') unsafe = true;
    if (n.kind === 'eval' || n.kind === 'include') unsafe = true;
    if (n.kind === 'call' && n.what?.kind === 'name' && DYNAMIC_CALLS.has(String(n.what.name).replace(/^\\/, '').toLowerCase())) unsafe = true;
    return true;
  });
  if (unsafe) return code;

  // referans parametreli kullanıcı fonksiyonları/metotları ve koddaki dizge literalleri
  const userByref = new Map();
  let anyByref = false;
  const strings = new Set();
  walk(ast, (n) => {
    if (FN.has(n.kind) && (n.arguments ?? []).some((a) => a.byref)) {
      anyByref = true;
      if (n.kind === 'function' && n.name) userByref.set(String(n.name.name ?? n.name).toLowerCase(), true);
    }
    if (n.kind === 'string') strings.add(String(n.value).toLowerCase());
    return true;
  });

  // fonksiyon bağlamı (program = null)
  const fnOf = (n) => { let c = parents.get(n)?.[0]; while (c && !FN.has(c.kind)) c = parents.get(c)?.[0]; return c ?? null; };

  // program değişkeni ad → erişimler: { node (temsil eden ifade), base, write }
  const access = new Map();
  const add = (name, rec) => { if (!access.has(name)) access.set(name, []); access.get(name).push(rec); };
  const globalsIn = new Map(); // fonksiyon düğümü → global ile alınan adlar
  walk(ast, (n) => {
    if (n.kind === 'global') {
      const f = fnOf(n);
      if (!globalsIn.has(f)) globalsIn.set(f, new Set());
      n.items.forEach((v) => globalsIn.get(f).add(v.name));
    }
    return true;
  });
  walk(ast, (n) => {
    if (n.kind !== 'variable' || typeof n.name !== 'string') return true;
    const [p, key] = parents.get(n) ?? [];
    if (p?.kind === 'global') return true;
    // closure use (&$T): tablo içeriden değiştirilebilir
    if (p?.kind === 'closure' && key === 'uses') { if (n.byref) add(n.name, { node: n, bad: true }); return true; }
    if (p?.kind === 'staticlookup' && key === 'offset') return true; // Sınıf::$özellik
    if (n.name === 'GLOBALS') {
      // $GLOBALS['ad'] → program değişkeni "ad"
      if (p?.kind !== 'offsetlookup' || key !== 'what' || p.offset?.kind !== 'string') { unsafe = true; return true; }
      add(p.offset.value, { node: p });
      return true;
    }
    const f = fnOf(n);
    if (f === null || globalsIn.get(f)?.has(n.name)) add(n.name, { node: n, inFn: f !== null });
    return true;
  });
  if (unsafe) return code;

  // atama öncesinde yalnızca bildirim/literal atama varsa fonksiyonlardan okunması güvenli
  const harmless = (s) => ['function', 'class', 'interface', 'trait', 'inline', 'noop'].includes(s.kind) ||
    (s.kind === 'expressionstatement' && s.expression.kind === 'assign' && (isLit(s.expression.right) || s.expression.right.kind === 'array'));

  const edits = [];
  let n = 0;
  for (const [name, recs] of access) {
    // tek yazım: program gövdesinde doğrudan "T = literal;" deyimi
    const writes = [];
    const reads = [];
    let bad = false;
    for (const r of recs) {
      const use = r.bad ? 'bad' : classify(r.node);
      if (use === 'write') writes.push(r);
      else if (use === 'read') reads.push(r);
      else if (use !== 'readwhole') bad = true;
    }
    if (bad || writes.length !== 1 || !reads.length) continue;
    const w = writes[0].node;
    const [assign] = parents.get(w);
    const [stmt] = parents.get(assign);
    const idx = ast.children.indexOf(stmt);
    if (idx < 0 || stmt.kind !== 'expressionstatement') continue;
    const table = assign.right.kind === 'array' ? arrayTable(assign.right) : assign.right.kind === 'string' ? assign.right.value : null;
    if (table === null) continue;
    const fromFn = recs.some((r) => r.inFn || fnOf(r.node) !== null);
    if (fromFn && !ast.children.slice(0, idx).every(harmless)) continue;
    const end = stmt.loc.end.offset;
    for (const r of reads) {
      if (fnOf(r.node) === null && r.node.loc.start.offset < end) { bad = true; break; }
    }
    if (bad) continue;
    for (const r of reads) {
      const e = replacement(r.node, table);
      if (e) { edits.push(e); n++; }
    }
  }
  if (!edits.length) return code;
  const out = applyEdits(code, edits);
  ctx.log(`tables: ${out.applied} sabit tablo okuması değeriyle değişti`, 'info');
  ctx.bump('tables', out.applied);
  return out.code;

  // erişim türü: 'write' (T = ...), 'read' (T[sabit] okuma zinciri), 'readwhole' (T'nin kendisi okunuyor, ör. count(T)), diğer: güvensiz
  function classify(node) {
    const [p, key] = parents.get(node) ?? [];
    if (p?.kind === 'assign' && key === 'left') return p.operator === '=' && !p.right?.byref ? 'write' : 'bad';
    if (p?.kind === 'offsetlookup' && key === 'what') {
      // en dıştaki okuma zinciri yazma hedefi olmamalı
      let top = p;
      for (let q = parents.get(top); q && q[0]?.kind === 'offsetlookup' && q[1] === 'what'; q = parents.get(top)) top = q[0];
      return writeContext(top) ? 'bad' : 'read';
    }
    return writeContext(node) ? 'bad' : 'readwhole';
  }
  function writeContext(node) {
    const [p, key] = parents.get(node) ?? [];
    if (!p) return false;
    if (p.kind === 'assign' && key === 'left') return true;
    if (p.kind === 'assign' && key === 'right' && p.right?.byref) return true;
    if (['post', 'pre', 'unset'].includes(p.kind)) return true;
    if (p.kind === 'foreach' && (key === 'value' || key === 'key' || (key === 'source' && p.value?.byref))) return true;
    if ((p.kind === 'list' || p.kind === 'array') && parents.get(p)?.[1] === 'left') return true;
    if (p.kind === 'entry' && p.byRef) return true;
    if ((p.kind === 'call' || p.kind === 'new') && key === 'arguments') {
      // referansla argüman alan fonksiyon tabloyu değiştirebilir: bilinen yerleşikler, dosyadaki &$p'li fonksiyonlar;
      // adı bilinmeyen çağrıda (değişkenle çağrı, metot) dosyada &$p'li fonksiyon ya da bu yerleşiklerin adı geçmemeli
      const fname = p.kind === 'call' && p.what?.kind === 'name' ? String(p.what.name).replace(/^\\/, '').toLowerCase() : null;
      if (fname) return BYREF.test(fname) || (userByref.get(fname) ?? false);
      return anyByref || [...strings].some((s) => BYREF.test(s));
    }
    return false;
  }

  // T[a][b]... okumasını literal ile değiştir
  function replacement(base, table) {
    let cur = table;
    let node = base;
    for (;;) {
      const [p, key] = parents.get(node) ?? [];
      if (p?.kind !== 'offsetlookup' || key !== 'what' || !p.offset) break;
      if (!isLit(p.offset)) break;
      let next;
      if (typeof cur === 'string') {
        const k = keyOf(p.offset);
        if (typeof k !== 'number' || k < 0 || k >= cur.length) break;
        next = cur[k];
      } else if (cur instanceof Map) {
        const k = keyOf(p.offset);
        if (k === null || !cur.has(k)) break;
        const v = cur.get(k);
        if (isLit(v)) next = v.kind === 'string' ? v.value : v;
        else if (v.kind === 'array') next = arrayTable(v);
        else break;
        if (next === null) break;
      } else break;
      cur = next;
      node = p;
    }
    if (node === base || cur instanceof Map) return null;
    const [p, key] = parents.get(node) ?? [];
    if (p && ['isset', 'empty'].includes(p.kind)) return null;
    let text;
    if (typeof cur === 'string') {
      // çağrı adı olarak: doğrudan çağrı
      if (p?.kind === 'call' && key === 'what') {
        if (!FUNC_NAME.test(cur) || NOT_CALLABLE.has(cur.toLowerCase())) return null;
        text = cur;
      } else text = phpString(cur);
    } else text = code.slice(...span(cur));
    const [s, e] = span(node);
    return { start: s, end: e, text };
  }
}
