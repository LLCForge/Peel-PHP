// preg_replace /e katmanı: preg_replace('/.*/e', KOD, '') — PHP < 5.5'te değiştirme metni eşleşme başına PHP kodu
// olarak çalışır. Desen, değiştirme ve konu literalse ve konu boş dizgeyse (tek eşleşme) deyim KOD'un kendisi olur.
// Desen/değiştirme hesaplanıyorsa sandbox (PHP 5.2) çalıştırmada yakalanır ve layers pass'i açar (__peel_preg).
import { tryParse, walk, span, applyEdits } from '../core/parse.js';

export const id = 'prege';

const callName = (n) => (n?.kind === 'call' && n.what?.kind === 'name' ? String(n.what.name).replace(/^\\/, '').toLowerCase() : null);

// "/gövde/bayraklar" (aynı karakter sınırlayıcı) → { body, flags }
function splitPattern(p) {
  const m = /^([^a-zA-Z0-9\s\\])(.*)\1([a-zA-Z]*)$/s.exec(p);
  return m ? { body: m[2], flags: m[3] } : null;
}

export async function run(code, ctx) {
  const parsed = tryParse(code);
  if (!parsed) return code;
  const edits = [];
  walk(parsed.ast, (n) => {
    if (n.kind !== 'expressionstatement') return true;
    const call = n.expression?.kind === 'silent' ? n.expression.expr : n.expression;
    if (callName(call) !== 'preg_replace' || call.arguments.length !== 3) return true;
    const [pat, rep, subj] = call.arguments;
    if (pat.kind !== 'string' || rep.kind !== 'string' || subj.kind !== 'string' || subj.value !== '') return true;
    const p = splitPattern(pat.value);
    if (!p || !p.flags.includes('e')) return true;
    let re;
    try { re = new RegExp(p.body, p.flags.replace(/[^imsu]/g, '')); } catch { return true; }
    const m = re.exec('');
    if (!m) return true;
    // geri başvurular boş eşleşmeyle (\0, \1, $1, ${1}) yer değiştirir
    const body = rep.value.replace(/\\\d{1,2}|\$\d{1,2}|\$\{\d{1,2}\}/g, '').trim().replace(/;+\s*$/, '');
    if (!body || !tryParse(`<?php ${body};`)) return true;
    const [s, e] = span(n);
    edits.push({ start: s, end: e, text: `${body};` });
    return false;
  });
  if (!edits.length) return code;
  const r = applyEdits(code, edits);
  ctx.log(`prege: ${r.applied} preg_replace /e katmanı açıldı`, 'info');
  ctx.bump('layers', r.applied);
  return r.code;
}
