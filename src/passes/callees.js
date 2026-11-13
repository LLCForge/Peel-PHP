// İfadeyle yapılan çağrılar: substr($tablo, 32, 7)(), $t[3]($x) gibi çağrılan adı hesaplanan çağrılarda ad ifadesi
// sandbox'ta gözlenir; her çalıştığında aynı fonksiyon adını verdiyse doğrudan çağrı yazılır (tmpfile()).
// Güvenlik: ad ifadesi saf olmalı ve okuduğu değişkenler yalnızca literallerden/saf hesaplardan türemeli (dış girdi,
// referans, saf olmayan fonksiyon sonucu yok); böylece değer çalıştırmadan çalıştırmaya değişemez. Webshell'in
// $_GET['f']($x) çağrısına dokunulmaz.
import { tryParse, walk, span, applyEdits } from '../core/parse.js';
import { analyze } from '../core/scope.js';
import { pure, varsIn } from './unused.js';
import { fromBase64 } from '../core/bstr.js';

export const id = 'callees';
export const needsSandbox = true;

const INPUTS = new Set(['_GET', '_POST', '_COOKIE', '_REQUEST', '_SERVER', '_FILES', '_ENV', '_SESSION', 'GLOBALS', 'argv', 'argc', 'this', 'http_raw_post_data', 'HTTP_RAW_POST_DATA']);
const FUNC_NAME = /^[a-zA-Z_\x80-\xff][a-zA-Z0-9_\x80-\xff]*$/;
const NOT_CALLABLE = new Set(['echo', 'print', 'eval', 'include', 'include_once', 'require', 'require_once', 'isset', 'unset', 'empty', 'exit', 'die', 'list', 'array', 'assert', 'create_function']);
const STATIC_CALLEE = new Set(['name', 'propertylookup', 'nullsafepropertylookup', 'staticlookup', 'closure', 'arrowfunc']);
const FN = new Set(['function', 'closure', 'arrowfunc', 'method']);

export async function run(code, ctx) {
  const parsed = tryParse(code);
  if (!parsed) return code;
  const { ast } = parsed;
  const info = analyze(ast);
  const parents = new Map();
  walk(ast, (n, p, key) => { parents.set(n, [p, key]); });
  const scopeOf = (n) => {
    let c = parents.get(n)?.[0];
    while (c && !FN.has(c.kind)) c = parents.get(c)?.[0];
    return info.scopes.find((s) => s.node === (c ?? ast)) ?? null;
  };

  // değişken temiz mi: tüm yazımları saf ve yalnızca temiz değişkenleri okuyor (döngüsel bağımlılık iyimser)
  const memo = new Map();
  const clean = (scope, name) => {
    const key = `${info.scopes.indexOf(scope)}:${name}`;
    if (INPUTS.has(name)) return false;
    if (memo.has(key)) return memo.get(key);
    memo.set(key, true);
    let ok = !scope.dynamic && !(scope.kind === 'program' && info.globalDynamic) && !scope.globals.has(name);
    const uses = scope.vars.get(name) ?? [];
    if (!uses.some((u) => u.mode === 'write')) ok = false;
    const exprClean = (e) => pure(e) && [...varsIn(e)].every((v) => clean(scope, v) || loopCounter(scope, v, e));
    for (const u of uses) {
      if (!ok) break;
      if (u.mode === 'read' || u.mode === 'unset') continue;
      if (u.mode === 'ref' || u.mode === 'maybe') { ok = false; break; }
      // atamanın kendisini bul (hedef $v ya da $v[..][..])
      let target = u.node;
      let p = u.parent;
      while (p?.kind === 'offsetlookup' && p.what === target) {
        if (p.offset && !exprClean(p.offset)) ok = false;
        target = p;
        p = parents.get(p)?.[0];
      }
      if (!ok) break;
      if (p?.kind === 'assign' && p.left === target) { ok = !p.right?.byref && exprClean(p.right); continue; }
      if ((p?.kind === 'post' || p?.kind === 'pre') && p.what === target) continue;
      if (p?.kind === 'foreach' && (p.key === target || p.value === target)) { ok = !p.value?.byref && exprClean(p.source); continue; }
      ok = false;
    }
    memo.set(key, ok);
    return ok;
  };

  // for ($i = sabit; ...; $i++) içinde $i: başlatıcısı temiz, yalnızca artırmada değişiyor → döngü içinde temiz
  // (aynı ad döngüden sonra başka amaçla kullanılsa bile)
  const inside = (n, root) => n.loc && root.loc && n.loc.start.offset >= root.loc.start.offset && n.loc.end.offset <= root.loc.end.offset;
  function loopCounter(scope, v, at) {
    for (let c = parents.get(at)?.[0]; c && !FN.has(c.kind); c = parents.get(c)?.[0]) {
      if (c.kind !== 'for') continue;
      const init = c.init.find((x) => x.kind === 'assign' && x.left.kind === 'variable' && x.left.name === v);
      if (!init || !pure(init.right) || ![...varsIn(init.right)].every((w) => w !== v && clean(scope, w))) continue;
      const incOk = c.increment.every((x) => (x.kind === 'post' || x.kind === 'pre') || !varsIn(x).has(v));
      const bodyWrites = (scope.vars.get(v) ?? []).some((u) => u.mode !== 'read' && inside(u.node, c.body));
      if (incOk && !bodyWrites) return true;
    }
    return false;
  }

  const cands = [];
  walk(ast, (n) => {
    if (n.kind !== 'call' || !n.what || STATIC_CALLEE.has(n.what.kind) || n.what.kind === 'string') return true;
    const e = n.what;
    if (!pure(e) || !e.loc) return true;
    const scope = scopeOf(n);
    if (!scope || ![...varsIn(e)].every((v) => clean(scope, v))) return true;
    cands.push(e);
    return true;
  });
  if (!cands.length) return code;
  const probe = applyEdits(code, cands.map((e, k) => {
    const [s, t] = span(e);
    return { start: s, end: t, text: `__peel_val(${k}, (${code.slice(s, t)}))` };
  })).code;
  const trace = await ctx.trace(probe);
  if (!trace) return code;
  const edits = [];
  cands.forEach((e, k) => {
    const seen = trace.obs[k];
    if (!Array.isArray(seen) || !seen.length || new Set(seen).size !== 1 || !String(seen[0]).startsWith('s')) return;
    const name = fromBase64(String(seen[0]).slice(1));
    if (!FUNC_NAME.test(name) || NOT_CALLABLE.has(name.toLowerCase())) return;
    const [s, t] = span(e);
    edits.push({ start: s, end: t, text: name });
  });
  if (!edits.length) return code;
  const r = applyEdits(code, edits);
  ctx.log(`callees: ${r.applied} hesaplanan çağrı adı doğrudan yazıldı`, 'info');
  ctx.bump('directCalls', r.applied);
  return r.code;
}
