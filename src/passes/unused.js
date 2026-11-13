// Kullanılmayan kod (canlılık analizi). Açılan katmanlardan sonra encoder'ın açıcı kodu birbirini besleyen
// değişken zincirleri ve döngüler olarak kalır: $d = gzuncompress(...); for (...) { $o .= chr(... $d ...); }
// Kapsam başına sabit noktaya kadar: dışarıdan okunan değişkenler canlıdır; canlı bir değişkene yazan aday deyim
// canlıdır ve okuduklarını canlı yapar. Kalan aday deyimler (saf atama, artırma, unset, yalnızca bunları içeren
// döngüler) silinir. Ayrıca: çağrılmayan fonksiyonlar, kullanılmayan define(), okunmayan __halt_compiler verisi.
import { tryParse, walk, span, applyEdits } from '../core/parse.js';
import { analyze } from '../core/scope.js';
import { PURE_FUNCTIONS } from '../core/pure.js';

export const id = 'unused';

const REF_ARG = new Set(['preg_match_all', 'similar_text']);
const SELF_READ = new Set(['file_get_contents', 'file', 'filesize', 'md5_file', 'sha1_file', 'hash_file']);
const FUNC_KINDS = new Set(['function', 'closure', 'arrowfunc', 'method', 'class', 'interface', 'trait']);

const isSelfFile = (n) => n?.kind === 'magic' && /^__(FILE|DIR)__$/i.test(n.raw);

// yan etkisiz ifade mi? (yazdığı/okuduğu değişkenler ayrıca toplanır)
export function pure(n) {
  if (!n) return true;
  switch (n.kind) {
    case 'string': case 'number': case 'boolean': case 'nullkeyword': case 'nowdoc': case 'magic': return true;
    case 'name': return true; // sabit okuma (OPENSSL_RAW_DATA)
    case 'variable': return typeof n.name === 'string';
    case 'offsetlookup': return pure(n.what) && (!n.offset || pure(n.offset));
    case 'encapsed': return n.value.every((p) => pure(p.expression ?? p));
    case 'encapsedpart': return pure(n.expression);
    case 'bin': return pure(n.left) && pure(n.right);
    case 'unary': return pure(n.what);
    case 'cast': return !['object', 'unset'].includes(n.type) && pure(n.expr);
    case 'retif': return pure(n.test) && pure(n.trueExpr) && pure(n.falseExpr);
    case 'parenthesis': return pure(n.inner);
    case 'array': return n.items.every((e) => !e || (e.kind === 'entry' && !e.byRef && pure(e.key) && pure(e.value)));
    case 'isset': case 'empty': return true;
    case 'call': {
      if (n.what?.kind !== 'name') return false;
      const name = String(n.what.name).replace(/^\\/, '').toLowerCase();
      if (REF_ARG.has(name)) return false;
      if (SELF_READ.has(name)) return n.arguments.length >= 1 && isSelfFile(n.arguments[0]) && n.arguments.slice(1).every(pure);
      return PURE_FUNCTIONS.has(name) && n.arguments.every((a) => a.kind !== 'variadic' && pure(a));
    }
    default: return false;
  }
}

export function varsIn(n, out = new Set()) {
  walk(n, (x) => {
    if (FUNC_KINDS.has(x.kind) && x !== n) return false;
    if (x.kind === 'variable' && typeof x.name === 'string') out.add(x.name);
    return true;
  });
  return out;
}

