// Değişken kapsam analizi (php-parser AST'si üzerinde). Her kapsam (program, fonksiyon, metot, closure) için
// değişken kullanımları okuma/yazma olarak sınıflandırılır. Kapsamı belirsizleştiren yapılar ($$x, ${ifade},
// extract, compact, get_defined_vars, parse_str, eval, include) kapsamı "dinamik" yapar: dönüşümler o kapsama dokunmaz.
import { PURE_FUNCTIONS } from './pure.js';

// fonksiyon adı (çağrılabilir) alan yerleşikler → çağrılabilir argümanın sırası
const CALLBACK_ARG = new Map([['call_user_func', 0], ['call_user_func_array', 0], ['forward_static_call', 0], ['forward_static_call_array', 0],
  ['array_map', 0], ['array_filter', 1], ['array_walk', 1], ['array_walk_recursive', 1], ['array_reduce', 1], ['usort', 1], ['uasort', 1],
  ['uksort', 1], ['register_shutdown_function', 0], ['register_tick_function', 0], ['set_error_handler', 0], ['set_exception_handler', 0],
  ['spl_autoload_register', 0], ['preg_replace_callback', 1], ['ob_start', 0], ['iterator_apply', 1], ['header_register_callback', 0]]);
const DYNAMIC_CALLS = new Set(['extract', 'compact', 'get_defined_vars', 'parse_str', 'mb_parse_str', 'func_get_args', 'func_get_arg', 'debug_backtrace']);

/**
 * @typedef {{ node: object, parent: object, key: string, mode: 'read'|'write'|'rw'|'maybe'|'unset'|'ref' }} Use
 * @typedef {{ node: object, kind: string, parent: Scope|null, vars: Map<string, Use[]>, dynamic: boolean, globals: Set<string> }} Scope
 */

