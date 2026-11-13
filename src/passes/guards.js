// Analiz karşıtı kontroller: kodun hata ayıklayıcı / eval kancası (evalhook, xdebug, vld...) arayıp çıktığı denetimler.
// Sandbox'ta da yanlış döndükleri için davranış değişmez; false yazılınca ölü kod pass'i dalı kaldırır.
// __LINE__ o anki satır numarasıyla sabitlenir: encoder'ların if (__LINE__ > 1) gibi koşulları katlanabilir.
import { tryParse, walk, applyEdits } from '../core/parse.js';
import { ANTI_ANALYSIS_EXTENSIONS } from '../core/pure.js';

export const id = 'guards';

const DEBUG_FUNCS = /^(xdebug_|vld_|uopz_|runkit_|phpdbg_|xhprof_|tideways_)/i;

export async function run(code, ctx) {
  const parsed = tryParse(code);
  if (!parsed) return code;
  const edits = [];
  let lines = 0;
  walk(parsed.ast, (n) => {
    if (n.kind === 'magic' && String(n.raw).toUpperCase() === '__LINE__') {
      edits.push({ start: n.loc.start.offset, end: n.loc.end.offset, text: `(${n.loc.start.line})` });
      lines++;
      return true;
    }
    if (n.kind !== 'call' || n.what?.kind !== 'name') return true;
    const name = String(n.what.name).replace(/^\\/, '').toLowerCase();
    const arg = n.arguments[0];
    if (arg?.kind !== 'string' || n.arguments.length !== 1) return true;
    const v = String(arg.value).toLowerCase();
    const hit = (name === 'extension_loaded' && ANTI_ANALYSIS_EXTENSIONS.has(v)) || (name === 'function_exists' && DEBUG_FUNCS.test(v));
    if (hit) edits.push({ start: n.loc.start.offset, end: n.loc.end.offset, text: 'false' });
    return true;
  });
  if (!edits.length) return code;
  if (edits.length > lines) ctx.log(`guards: ${edits.length - lines} analiz karşıtı kontrol etkisizleştirildi`, 'info');
  ctx.bump('guards', edits.length - lines);
  return applyEdits(code, edits).code;
}
