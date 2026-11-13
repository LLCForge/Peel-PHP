// Sabit katlama: argümanları sabit olan saf fonksiyon çağrıları ve sabit işlemler sandbox'taki gerçek PHP ile
// hesaplanıp literal olarak yazılır (base64_decode('...'), str_rot13(...), 'a'.'b', chr(101), "\x65\x76"...).
// Saf kullanıcı fonksiyonları (encoder'ların açıcıları: uhex('666f70656e')) da tanımlarıyla birlikte hesaplanır.
import { tryParse, walk, span, applyEdits } from '../core/parse.js';
import { PURE_FUNCTIONS, PREG_E } from '../core/pure.js';
import { unserialize, phpLiteral } from '../core/values.js';
import { fromBase64 } from '../core/bstr.js';

export const id = 'fold';
export const needsSandbox = true;

const BATCH = 400;
const MAX_LITERAL = 2_000_000;
const OPS = new Set(['.', '+', '-', '*', '/', '%', '**', '^', '|', '&', '<<', '>>', '==', '===', '!=', '!==', '<>', '<', '>', '<=', '>=', '&&', '||', 'and', 'or', 'xor', '??', '<=>']);
const NONE = new Set();
// saf kullanıcı fonksiyonunun gövdesinde izin verilen düğümler (çıktı, global durum, nesne, dosya, include yok)
const BODY_OK = new Set(['block', 'expressionstatement', 'return', 'for', 'foreach', 'while', 'do', 'if', 'switch', 'case', 'break',
  'continue', 'assign', 'variable', 'string', 'number', 'boolean', 'nullkeyword', 'nowdoc', 'bin', 'unary', 'cast', 'retif',
  'offsetlookup', 'array', 'entry', 'encapsed', 'encapsedpart', 'post', 'pre', 'call', 'name', 'isset', 'empty', 'noop', 'unset',
  'list', 'magic', 'identifier', 'parameter', 'typereference', 'nullabletype']);
const BAD_VARS = new Set(['this', 'GLOBALS', '_GET', '_POST', '_COOKIE', '_REQUEST', '_SERVER', '_FILES', '_ENV', '_SESSION']);

const callName = (n) => (n.kind === 'call' && n.what?.kind === 'name' ? String(n.what.name).replace(/^\\/, '').toLowerCase() : null);

/**
 * Saf kullanıcı fonksiyonları: üst düzeyde tek tanım, referans parametre/dönüş yok; gövde yalnızca yerel değişkenler,
 * döngüler, saf yerleşikler ve diğer saf kullanıcı fonksiyonlarını kullanıyor. → Map(küçük harf ad → düğüm)
 */
export function pureUserFunctions(ast) {
  const all = new Map();
  const dup = new Set();
  for (const c of ast.children) {
    if (c.kind !== 'function' || !c.name) continue;
    const name = String(c.name.name ?? c.name).toLowerCase();
    if (all.has(name)) dup.add(name);
    all.set(name, c);
  }
  dup.forEach((d) => all.delete(d));
  const callsOf = new Map();
  for (const [name, fn] of [...all]) {
    let ok = !fn.byref && !(fn.arguments ?? []).some((a) => a.byref || a.variadic);
    const calls = new Set();
    walk(fn.body, (n) => {
      if (!ok) return false;
      if (!BODY_OK.has(n.kind)) { ok = false; return false; }
      if (n.kind === 'variable' && (typeof n.name !== 'string' || BAD_VARS.has(n.name))) ok = false;
      if (n.kind === 'assign' && n.right?.byref) ok = false;
      if (n.kind === 'call') {
        const c = callName(n);
        if (!c) ok = false;
        else if (!PURE_FUNCTIONS.has(c)) calls.add(c);
        else if (c === 'preg_replace' && (n.arguments[0]?.kind !== 'string' || PREG_E.test(n.arguments[0].value))) ok = false;
      }
      return ok;
    });
    if (ok) callsOf.set(name, calls); else all.delete(name);
  }
  // saf olmayan bir fonksiyonu çağıranlar elenir (sabit noktaya kadar)
  for (let changed = true; changed;) {
    changed = false;
    for (const [name, calls] of callsOf) {
      if ([...calls].every((c) => callsOf.has(c))) continue;
      callsOf.delete(name);
      all.delete(name);
      changed = true;
    }
  }
  return all;
}

