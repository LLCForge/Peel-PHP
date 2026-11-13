// Çalışma anı katman açıcı: sandbox'ın yakaladığı eval/assert/create_function kodlarını kaynaktaki yerlerine yazar.
// Site adları prelude'daki araçlamayla aynıdır: "f.N" dosyadaki N. çağrı, "eK.N" K. eval kaydının kodundaki N. çağrı.
// Bir site her çalıştığında aynı kodu verdiyse açılır; farklı kodlar (döngü) ya da hiç çalışmayan site olduğu gibi kalır.
import { fromBase64 } from './bstr.js';
import { tryParse, walk, span, applyEdits, endsInPhpMode, EVAL_PREFIX } from './parse.js';

const MAX_DEPTH = 64;
const INCLUDES = new Set(['include', 'include_once', 'require', 'require_once']);

/** Trace'i çözülmüş biçime getirir: evals[i] = { site, code (bstr) }, sites = { site: [kind, start, end] } */
export function decodeTrace(trace) {
  if (!trace) return null;
  return {
    evals: (trace.evals ?? []).map((e) => ({ site: e.site, code: fromBase64(e.code) })),
    sites: Array.isArray(trace.sites) ? {} : (trace.sites ?? {}),
    fx: (trace.fx ?? []).map(([kind, args]) => [kind, args.map((a) => (typeof a === 'string' ? fromBase64(a) : a))]),
    errors: (trace.errors ?? []).map(([type, msg, line]) => ({ type, message: fromBase64(msg), line })),
    obs: trace.obs ?? {}, // sayısal anahtarlar JSON'da liste olarak gelir; dizin erişimi ikisinde de çalışır
    version: trace.version,
  };
}

// Eval kodunun kendi kapsamında return var mı? (eval'in değeri; satır içine alınırsa dosyadan/fonksiyondan dönerdi)
const INPUTS = new Set(['_GET', '_POST', '_COOKIE', '_REQUEST', '_SERVER', '_FILES', '_ENV', '_SESSION', 'HTTP_RAW_POST_DATA', 'argv']);
// argümanlarında dış girdi okuması var mı ($_POST[...], getenv(), php://input, $GLOBALS['_GET'])
function fromInput(node) {
  let hit = false;
  for (const a of node.arguments ?? [node.source ?? node.target].filter(Boolean)) {
    walk(a, (n) => {
      if (n.kind === 'variable' && INPUTS.has(n.name)) hit = true;
      if (n.kind === 'string' && (/^php:\/\/input$/i.test(n.value) || INPUTS.has(n.value))) hit = true;
      if (n.kind === 'call' && /^(getenv|apache_request_headers|getallheaders)$/i.test(String(n.what?.name ?? ''))) hit = true;
      return !hit;
    });
  }
  return hit;
}

// Yoksa -1; tek ve doğrudan çocuk return varsa dizini; iç içe (if/döngü içinde) ya da birden çok return: Infinity.
const FN_KINDS = new Set(['function', 'closure', 'arrowfunc', 'method', 'class', 'interface', 'trait', 'enum']);
function topLevelReturn(ast) {
  let count = 0;
  walk(ast, (n) => {
    if (n !== ast && FN_KINDS.has(n.kind)) return false;
    if (n.kind === 'return') count++;
    return true;
  });
  if (!count) return -1;
  const direct = ast.children.findIndex((c) => c.kind === 'return');
  return count === 1 && direct >= 0 ? direct : Infinity;
}

// eval kodundaki __LINE__ eval metnindeki satırdır: dosyaya taşınınca değişmemesi için değeri yazılır
function fixMagic(payload) {
  const parsed = tryParse(EVAL_PREFIX + payload);
  if (!parsed) return payload;
  const edits = [];
  walk(parsed.ast, (n) => {
    if (n.kind === 'magic' && String(n.raw).toUpperCase() === '__LINE__') {
      const [s, e] = span(n);
      edits.push({ start: s - EVAL_PREFIX.length, end: e - EVAL_PREFIX.length, text: `(${n.loc.start.line})` });
    }
  });
  return edits.length ? applyEdits(payload, edits).code : payload;
}

/**
 * @param {string} code kaynak (bstr)
 * @param {ReturnType<typeof decodeTrace>} trace
 * @returns {{ code: string, opened: number, kept: Array<{site: string, reason: string}> }}
 */
