// Tek kullanımlık fonksiyonu yerine koyma: encoder'lar çözülen kodu bir fonksiyona koyup bir kez çağırır
// (PHPkoru: run_code($decrypted)). Koşullar: üst düzeyde tek tanım, program kapsamında deyim olarak tek doğrudan
// çağrı, başka başvuru yok; gövdede return/global/static/func_get_args yok; gövde değişkenleri program
// kapsamında kullanılmıyor. Parametreler "$p = argüman;" olarak yazılır (kullanılmıyorsa unused pass'i siler).
import { tryParse, walk, span, applyEdits, innerText } from '../core/parse.js';
import { analyze } from '../core/scope.js';

export const id = 'inline';

const BAD_CALLS = new Set(['func_get_args', 'func_get_arg', 'func_num_args', 'debug_backtrace', 'get_defined_vars', 'compact', 'extract']);

export async function run(code, ctx) {
  const parsed = tryParse(code);
  if (!parsed) return code;
  const { ast } = parsed;
  const info = analyze(ast);
  const edits = [];
  for (const [name, decls] of info.functions) {
    if (decls.length !== 1 || info.strings.has(name)) continue;
    const fn = decls[0];
    if (!ast.children.includes(fn) || fn.byref) continue;
    const callsTo = info.calls.get(name) ?? [];
    if (callsTo.length !== 1) continue;
    const call = callsTo[0];
    const stmt = ast.children.find((s) => s.kind === 'expressionstatement' && s.expression === call);
    if (!stmt || call.arguments.some((a) => a.kind === 'variadic')) continue;
    let ok = true;
    walk(fn.body, (n) => {
      if (n !== fn.body && ['function', 'closure', 'arrowfunc', 'class'].includes(n.kind)) return false;
      if (['return', 'global', 'static', 'yield', 'yieldfrom'].includes(n.kind)) ok = false;
      if (n.kind === 'call' && BAD_CALLS.has(String(n.what?.name).toLowerCase())) ok = false;
      if (n.kind === 'magic' && /__FUNCTION__|__METHOD__|__LINE__/i.test(n.raw)) ok = false;
      return ok;
    });
    if (!ok) continue;
    const fnScope = info.scopes.find((s) => s.node === fn);
    if (!fnScope || fnScope.dynamic) continue;
    // gövdenin değişkenleri program kapsamındakilerle çakışmamalı
    if ([...fnScope.vars.keys()].some((v) => info.program.vars.has(v))) continue;
    const params = fn.arguments ?? [];
    if (params.some((p) => p.byref || p.variadic)) continue;
    const assigns = params.map((p, i) => {
      const arg = call.arguments[i];
      const value = arg ? code.slice(...span(arg)) : p.value ? code.slice(...span(p.value)) : 'null';
      return `$${p.name.name ?? p.name} = ${value};`;
    });
    const body = fn.body.children.map((c) => code.slice(...span(c))).join('\n');
    edits.push({ start: stmt.loc.start.offset, end: stmt.loc.end.offset, text: `${assigns.join('\n')}\n${body}` });
    edits.push({ start: fn.loc.start.offset, end: fn.loc.end.offset, text: '' });
    ctx.log(`inline: ${name}() tek çağrı yerine konuldu`, 'info');
  }
  if (!edits.length) return code;
  ctx.bump('inline', edits.length / 2);
  return applyEdits(code, edits).code;
}
