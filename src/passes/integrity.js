// Bütünlük/koruma denetimleri: encoder'ın kendi dosyasını (banner, imza, hash) kontrol edip die/exit ettiği if'ler.
// Koşul sandbox'ta gözlenir; hiç doğru olmadıysa koruma kaldırılır. Güvenlik kuralı: koşul yalnızca dosyanın
// kendisinden, literallerden ve saf fonksiyonlardan türemeli; dış girdiye ($_GET, $_POST, $_COOKIE, $_SERVER...)
// bağlı hiçbir koşula dokunulmaz (webshell'in "parola doğruysa" dalı gözlenmedi diye silinmesin).
import { tryParse, span, applyEdits } from '../core/parse.js';
import { analyze } from '../core/scope.js';
import { pure, varsIn } from './unused.js';

export const id = 'integrity';
export const needsSandbox = true;

const INPUTS = new Set(['_GET', '_POST', '_COOKIE', '_REQUEST', '_SERVER', '_FILES', '_ENV', '_SESSION', 'GLOBALS', 'argv', 'argc', 'http_raw_post_data', 'HTTP_RAW_POST_DATA']);

// gövde yalnızca çıktı + exit/die mi?
function isGuardBody(b) {
  const list = b?.kind === 'block' ? b.children : b ? [b] : [];
  let exits = false;
  for (const s of list) {
    const e = s.kind === 'expressionstatement' ? s.expression : s;
    if (e.kind === 'exit') { exits = true; continue; }
    if (s.kind === 'echo' || e.kind === 'print') continue;
    return false;
  }
  return exits;
}

export async function run(code, ctx) {
  const parsed = tryParse(code);
  if (!parsed) return code;
  const { ast } = parsed;
  const info = analyze(ast);
  if (info.program.dynamic || info.globalDynamic) return code;

  // değişken "statik" mi: tüm yazımları dış girdi okumayan saf atamalar (özyinelemeli)
  const memo = new Map();
  const isStatic = (name, depth = 0) => {
    if (INPUTS.has(name) || depth > 16) return false;
    if (memo.has(name)) return memo.get(name);
    memo.set(name, false);
    const uses = info.program.vars.get(name) ?? [];
    const writes = uses.filter((u) => u.mode !== 'read');
    const ok = writes.length > 0 && writes.every((u) => u.mode === 'write' && u.parent?.kind === 'assign' && u.parent.operator === '=' &&
      pure(u.parent.right) && [...varsIn(u.parent.right)].every((v) => isStatic(v, depth + 1)));
    memo.set(name, ok);
    return ok;
  };

  const guards = ast.children.filter((s) => s.kind === 'if' && !s.alternate && isGuardBody(s.body) && pure(s.test) &&
    [...varsIn(s.test)].every((v) => isStatic(v)));
  if (!guards.length) return code;

  const probe = applyEdits(code, guards.map((g, k) => {
    const [s, e] = span(g.test);
    return { start: s, end: e, text: `__peel_obs(${k}, (${code.slice(s, e)}))` };
  })).code;
  const trace = await ctx.trace(probe);
  if (!trace) return code;
  const edits = [];
  guards.forEach((g, k) => {
    const seen = trace.obs[k];
    if (Array.isArray(seen) && seen.length && seen.every((v) => v === 0)) edits.push({ start: g.loc.start.offset, end: g.loc.end.offset, text: '' });
  });
  if (!edits.length) return code;
  ctx.log(`integrity: ${edits.length} bütünlük/koruma denetimi kaldırıldı (koşul hiç doğru olmadı, yalnızca dosyanın kendisine bağlı)`, 'info');
  ctx.bump('integrity', edits.length);
  return applyEdits(code, edits).code;
}
