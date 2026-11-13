// Okunmaz tanımlayıcıları okunur, belirlenimli adlara çevirir (src/core/names.js'teki ölçütlerle; okunur adlara
// dokunulmaz). Değişkenler kapsam başına ve kullanıma göre adlandırılır (parametre arg1, foreach item/key, for
// sayacı i, catch e, dizi list, nesne sınıf adından, dizge str...); çıkarılamazsa v1, v2. Fonksiyon, sınıf, metot,
// özellik ve sabitler yalnızca dosyada dinamik erişim (değişkenle çağrı, $o->$p, new $c) ve adı içeren dizge
// literali yoksa yeniden adlandırılır: fn1, Class1, method1, prop1, CONST1.
import { tryParse, walk, span, applyEdits } from '../core/parse.js';
import { analyze } from '../core/scope.js';
import { unreadableSet } from '../core/names.js';

export const id = 'rename';

const SPECIAL = new Set(['GLOBALS', '_GET', '_POST', '_COOKIE', '_REQUEST', '_SERVER', '_FILES', '_ENV', '_SESSION', 'this',
  'argv', 'argc', 'http_response_header', 'php_errormsg', 'HTTP_RAW_POST_DATA']);
const LOOKUPS = new Set(['propertylookup', 'nullsafepropertylookup', 'staticlookup']);
const idOf = (n) => (n && typeof n === 'object' ? n.name : n);

// çağrılan yerleşik fonksiyona göre sonuç değişkeninin adı
const CALL_NAMES = [
  [/^(count|sizeof)$/, 'count'], [/^(strlen|mb_strlen)$/, 'len'], [/^(explode|preg_split|str_split|mb_split)$/, 'parts'],
  [/^(implode|join|sprintf|str_|substr|trim|ltrim|rtrim|strto|ucfirst|lcfirst|ucwords|strrev|number_format|nl2br|htmlspecialchars|wordwrap)/, 'str'],
  [/^(array_|range|compact|iterator_to_array)/, 'list'], [/^(fopen|tmpfile|popen|opendir|curl_init|fsockopen)$/, 'handle'],
  [/^(file_get_contents|fread|stream_get_contents|file)$/, 'content'], [/^(json_decode|unserialize)$/, 'data'],
  [/^(base64_decode|gzinflate|gzuncompress|gzdecode|str_rot13|hex2bin|urldecode|rawurldecode)$/, 'decoded'],
  [/^(md5|sha1|hash|crc32|hash_hmac)$/, 'hash'], [/^(preg_match|preg_match_all|in_array|is_\w+|isset|empty|file_exists)$/, 'found'],
  [/^(time|microtime|mktime|strtotime)$/, 'time'], [/^(round|floor|ceil|abs|intval|floatval|max|min|array_sum)$/, 'num'],
];