/** @returns {{ scopes: Scope[], program: Scope, globalDynamic: boolean, dynamicCallback: boolean, functions: Map<string, object[]>, calls: Map<string, object[]>, strings: Set<string> }} */
export function analyze(ast) {
  const scopes = [];
  const functions = new Map(); // ad (küçük harf) → bildirim düğümleri
  const calls = new Map(); // doğrudan çağrılan ad → çağrı düğümleri
  const strings = new Set(); // koddaki tüm dizge literalleri (call_user_func('ad') gibi dolaylı başvurular için)
  let globalDynamic = false;
  let dynamicCallback = false;

  const newScope = (node, kind, parent) => {
    const s = { node, kind, parent, vars: new Map(), dynamic: false, globals: new Set() };
    scopes.push(s);
    return s;
  };
  const program = newScope(ast, 'program', null);

  function use(scope, node, parent, key, mode) {
    if (typeof node.name !== 'string') {
      // $$x ya da ${ifade}: kapsam belirsiz
      scope.dynamic = true;
      visit(node.name, scope, 'read', node, 'name');
      return;
    }
    if (node.name === 'this') return;
    if (node.name === 'GLOBALS') globalDynamic = true;
    if (!scope.vars.has(node.name)) scope.vars.set(node.name, []);
    scope.vars.get(node.name).push({ node, parent, key, mode });
  }

  // $a[..] = x, $a->p = x, $a[..]++ ve unset($a[..]): temel değişken değişir; indeksler okunur
  function visitTarget(node, scope, mode, parent, key) {
    if (node && (node.kind === 'offsetlookup' || node.kind === 'propertylookup' || node.kind === 'nullsafepropertylookup')) {
      visitTarget(node.what, scope, 'rw', node, 'what');
      if (node.offset && typeof node.offset === 'object') visit(node.offset, scope, 'read', node, 'offset');
      return;
    }
    visit(node, scope, mode, parent, key);
  }

  function visitList(list, scope, mode, parent, key) {
    for (const item of list ?? []) {
      if (!item) continue;
      if (item.kind === 'entry') {
        if (item.key) visit(item.key, scope, 'read', item, 'key');
        visitTarget(item.value, scope, item.byRef ? 'ref' : mode, item, 'value');
      } else visitTarget(item, scope, mode, parent, key);
    }
  }

  function enterFunction(node, parentScope) {
    const scope = newScope(node, node.kind, parentScope);
    for (const p of node.arguments ?? []) {
      const name = p.name?.name ?? p.name;
      if (typeof name === 'string') {
        if (!scope.vars.has(name)) scope.vars.set(name, []);
        scope.vars.get(name).push({ node: p, parent: node, key: 'arguments', mode: p.byref ? 'ref' : 'write' });
      }
      if (p.value) visit(p.value, scope, 'read', p, 'value');
    }
    for (const u of node.uses ?? []) {
      // use ($x): dış kapsamda okuma, içte yazma; use (&$x): iki tarafta referans
      use(parentScope, u, node, 'uses', u.byref ? 'ref' : 'read');
      if (!scope.vars.has(u.name)) scope.vars.set(u.name, []);
      scope.vars.get(u.name).push({ node: u, parent: node, key: 'uses', mode: u.byref ? 'ref' : 'write' });
    }
    if (node.kind === 'arrowfunc') {
      // fn() => ...: dış kapsamı değerle yakalar; okumalar dış kapsamda sayılır
      visit(node.body, parentScope, 'read', node, 'body');
      scopes.pop();
      return;
    }
    visit(node.body, scope, 'read', node, 'body');
  }

  function visit(node, scope, mode, parent, key) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const n of node) visit(n, scope, mode, parent, key); return; }
    if (!node.kind) return;
    switch (node.kind) {
      case 'variable':
        use(scope, node, parent, key, mode);
        return;
      case 'assign': {
        const leftMode = node.operator === '=' ? 'write' : 'rw';
        if (node.left.kind === 'list' || node.left.kind === 'array') visitList(node.left.items, scope, 'write', node.left, 'items');
        else visitTarget(node.left, scope, leftMode, node, 'left');
        // $a = &$b: iki taraf da referans
        visit(node.right, scope, node.right?.byref ? 'ref' : 'read', node, 'right');
        if (node.right?.byref && node.left.kind === 'variable') use(scope, node.left, node, 'left', 'ref');
        return;
      }
      case 'list':
        visitList(node.items, scope, mode === 'write' ? 'write' : 'read', parent, key);
        return;
      case 'post': case 'pre':
        visitTarget(node.what, scope, 'rw', node, 'what');
        return;
      case 'foreach':
        visit(node.source, scope, 'read', node, 'source');
        if (node.key) visit(node.key, scope, 'write', node, 'key');
        if (node.value) {
          if (node.value.kind === 'list' || node.value.kind === 'array') visitList(node.value.items, scope, 'write', node.value, 'items');
          else visit(node.value, scope, node.value.byref ? 'ref' : 'write', node, 'value');
        }
        visit(node.body, scope, 'read', node, 'body');
        return;
      case 'unset':
        for (const v of node.variables) {
          if (v.kind === 'variable') use(scope, v, node, 'variables', 'unset');
          else visitTarget(v, scope, 'rw', node, 'variables');
        }
        return;
      case 'global':
        for (const v of node.items) {
          if (typeof v.name === 'string') { scope.globals.add(v.name); use(scope, v, node, 'items', 'ref'); } else scope.dynamic = true;
        }
        return;
      case 'static':
        for (const sv of node.variables) {
          use(scope, sv.variable, sv, 'variable', 'ref');
          if (sv.defaultValue) visit(sv.defaultValue, scope, 'read', sv, 'defaultValue');
        }
        return;
      case 'catch':
        if (node.variable) use(scope, node.variable, node, 'variable', 'write');
        visit(node.body, scope, 'read', node, 'body');
        return;
      case 'function':
        if (node.name) {
          const n = String(node.name.name ?? node.name).toLowerCase();
          if (!functions.has(n)) functions.set(n, []);
          functions.get(n).push(node);
        }
        enterFunction(node, scope);
        return;
      case 'method':
        enterFunction(node, scope);
        return;
      case 'closure': case 'arrowfunc':
        enterFunction(node, scope);
        return;
      case 'eval': case 'include':
        scope.dynamic = true;
        visit(node.source ?? node.target, scope, 'read', node, 'source');
        return;
      case 'call': {
        const name = node.what?.kind === 'name' ? String(node.what.name).replace(/^\\/, '').toLowerCase() : null;
        if (name) {
          if (!calls.has(name)) calls.set(name, []);
          calls.get(name).push(node);
          if (DYNAMIC_CALLS.has(name)) scope.dynamic = true;
        } else {
          visit(node.what, scope, 'read', node, 'what');
        }
        // saf olmayan fonksiyona doğrudan verilen değişken referansla yazılmış olabilir (preg_match($a, $b, $m))
        const argMode = name && PURE_FUNCTIONS.has(name) ? 'read' : 'maybe';
        // define('AD', ...): sabitin kendi adı "dizgede kullanım" sayılmaz
        const args = name === 'define' && node.arguments?.[0]?.kind === 'string' ? node.arguments.slice(1) : node.arguments ?? [];
        // geri çağırma alan fonksiyona sabit olmayan çağrılabilir verildiyse hangi fonksiyonun çağrıldığı bilinmez
        if (name && CALLBACK_ARG.has(name)) {
          const cb = node.arguments?.[CALLBACK_ARG.get(name)];
          if (cb && cb.kind !== 'string' && cb.kind !== 'closure' && cb.kind !== 'arrowfunc') dynamicCallback = true;
        }
        for (const a of args) {
          if (argMode === 'maybe' && (a.kind === 'offsetlookup' || a.kind === 'propertylookup')) visitTarget(a, scope, 'maybe', node, 'arguments');
          else visit(a, scope, a.kind === 'variable' ? argMode : 'read', node, 'arguments');
        }
        return;
      }
      case 'new':
        visit(node.what, scope, 'read', node, 'what');
        for (const a of node.arguments ?? []) visit(a, scope, a.kind === 'variable' ? 'maybe' : 'read', node, 'arguments');
        return;
      case 'string':
        strings.add(String(node.value).toLowerCase());
        return;
      default:
        break;
    }
    for (const k of Object.keys(node)) {
      if (k === 'loc' || k === 'kind' || k === 'leadingComments' || k === 'trailingComments') continue;
      const v = node[k];
      if (v && typeof v === 'object') visit(v, scope, 'read', node, k);
    }
  }

  visit(ast.children, program, 'read', ast, 'children');
  if (globalDynamic) program.dynamic = true;
  // global $x kullanan fonksiyon varsa program kapsamındaki $x başka yerden de yazılabilir
  for (const s of scopes) for (const g of s.globals) program.vars.get(g)?.push({ node: s.node, parent: null, key: 'global', mode: 'ref' });
  return { scopes, program, globalDynamic, dynamicCallback, functions, calls, strings };
}