// aday deyim: { writes, reads } ya da null
function candidate(s) {
  if (!s) return null;
  if (s.kind === 'expressionstatement') {
    const e = s.expression;
    if (e.kind === 'assign' && e.left.kind === 'variable' && typeof e.left.name === 'string' && !e.right?.byref && pure(e.right)) {
      const reads = varsIn(e.right);
      if (e.operator !== '=') reads.add(e.left.name);
      return { writes: new Set([e.left.name]), reads };
    }
    if ((e.kind === 'post' || e.kind === 'pre') && e.what.kind === 'variable' && typeof e.what.name === 'string') {
      return { writes: new Set([e.what.name]), reads: new Set([e.what.name]) };
    }
    // preg_match(desen, metin, $m): tek etkisi $m'ye yazmak
    const fname = e.kind === 'call' && e.what?.kind === 'name' ? String(e.what.name).replace(/^\\/, '').toLowerCase() : null;
    if ((fname === 'preg_match' || fname === 'preg_match_all') && e.arguments.length >= 3 && e.arguments.length <= 5 &&
      e.arguments[2].kind === 'variable' && typeof e.arguments[2].name === 'string' && pure(e.arguments[0]) && pure(e.arguments[1]) && e.arguments.slice(3).every(pure)) {
      const reads = new Set();
      [e.arguments[0], e.arguments[1], ...e.arguments.slice(3)].forEach((a) => varsIn(a, reads));
      return { writes: new Set([e.arguments[2].name]), reads };
    }
    return null;
  }
  if (s.kind === 'unset' && s.variables.every((v) => v.kind === 'variable' && typeof v.name === 'string')) {
    return { writes: new Set(s.variables.map((v) => v.name)), reads: new Set() };
  }
  if (s.kind === 'for' || s.kind === 'while' || s.kind === 'do') {
    // bitmeyebilecek döngü silinmez (silmek programın anlamını değiştirir): koşulsuz for(;;), sabit doğru koşul
    const tests = s.kind === 'for' ? s.test : [s.test];
    if (!tests.length || tests.some((t) => ['boolean', 'number', 'string'].includes(t.kind) && t.value && t.value !== '0')) return null;
    const parts = s.kind === 'for' ? [...s.init, ...s.test, ...s.increment] : [s.test];
    const writes = new Set();
    const reads = new Set();
    for (const p of parts) {
      if (p.kind === 'assign' && p.left.kind === 'variable' && typeof p.left.name === 'string' && pure(p.right)) { writes.add(p.left.name); varsIn(p.right, reads); continue; }
      if ((p.kind === 'post' || p.kind === 'pre') && p.what.kind === 'variable') { writes.add(p.what.name); reads.add(p.what.name); continue; }
      if (!pure(p)) return null;
      varsIn(p, reads);
    }
    const body = s.body?.kind === 'block' ? s.body.children : s.body ? [s.body] : [];
    for (const b of body) {
      const c = candidate(b);
      if (!c) return null;
      c.writes.forEach((w) => writes.add(w));
      c.reads.forEach((r) => reads.add(r));
    }
    // hiçbir değişkene yazmayan döngü ilerleyemez: bitmeyebilir, silinmez
    if (!writes.size) return null;
    return { writes, reads };
  }
  return null;
}