// sabit: yalnızca literaller, saf çağrılar ve işleçlerden oluşan ifade
function isConst(n, user = NONE) {
  if (!n) return false;
  switch (n.kind) {
    case 'string': case 'number': case 'boolean': case 'nullkeyword': case 'nowdoc': return true;
    case 'array': return n.items.every((e) => e && e.kind === 'entry' && !e.byRef && !e.unpack && (!e.key || isConst(e.key, user)) && isConst(e.value, user));
    case 'bin': return OPS.has(n.type) && isConst(n.left, user) && isConst(n.right, user);
    case 'unary': return ['!', '-', '+', '~'].includes(n.type) && isConst(n.what, user);
    case 'cast': return ['string', 'int', 'float', 'bool'].includes(n.type) && isConst(n.expr, user);
    case 'retif': return isConst(n.test, user) && (!n.trueExpr || isConst(n.trueExpr, user)) && isConst(n.falseExpr, user);
    case 'parenthesis': return isConst(n.inner, user);
    case 'call': {
      const name = callName(n);
      if (!name || !(PURE_FUNCTIONS.has(name) || user.has(name))) return false;
      if (n.arguments.some((a) => a.kind === 'variadic' || !isConst(a, user))) return false;
      if (name === 'preg_replace' && (n.arguments[0]?.kind !== 'string' || PREG_E.test(n.arguments[0].value))) return false;
      return true;
    }
    default: return false;
  }
}

// zaten okunur literal mi? (kaçışlı çift tırnak ve hex/sekizli sayılar okunur hâle getirilir)
function isPlain(n) {
  if (n.kind === 'boolean' || n.kind === 'nullkeyword') return true;
  if (n.kind === 'number') return /^-?\d+(\.\d+)?$/.test(String(n.value));
  if (n.kind === 'string') return !n.isDoubleQuote || !/\\/.test(n.raw ?? '');
  // -1: phpLiteral "(-1)" yazar, ayrıştırıcı parantezi düğüme katmaz → her turda yeniden sarılırdı
  if (n.kind === 'unary' && n.type === '-' && n.what?.kind === 'number') return isPlain(n.what);
  return false;
}

export async function run(code, ctx) {
  const parsed = tryParse(code);
  if (!parsed) return code;
  // yalnızca açıcı gibi kullanılan kullanıcı fonksiyonları: en az 3 çağrı ve hepsi sabit argümanlı
  // (programın kendi fonksiyonları — shout('peel') — tek tük sabitle çağrıldığında katlanıp kaybolmasın)
  const user = pureUserFunctions(parsed.ast);
  const userCalls = new Map();
  walk(parsed.ast, (n) => { const c = callName(n); if (c && user.has(c)) { if (!userCalls.has(c)) userCalls.set(c, []); userCalls.get(c).push(n); } return true; });
  for (const name of [...user.keys()]) {
    const calls = userCalls.get(name) ?? [];
    if (calls.length < 3 || !calls.every((c) => c.arguments.length && c.arguments.every((a) => isConst(a)))) user.delete(name);
  }
  const userNames = new Set(user.keys());
  const targets = [];
  walk(parsed.ast, (n, parent, key) => {
    if (!isConst(n, userNames)) return true;
    // atama hedefi, static/const başlatıcıları, varsayılan parametre değerleri yerinde bırakılır (sabit ifade kuralları)
    if ((key === 'left' && parent?.kind === 'assign') || parent?.kind === 'staticvariable' || parent?.kind === 'constant' || parent?.kind === 'parameter') return false;
    if (n.kind === 'array' && n.items.every((e) => isPlain(e.value) && (!e.key || isPlain(e.key)))) return false;
    if (!isPlain(n) && n.kind !== 'array') targets.push(n);
    return n.kind === 'array';
  });
  if (!targets.length) return code;
  const usesUser = (n) => { let u = false; walk(n, (x) => { if (userNames.has(callName(x) ?? '')) u = true; return !u; }); return u; };
  const edits = [];
  for (let i = 0; i < targets.length; i += BATCH) {
    const chunk = targets.slice(i, i + BATCH);
    // kullanıcı fonksiyonu çağrısı varsa tanımlar da gönderilir
    const defs = userNames.size && chunk.some(usesUser) ? [...user.values()].map((f) => code.slice(...span(f))).join('\n') : '';
    const results = await ctx.evaluate(chunk.map((n) => code.slice(...span(n))), defs);
    if (!results) continue;
    chunk.forEach((n, k) => {
      const [ok, b64] = results[k] ?? [];
      if (!ok) return;
      const value = unserialize(fromBase64(b64));
      if (value === undefined) return;
      const lit = phpLiteral(value, { shortArray: ctx.version !== '5.2' });
      if (lit === null || lit.length > MAX_LITERAL) return;
      const [start, end] = span(n);
      if (code.slice(start, end) !== lit) edits.push({ start, end, text: lit });
    });
  }
  if (!edits.length) return code;
  const r = applyEdits(code, edits);
  ctx.log(`fold: ${r.applied} sabit ifade hesaplandı`, 'info');
  ctx.bump('fold', r.applied);
  return r.code;
}
