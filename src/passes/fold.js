// Sabit katlama: argümanları sabit olan saf fonksiyon çağrıları ve sabit işlemler sandbox'taki gerçek PHP ile
// hesaplanıp literal olarak yazılır (base64_decode('...'), str_rot13(...), 'a'.'b', chr(101), "\x65\x76"...).
import { tryParse, walk, span, applyEdits } from '../core/parse.js';
import { PURE_FUNCTIONS, PREG_E } from '../core/pure.js';
import { unserialize, phpLiteral } from '../core/values.js';
import { fromBase64 } from '../core/bstr.js';

export const id = 'fold';
export const needsSandbox = true;

const BATCH = 400;
const MAX_LITERAL = 2_000_000;
const OPS = new Set(['.', '+', '-', '*', '/', '%', '**', '^', '|', '&', '<<', '>>', '==', '===', '!=', '!==', '<>', '<', '>', '<=', '>=', '&&', '||', 'and', 'or', 'xor', '??', '<=>']);
const LITERALS = new Set(['string', 'number', 'boolean', 'nullkeyword']);

const callName = (n) => (n.kind === 'call' && n.what?.kind === 'name' ? String(n.what.name).replace(/^\\/, '').toLowerCase() : null);

// sabit: yalnızca literaller, saf çağrılar ve işleçlerden oluşan ifade
function isConst(n) {
  if (!n) return false;
  switch (n.kind) {
    case 'string': case 'number': case 'boolean': case 'nullkeyword': case 'nowdoc': return true;
    case 'array': return n.items.every((e) => e && e.kind === 'entry' && !e.byRef && !e.unpack && (!e.key || isConst(e.key)) && isConst(e.value));
    case 'bin': return OPS.has(n.type) && isConst(n.left) && isConst(n.right);
    case 'unary': return ['!', '-', '+', '~'].includes(n.type) && isConst(n.what);
    case 'cast': return ['string', 'int', 'float', 'bool'].includes(n.type) && isConst(n.expr);
    case 'retif': return isConst(n.test) && (!n.trueExpr || isConst(n.trueExpr)) && isConst(n.falseExpr);
    case 'parenthesis': return isConst(n.inner);
    case 'call': {
      const name = callName(n);
      if (!name || !PURE_FUNCTIONS.has(name)) return false;
      if (n.arguments.some((a) => a.kind === 'variadic' || !isConst(a))) return false;
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
  return false;
}

export async function run(code, ctx) {
  const parsed = tryParse(code);
  if (!parsed) return code;
  const targets = [];
  walk(parsed.ast, (n, parent, key) => {
    if (!isConst(n)) return true;
    // atama hedefi, static/const başlatıcıları, varsayılan parametre değerleri yerinde bırakılır (sabit ifade kuralları)
    if ((key === 'left' && parent?.kind === 'assign') || parent?.kind === 'staticvariable' || parent?.kind === 'constant' || parent?.kind === 'parameter') return false;
    if (n.kind === 'array' && n.items.every((e) => isPlain(e.value) && (!e.key || isPlain(e.key)))) return false;
    if (!isPlain(n) && n.kind !== 'array') targets.push(n);
    return n.kind === 'array';
  });
  if (!targets.length) return code;
  const edits = [];
  for (let i = 0; i < targets.length; i += BATCH) {
    const chunk = targets.slice(i, i + BATCH);
    const results = await ctx.evaluate(chunk.map((n) => code.slice(...span(n))));
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