export async function run(code, ctx) {
  const parsed = tryParse(code);
  if (!parsed) return code;
  const { ast } = parsed;
  const info = analyze(ast);
  const edits = [];
  let removedStmts = 0;

  for (const scope of info.scopes) {
    if (scope.dynamic || (scope.kind === 'program' && info.globalDynamic)) continue;
    // kapsamın deyim listelerindeki adaylar (iç fonksiyonlara inilmez; döngü bütün olarak aday)
    const cands = [];
    const root = scope.kind === 'program' ? ast : scope.node.body;
    if (!root) continue;
    walk(root, (n) => {
      if (n !== root && FUNC_KINDS.has(n.kind)) return false;
      const list = n.kind === 'program' || n.kind === 'block' ? n.children : null;
      if (!list) return true;
      for (const s of list) {
        const c = candidate(s);
        if (c) cands.push({ s, ...c, start: s.loc.start.offset, end: s.loc.end.offset });
      }
      return true;
    });
    if (!cands.length) continue;
    const inCand = (off) => cands.some((c) => off >= c.start && off < c.end);
    // aday dışındaki her kullanım (okuma, referans, belki-yazma) değişkeni canlı yapar
    const live = new Set();
    for (const [name, uses] of scope.vars) {
      if (scope.kind === 'program' && info.scopes.some((s) => s.globals.has(name))) { live.add(name); continue; }
      // aday deyimin kendi içindeki kullanımlar (preg_match'in $m'ye yazması dahil) canlılığı adaya bırakır
      if (uses.some((u) => u.mode !== 'write' && u.mode !== 'unset' && !(u.node.loc && inCand(u.node.loc.start.offset)))) live.add(name);
      // referans (&) bağlanan değişken başka bir adla okunabilir: her zaman canlı
      if (uses.some((u) => u.mode === 'ref')) live.add(name);
    }
    const alive = new Set();
    let grew = true;
    while (grew) {
      grew = false;
      for (const c of cands) {
        if (alive.has(c)) continue;
        if ([...c.writes].some((w) => live.has(w))) {
          alive.add(c);
          c.reads.forEach((r) => { if (!live.has(r)) { live.add(r); grew = true; } });
          grew = true;
        }
      }
    }
    for (const c of cands) {
      if (alive.has(c)) continue;
      // iç içe adaylardan yalnızca en dıştaki silinir
      if (cands.some((o) => o !== c && !alive.has(o) && o.start <= c.start && o.end >= c.end && (o.start !== c.start || o.end !== c.end))) continue;
      edits.push({ start: c.start, end: c.end, text: '' });
      removedStmts++;
    }
  }

  // dinamik çağrı (değişkenle/ifadeyle çağrı) kalmadıysa çağrılmayan fonksiyonlar silinir
  let dynamicCalls = false;
  walk(ast, (n) => {
    if (n.kind === 'call' && n.what?.kind !== 'name') dynamicCalls = true;
    if (n.kind === 'new' && n.what?.kind !== 'name') dynamicCalls = true;
    return true;
  });
  let removedFns = 0;
  if (!dynamicCalls && !info.dynamicCallback) {
    for (const [name, decls] of info.functions) {
      if (info.calls.has(name) || info.strings.has(name)) continue;
      for (const d of decls) {
        edits.push({ start: d.loc.start.offset, end: d.loc.end.offset, text: '' });
        removedFns++;
      }
    }
  }

  // kullanılmayan define('AD', saf)
  const constRefs = new Set();
  walk(ast, (n, parent, key) => {
    if (n.kind === 'name' && !(parent?.kind === 'call' && key === 'what') && parent?.kind !== 'new') constRefs.add(String(n.name).replace(/^\\/, ''));
    return true;
  });
  let removedDefs = 0;
  for (const s of ast.children) {
    const e = s.kind === 'expressionstatement' ? s.expression : null;
    if (e?.kind !== 'call' || String(e.what?.name).toLowerCase() !== 'define' || e.arguments[0]?.kind !== 'string') continue;
    const cname = e.arguments[0].value;
    // adıyla kullanılan ya da bir dizgede geçen (constant('AD'), defined('AD')) sabit kalır
    if (constRefs.has(cname) || info.strings.has(String(cname).toLowerCase()) || !e.arguments.slice(1).every(pure)) continue;
    edits.push({ start: s.loc.start.offset, end: s.loc.end.offset, text: '' });
    removedDefs++;
  }

  // __halt_compiler sonrası veri: kod artık kendi dosyasını okumuyorsa silinir
  const halt = ast.children.find((c) => c.kind === 'halt');
  let removedHalt = 0;
  if (halt) {
    let reads = false;
    walk(ast, (n) => {
      if (isSelfFile(n) || (n.kind === 'name' && /__COMPILER_HALT_OFFSET__/i.test(n.name))) reads = true;
      return !reads;
    });
    if (!reads) { edits.push({ start: halt.loc.start.offset, end: code.length, text: '' }); removedHalt = 1; }
  }

  if (!edits.length) return code;
  const r = applyEdits(code, edits);
  const parts = [removedStmts && `${removedStmts} ölü deyim`, removedFns && `${removedFns} çağrılmayan fonksiyon`, removedDefs && `${removedDefs} kullanılmayan define`, removedHalt && '__halt_compiler verisi'].filter(Boolean);
  ctx.log(`unused: ${parts.join(', ')} kaldırıldı`, 'info');
  ctx.bump('unused', r.applied);
  return r.code;
}
