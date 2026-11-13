// Ölü kod: koşulu sabit olan if / ?: / while dalları, if (!function_exists('f')) { function f ... } sarmalayıcıları.
// Koşul yalnızca literal ya da literal işlemiyse karar verilir; bilinmeyen hiçbir şey değerlendirilmez.
import { tryParse, walk, span, applyEdits, innerText } from '../core/parse.js';
import { analyze } from '../core/scope.js';

export const id = 'dead';

// PHP doğruluk değeri; belirlenemezse undefined
function truth(n) {
  if (!n) return undefined;
  switch (n.kind) {
    case 'boolean': return Boolean(n.value);
    case 'nullkeyword': return false;
    case 'number': { const v = Number(String(n.value).replace(/_/g, '')); return Number.isNaN(v) ? undefined : v !== 0; }
    case 'string': return !(n.value === '' || n.value === '0');
    case 'parenthesis': return truth(n.inner);
    case 'unary': if (n.type === '!') { const t = truth(n.what); return t === undefined ? undefined : !t; } return undefined;
    case 'bin': {
      const l = truth(n.left);
      const r = truth(n.right);
      if (n.type === '||' || n.type === 'or') return l === true || r === true ? true : l === false && r === false ? false : undefined;
      if (n.type === '&&' || n.type === 'and') return l === false || r === false ? false : l === true && r === true ? true : undefined;
      return undefined;
    }
    default: return undefined;
  }
}


export async function run(code, ctx) {
  const parsed = tryParse(code);
  if (!parsed) return code;
  const info = analyze(parsed.ast);
  const edits = [];
  walk(parsed.ast, (n) => {
    if (n.kind === 'if') {
      const t = truth(n.test);
      // if (!function_exists('f')) { function f() {...} } → f başka yerde tanımlı değilse koşulsuz
      if (t === undefined && n.test.kind === 'unary' && n.test.type === '!' && n.test.what?.kind === 'call' &&
        String(n.test.what.what?.name).toLowerCase() === 'function_exists' && n.test.what.arguments[0]?.kind === 'string' && !n.alternate) {
        const fname = String(n.test.what.arguments[0].value).toLowerCase();
        const decls = info.functions.get(fname) ?? [];
        const body = n.body?.kind === 'block' ? n.body.children : [n.body];
        if (decls.length === 1 && body.length === 1 && body[0] === decls[0]) {
          edits.push({ start: n.loc.start.offset, end: n.loc.end.offset, text: code.slice(...span(decls[0])) });
          return false;
        }
      }
      if (t === undefined) return true;
      const branch = t ? n.body : n.alternate;
      // elseif zinciri: alternate bir if düğümüdür, olduğu gibi yazılır
      edits.push({ start: n.loc.start.offset, end: n.loc.end.offset, text: branch ? (branch.kind === 'if' ? code.slice(...span(branch)) : innerText(code, branch)) : '' });
      return false;
    }
    if (n.kind === 'retif') {
      const t = truth(n.test);
      if (t === undefined) return true;
      const pick = t ? (n.trueExpr ?? n.test) : n.falseExpr;
      edits.push({ start: n.loc.start.offset, end: n.loc.end.offset, text: `(${code.slice(...span(pick))})` });
      return false;
    }
    if (n.kind === 'while' && truth(n.test) === false) {
      edits.push({ start: n.loc.start.offset, end: n.loc.end.offset, text: '' });
      return false;
    }
    return true;
  });
  if (!edits.length) return code;
  const r = applyEdits(code, edits);
  ctx.log(`dead: ${r.applied} sabit koşullu dal sadeleştirildi`, 'info');
  ctx.bump('dead', r.applied);
  return r.code;
}