export async function run(code, ctx) {
  const parsed = tryParse(code);
  if (!parsed) return code;
  const { ast } = parsed;
  if (ast.children.some((c) => c.kind === 'namespace')) return code;
  const info = analyze(ast);
  const parents = new Map();
  walk(ast, (n, p, key) => { parents.set(n, [p, key]); });

  // ---- bildirimler ve başvurular
  const decl = { fn: new Map(), cls: new Map(), method: new Map(), prop: new Map(), cconst: new Map(), gconst: new Map() };
  const refs = { fn: [], cls: [], method: [], prop: [], cconst: [], gconst: [] };
  const addDecl = (kind, key, node, extra) => { if (!decl[kind].has(key)) decl[kind].set(key, { name: node.kind === 'string' ? node.value : idOf(node.name ?? node), nodes: [], ...extra }); decl[kind].get(key).nodes.push(node); };
  let dynFn = info.dynamicCallback;
  let dynCls = false;
  let dynMember = false;
  const arrowParams = new Set();
  walk(ast, (n, p, key) => {
    switch (n.kind) {
      case 'function': if (n.name) addDecl('fn', idOf(n.name).toLowerCase(), n.name); break;
      case 'class': case 'interface': case 'trait': case 'enum': if (n.name) addDecl('cls', idOf(n.name).toLowerCase(), n.name, { kind: n.kind }); break;
      case 'method': addDecl('method', idOf(n.name).toLowerCase(), n.name); break;
      case 'property': addDecl('prop', idOf(n.name), n.name); break;
      case 'constant':
        if (p?.kind === 'classconstant') addDecl('cconst', idOf(n.name), n.name);
        else if (p?.kind === 'constantstatement') addDecl('gconst', idOf(n.name), n.name);
        break;
      case 'arrowfunc': for (const a of n.arguments ?? []) arrowParams.add(idOf(a.name)); break;
      case 'parameter': if (n.flags || n.visibility || n.readonly) dynMember = true; break; // yapıcıda özellik tanıtımı
      case 'call': {
        const w = n.what;
        if (w?.kind === 'name') {
          const nm = String(w.name).replace(/^\\/, '');
          refs.fn.push({ node: w, key: nm.toLowerCase() });
          if (nm.toLowerCase() === 'define' && n.arguments[0]?.kind === 'string' && p?.kind === 'expressionstatement') {
            addDecl('gconst', n.arguments[0].value, n.arguments[0], { define: true });
          }
        } else if (!LOOKUPS.has(w?.kind)) dynFn = true;
        if (LOOKUPS.has(w?.kind) && w.offset?.kind !== 'identifier') dynMember = true;
        break;
      }
      case 'new': if (n.what?.kind !== 'name' && n.what?.kind !== 'class') dynCls = true; break;
      case 'propertylookup': case 'nullsafepropertylookup':
        if (n.offset?.kind !== 'identifier') dynMember = true;
        else if (!(p?.kind === 'call' && key === 'what')) refs.prop.push({ node: n.offset, key: idOf(n.offset) });
        else refs.method.push({ node: n.offset, key: idOf(n.offset).toLowerCase() });
        break;
      case 'staticlookup':
        if (n.what?.kind !== 'name' && !['selfreference', 'staticreference', 'parentreference'].includes(n.what?.kind)) dynCls = true;
        if (n.offset?.kind === 'identifier') {
          const nm = idOf(n.offset);
          if (p?.kind === 'call' && key === 'what') refs.method.push({ node: n.offset, key: nm.toLowerCase() });
          else if (nm.toLowerCase() !== 'class') refs.cconst.push({ node: n.offset, key: nm });
        } else if (n.offset?.kind === 'variable' && typeof n.offset.name === 'string') refs.prop.push({ node: n.offset, key: n.offset.name, dollar: true });
        else dynMember = true;
        break;
      case 'name': {
        if (p?.kind === 'call' && key === 'what') break;
        const nm = String(n.name).replace(/^\\/, '');
        refs.cls.push({ node: n, key: nm.toLowerCase() });
        refs.gconst.push({ node: n, key: nm });
        break;
      }
      default: break;
    }
    return true;
  });

  // ---- değişkenler (kapsam başına; statik özellik başvuruları $s değişken sayılmaz)
  const scopeVars = [];
  for (const scope of info.scopes) {
    if (scope.dynamic || (scope.kind === 'program' && info.globalDynamic)) continue;
    const vars = new Map();
    for (const [name, uses] of scope.vars) {
      const own = uses.filter((u) => !(u.parent?.kind === 'staticlookup' && u.key === 'offset'));
      if (own.length) vars.set(name, own);
    }
    scopeVars.push({ scope, vars });
  }
  const globalNames = new Set(info.scopes.flatMap((s) => [...s.globals]));

  const all = new Set();
  for (const k of Object.keys(decl)) for (const d of decl[k].values()) all.add(d.name);
  for (const { vars } of scopeVars) for (const n of vars.keys()) if (!SPECIAL.has(n)) all.add(n);
  const bad = unreadableSet([...all].filter((n) => typeof n === 'string' && n !== '__construct'));
  if (!bad.size) return code;

  const edits = new Map();
  const put = (node, text) => { const [s, e] = span(node); edits.set(s, { start: s, end: e, text }); };
  const strRef = (name, ci) => (ci ? info.strings.has(name.toLowerCase()) : [...info.strings].some((s) => s === name.toLowerCase()));
  const mapping = { fn: new Map(), cls: new Map(), method: new Map(), prop: new Map(), cconst: new Map(), gconst: new Map() };
  const counters = {};
  const fresh = (base, used) => { let i = counters[base] ?? 0; let n; do { n = `${base}${++i}`; } while (used.has(n.toLowerCase())); counters[base] = i; used.add(n.toLowerCase()); return n; };

  // ---- fonksiyonlar, sınıflar, üyeler, sabitler
  const usedFn = new Set([...decl.fn.keys(), ...refs.fn.map((r) => r.key)]);
  if (!dynFn) for (const [key, d] of decl.fn) if (bad.has(d.name) && !strRef(key, true)) mapping.fn.set(key, fresh('fn', usedFn));
  const usedCls = new Set([...decl.cls.keys(), ...refs.cls.map((r) => r.key)]);
  if (!dynCls) {
    for (const [key, d] of decl.cls) {
      if (!bad.has(d.name) || strRef(key, true)) continue;
      mapping.cls.set(key, fresh(d.kind === 'interface' ? 'Interface' : d.kind === 'trait' ? 'Trait' : 'Class', usedCls));
    }
  }
  if (!dynMember) {
    const usedM = new Set([...decl.method.keys(), ...refs.method.map((r) => r.key)]);
    for (const [key, d] of decl.method) if (bad.has(d.name) && !strRef(key, true) && !key.startsWith('__')) mapping.method.set(key, fresh('method', usedM));
    const usedP = new Set([...decl.prop.keys(), ...refs.prop.map((r) => r.key)].map((x) => x.toLowerCase()));
    for (const [key, d] of decl.prop) if (bad.has(d.name) && !strRef(key, false)) mapping.prop.set(key, fresh('prop', usedP));
  }
  const usedC = new Set([...decl.cconst.keys(), ...decl.gconst.keys()].map((x) => x.toLowerCase()));
  for (const [key, d] of decl.cconst) if (bad.has(d.name) && !strRef(key, false)) mapping.cconst.set(key, fresh('CONST', usedC));
  for (const [key, d] of decl.gconst) if (bad.has(d.name) && !strRef(key, false)) mapping.gconst.set(key, fresh('CONST', usedC));

  for (const [kind, m] of Object.entries(mapping)) {
    for (const [key, nn] of m) {
      for (const node of decl[kind].get(key).nodes) {
        if (node.kind === 'string') put(node, `'${nn}'`);
        else put(node, kind === 'prop' ? `$${nn}` : nn);
      }
    }
    for (const r of refs[kind]) {
      if (!m.has(r.key)) continue;
      // sınıf/sabit başvurusu olarak toplanan ad başka türün bildirimiyse karışmasın
      const nn = m.get(r.key);
      const raw = code.slice(...span(r.node));
      put(r.node, r.dollar ? `$${nn}` : raw.startsWith('\\') ? `\\${nn}` : nn);
    }
  }

  // ---- değişkenler
  const classNew = (n) => {
    if (n?.kind !== 'new' || n.what?.kind !== 'name') return null;
    const k = String(n.what.name).replace(/^\\/, '').toLowerCase();
    const nm = mapping.cls.get(k) ?? String(n.what.name).replace(/^.*\\/, '');
    return bad.has(nm) ? null : nm.charAt(0).toLowerCase() + nm.slice(1);
  };
  const roleOf = (name, uses, scope) => {
    for (const u of uses) {
      if (u.node.kind === 'parameter') return `arg${(scope.node.arguments ?? []).indexOf(u.node) + 1}`;
      if (u.parent?.kind === 'catch') return 'e';
      if (u.parent?.kind === 'foreach' && u.key === 'key') return 'key';
      if (u.parent?.kind === 'foreach' && u.key === 'value') return 'item';
    }
    const first = uses.find((u) => u.mode === 'write' && u.parent?.kind === 'assign');
    if (!first) return 'v';
    const [stmtParent, stmtKey] = parents.get(first.parent) ?? [];
    if (stmtParent?.kind === 'for' && stmtKey === 'init') return 'i';
    const r = first.parent.right;
    if (!r) return 'v';
    if (r.kind === 'array') return 'list';
    if (r.kind === 'new') return classNew(r) ?? 'obj';
    if (r.kind === 'string' || r.kind === 'encapsed' || (r.kind === 'bin' && r.type === '.')) return 'str';
    if (r.kind === 'number') return 'num';
    if (r.kind === 'boolean') return 'flag';
    if (r.kind === 'closure' || r.kind === 'arrowfunc') return 'callback';
    if (r.kind === 'call' && r.what?.kind === 'name') {
      const fname = String(r.what.name).replace(/^\\/, '').toLowerCase();
      for (const [re, nm] of CALL_NAMES) if (re.test(fname)) return nm;
    }
    return 'v';
  };
  const renameVarNode = (node, oldName, nn) => {
    const target = node.kind === 'parameter' ? node.name : node;
    if (!target?.loc) return false;
    const [s, e] = span(target);
    const text = code.slice(s, e);
    const re = new RegExp(`^(&?\\.{0,3}\\$\\{?)${oldName.replace(/[^\w]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`)}`);
    if (!re.test(text)) return false;
    edits.set(s, { start: s, end: e, text: text.replace(re, `$1${nn}`) });
    return true;
  };
  const varMaps = new Map(); // kapsam düğümü → (eski → yeni)
  let varCount = 0;
  for (const { scope, vars } of scopeVars) {
    const used = new Set([...vars.keys()].map((n) => n.toLowerCase()));
    const local = new Map();
    // closure use($x): içteki ad dıştakiyle aynı kalmalı
    const outer = scope.parent ? varMaps.get(scope.parent.node) : null;
    const useNames = new Set((scope.node.uses ?? []).map((u) => u.name));
    const counter = {};
    for (const [name, uses] of vars) {
      if (SPECIAL.has(name) || globalNames.has(name) || arrowParams.has(name)) continue;
      if (useNames.has(name)) { if (outer?.has(name)) local.set(name, outer.get(name)); continue; }
      if (!bad.has(name)) continue;
      // dış kapsamdan use ile alınan değişkenin içteki karşılığı ayrıca adlandırılmaz
      const base = roleOf(name, uses, scope);
      let nn;
      if (base === 'v' || /^arg\d+$/.test(base)) {
        if (base === 'v') { let i = counter.v ?? 0; do { nn = `v${++i}`; } while (used.has(nn)); counter.v = i; } else nn = used.has(base) ? `${base}_` : base;
      } else {
        nn = base;
        for (let i = 2; used.has(nn.toLowerCase()); i++) nn = `${base}${i}`;
      }
      used.add(nn.toLowerCase());
      local.set(name, nn);
    }
    varMaps.set(scope.node, local);
    for (const [name, nn] of local) {
      for (const u of vars.get(name) ?? []) if (renameVarNode(u.node, name, nn) === false) return code;
      if (!useNames.has(name)) varCount++;
    }
  }

  if (!edits.size) return code;
  const r = applyEdits(code, [...edits.values()]);
  const n = Object.values(mapping).reduce((a, m) => a + m.size, 0) + varCount;
  ctx.log(`rename: ${n} okunmaz ad yeniden adlandırıldı (${varCount} değişken)`, 'info');
  ctx.bump('rename', n);
  return r.code;
}
