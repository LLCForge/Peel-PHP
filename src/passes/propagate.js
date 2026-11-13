// Sabit yayılımı ve doğrudan çağrılar:
// - kapsamında tek kez, deyim düzeyinde sabit atanan ve başka hiç değişmeyen değişkenin okumaları değeriyle değişir
//   ($f = 'base64_decode'; ... $f($x)  →  'base64_decode'($x))
// - dizge adıyla çağrılar doğrudan çağrı olur: 'ad'(...), call_user_func('ad', ...), call_user_func_array('ad', [...])
// - $GLOBALS['ad'] ve ${'ad'} → $ad (yalnızca adı sabit ve geçerli tanımlayıcıysa)
import { tryParse, walk, span, applyEdits } from '../core/parse.js';
import { analyze } from '../core/scope.js';

export const id = 'propagate';

const LITERAL = new Set(['string', 'number', 'boolean', 'nullkeyword']);
const IDENT = /^[a-zA-Z_\x80-\xff][a-zA-Z0-9_\x80-\xff]*$/;
const FUNC_NAME = /^\\?[a-zA-Z_\x80-\xff][a-zA-Z0-9_\x80-\xff]*(\\[a-zA-Z_\x80-\xff][a-zA-Z0-9_\x80-\xff]*)*$/;
// dil yapıları dizgeyle çağrılamaz ('echo'(...) geçersiz); bunlara dönüştürme yapılmaz
const NOT_CALLABLE = new Set(['echo', 'print', 'eval', 'include', 'include_once', 'require', 'require_once', 'isset', 'unset', 'empty', 'exit', 'die', 'list', 'array']);

function parentsOf(ast) {
  const parents = new Map();
  walk(ast, (n, p, key) => { parents.set(n, [p, key]); });
  return parents;
}

const scopeBody = (scope) => (scope.kind === 'program' ? scope.node.children : scope.node.body?.children);

export async function run(code, ctx) {
  const parsed = tryParse(code);
  if (!parsed) return code;
  const { ast } = parsed;
  const parents = parentsOf(ast);
  const info = analyze(ast);
  const edits = [];
  let props = 0;
  let calls = 0;

  // 1) sabit yayılımı
  for (const scope of info.scopes) {
    if (scope.dynamic) continue;
    const body = scopeBody(scope);
    if (!body) continue;
    for (const [name, uses] of scope.vars) {
      // tüm okumalardan sonra gelen unset() değeri etkilemez (encoder'lar sonda değişkenlerini siler)
      const lastRead = Math.max(-1, ...uses.filter((u) => u.mode === 'read').map((u) => u.node.loc?.start.offset ?? Infinity));
      const writes = uses.filter((u) => u.mode !== 'read' && !(u.mode === 'unset' && u.node.loc.start.offset > lastRead));
      if (writes.length !== 1 || writes[0].mode !== 'write') continue;
      const w = writes[0];
      const assign = w.parent;
      if (assign?.kind !== 'assign' || assign.operator !== '=' || assign.left !== w.node || !LITERAL.has(assign.right.kind)) continue;
      // atama, kapsam gövdesinde doğrudan bir deyim olmalı (döngü/koşul içinde değil)
      const [stmt] = parents.get(assign) ?? [];
      if (stmt?.kind !== 'expressionstatement' || !body.includes(stmt)) continue;
      // program kapsamında global $x kullanan fonksiyon ya da include varsa dokunulmaz
      if (scope.kind === 'program' && info.scopes.some((s) => s.globals.has(name))) continue;
      const end = assign.loc.end.offset;
      const reads = uses.filter((u) => u.mode === 'read');
      if (!reads.length || reads.some((u) => u.node.loc.start.offset < end)) continue;
      const value = code.slice(...span(assign.right));
      const isFn = assign.right.kind === 'string' && FUNC_NAME.test(assign.right.value) && !NOT_CALLABLE.has(String(assign.right.value).toLowerCase());
      for (const r of reads) {
        const [p, key] = parents.get(r.node) ?? [];
        // dizge içi değişken ("$x"), isset/empty, closure use() ve global/static yalnızca değişken kabul eder
        if (!p || ['encapsedpart', 'encapsed', 'isset', 'empty', 'closure', 'global', 'static'].includes(p.kind)) continue;
        // $f(...) → ad(...) (PHP 5'te 'ad'(...) geçersiz)
        const text = p.kind === 'call' && key === 'what' ? (isFn ? assign.right.value : null) : value;
        if (text === null) continue;
        edits.push({ start: r.node.loc.start.offset, end: r.node.loc.end.offset, text });
        props++;
      }
    }
  }

  // 2) doğrudan çağrılar ve sabit adlı değişkenler
  walk(ast, (n) => {
    if (n.kind === 'call') {
      const what = n.what;
      const fname = what?.kind === 'name' ? String(what.name).replace(/^\\/, '').toLowerCase() : null;
      // 'ad'(...) → ad(...)
      if (what?.kind === 'string' && FUNC_NAME.test(what.value) && !NOT_CALLABLE.has(what.value.toLowerCase())) {
        edits.push({ start: what.loc.start.offset, end: what.loc.end.offset, text: what.value });
        calls++;
        return;
      }
      // call_user_func('ad', a, b) → ad(a, b)
      if (fname === 'call_user_func' && n.arguments[0]?.kind === 'string' && FUNC_NAME.test(n.arguments[0].value) && !NOT_CALLABLE.has(n.arguments[0].value.toLowerCase()) && !n.arguments.some((a) => a.kind === 'variadic')) {
        const rest = n.arguments.slice(1).map((a) => code.slice(...span(a)));
        edits.push({ start: n.loc.start.offset, end: n.loc.end.offset, text: `${n.arguments[0].value}(${rest.join(', ')})` });
        calls++;
        return false;
      }
      // call_user_func_array('ad', [a, b]) → ad(a, b)
      const arr = n.arguments[1];
      if (fname === 'call_user_func_array' && n.arguments.length === 2 && n.arguments[0]?.kind === 'string' && FUNC_NAME.test(n.arguments[0].value) && !NOT_CALLABLE.has(n.arguments[0].value.toLowerCase()) &&
        arr?.kind === 'array' && arr.items.every((e) => e?.kind === 'entry' && !e.key && !e.byRef && !e.unpack)) {
        const rest = arr.items.map((e) => code.slice(...span(e.value)));
        edits.push({ start: n.loc.start.offset, end: n.loc.end.offset, text: `${n.arguments[0].value}(${rest.join(', ')})` });
        calls++;
        return false;
      }
    }
    // ${'ad'} → $ad
    if (n.kind === 'variable' && n.name?.kind === 'string' && IDENT.test(n.name.value) && n.name.value !== 'this') {
      edits.push({ start: n.loc.start.offset, end: n.loc.end.offset, text: `$${n.name.value}` });
      calls++;
      return false;
    }
    // $GLOBALS['ad'] → $ad yalnızca program kapsamında anlamı aynıdır; fonksiyon içinde dokunulmaz
    return true;
  });

  if (!edits.length) return code;
  const r = applyEdits(code, edits);
  if (props) ctx.log(`propagate: ${props} sabit değişken okuması değeriyle değişti`, 'info');
  if (calls) ctx.log(`propagate: ${calls} dolaylı çağrı/ad doğrudan yazıldı`, 'info');
  ctx.bump('propagate', props);
  ctx.bump('directCalls', calls);
  return r.code;
}