export function expandLayers(code, trace) {
  const hits = new Map();
  trace.evals.forEach((e, i) => {
    if (!hits.has(e.site)) hits.set(e.site, []);
    hits.get(e.site).push(i);
  });
  const stats = { opened: 0, kept: [] };

  function expand(src, prefix, isFile, depth) {
    if (depth > MAX_DEPTH) return src;
    const local = Object.entries(trace.sites).filter(([site]) => site.startsWith(prefix) && /^\d+$/.test(site.slice(prefix.length)));
    if (!local.length) return src;
    const shift = isFile ? 0 : EVAL_PREFIX.length;
    const parsed = tryParse(isFile ? src : EVAL_PREFIX + src);
    if (!parsed) return src;
    // eval/assert/create_function düğümlerini başlangıç konumuyla bul
    const byStart = new Map();
    const parents = new Map();
    walk(parsed.ast, (node, parent) => {
      parents.set(node, parent);
      if (node.kind === 'eval' || node.kind === 'include' || (node.kind === 'call' && node.what?.kind === 'name')) {
        byStart.set(node.loc.start.offset - shift, { node, parent, grand: parent ? parents.get(parent) : null });
      }
    });
    const edits = [];
    for (const [site, [kind, start]] of local) {
      const found = byStart.get(start);
      const runs = hits.get(site);
      if (!found || !runs?.length) continue;
      const codes = new Set(runs.map((i) => trace.evals[i].code));
      if (codes.size !== 1) { stats.kept.push({ site, reason: `${codes.size} farklı kod` }); continue; }
      // güvenlik: kodu doğrudan dış girdiden gelen site (eval($_POST['c'])) ya da boş kod (girdi yokken çalışmış)
      // yerine yazılmaz; sandbox'taki boş çalıştırma gerçek davranışı temsil etmez
      if (fromInput(found.node)) { stats.kept.push({ site, reason: 'dış girdi' }); continue; }
      if (!trace.evals[runs[0]].code.replace(/^\?>/, '').trim()) { stats.kept.push({ site, reason: 'boş kod' }); continue; }
      const payload = fixMagic(trace.evals[runs[0]].code);
      const inner = expand(payload, `e${runs[0]}.`, false, depth + 1);
      const replacement = replace(kind, found, inner, isFile ? src : EVAL_PREFIX + src);
      if (!replacement) { stats.kept.push({ site, reason: 'satır içine alınamadı' }); continue; }
      edits.push({ start: replacement.start - shift, end: replacement.end - shift, text: replacement.text });
      stats.opened++;
    }
    return edits.length ? applyEdits(src, edits).code : src;
  }

  function replace(kind, { node, parent, grand }, payload, full) {
    const payloadAst = tryParse(EVAL_PREFIX + payload)?.ast;
    if (!payloadAst) return null;
    const ret = topLevelReturn(payloadAst);
    // include/require: kayıt "?>" + dosya içeriğidir; preg_replace /e: tek eşleşmede çalışan kod; deyim olarak eval gibi
    if (kind === 'eval' || kind === 'assert' || kind === 'preg_replace' || INCLUDES.has(kind)) {
      // deyim olarak kullanılan eval (@eval(...) dahil): kod olduğu gibi yerine konur
      const stmt = parent?.kind === 'expressionstatement' ? parent : parent?.kind === 'silent' && grand?.kind === 'expressionstatement' ? grand : null;
      if (stmt && ret < 0) {
        const [start, end] = span(stmt);
        const tail = endsInPhpMode(payload) ? '' : '<?php ';
        return { start, end, text: `\n${payload.trim()}\n${tail}` };
      }
      // deyim olarak eval, kodun son deyimi "return X;" (değer atılıyor): kod return'süz, X yan etkisizse hiç yazılmaz
      const last = payloadAst.children.length - 1;
      if (stmt && kind !== 'preg_replace' && !INCLUDES.has(kind) && last > 0 && ret === last) {
        const r = payloadAst.children[last];
        const [rs, re] = span(r);
        const shiftP = EVAL_PREFIX.length;
        const before = payload.slice(0, rs - shiftP);
        const x = r.expr ? (EVAL_PREFIX + payload).slice(...span(r.expr)) : '';
        const keep = r.expr && !['number', 'string', 'boolean', 'nullkeyword', 'variable'].includes(r.expr.kind) ? `\n${x};` : '';
        if (endsInPhpMode(before) && payload.slice(re - shiftP).trim() === '') {
          const [start, end] = span(stmt);
          return { start, end, text: `\n${before.trim()}${keep}\n` };
        }
      }
      // eval(eval(X)); iç kod değer döndürmüyorsa dıştaki eval(null) boş koddur: deyim X'in kodu olur
      if (kind === 'eval' && parent?.kind === 'eval' && grand?.kind === 'expressionstatement' && ret < 0) {
        const [start, end] = span(grand);
        const tail = endsInPhpMode(payload) ? '' : '<?php ';
        return { start, end, text: `\n${payload.trim()}\n${tail}` };
      }
      // $x = eval(P); P değer döndürmüyorsa eval null verir: "P; $x = null;"
      if (kind === 'eval' && ret < 0 && parent?.kind === 'assign' && parent.operator === '=' && parent.right === node &&
        grand?.kind === 'expressionstatement' && endsInPhpMode(payload)) {
        const [start, end] = span(grand);
        return { start, end, text: `\n${payload.trim()}\n${full.slice(...span(parent.left))} = null;` };
      }
      // değeri kullanılan eval: kod tek bir "return X;" ise ifade X olur
      if (!INCLUDES.has(kind) && kind !== 'preg_replace' && ret === 0 && payloadAst.children.length === 1 && payloadAst.children[0].expr) {
        const r = payloadAst.children[0].expr;
        const [s, e] = span(r);
        const expr = (EVAL_PREFIX + payload).slice(s, e);
        const [start, end] = span(node);
        return { start, end, text: `(${expr})` };
      }
      return null;
    }
    if (kind === 'create_function') {
      // create_function('$a, $b', 'gövde') → function ($a, $b) { gövde }
      const args = node.arguments;
      if (args?.length !== 2 || args[0].kind !== 'string') return null;
      const [start, end] = span(node);
      return { start, end, text: `function (${args[0].value}) {\n${payload}\n}` };
    }
    return null;
  }

  const out = expand(code, 'f.', true, 0);
  return { code: out, opened: stats.opened, kept: stats.kept };
}
