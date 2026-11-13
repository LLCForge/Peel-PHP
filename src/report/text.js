// Rapor modüllerinin ortak yardımcıları: kaynak metinleri, kanıt kesitleri, dil seçimi.
import { toText } from '../core/bstr.js';
import { tryParse, EVAL_PREFIX } from '../core/parse.js';

export const pick = (o, lang) => (lang === 'en' ? o.en : o.tr);

export const WHERE = {
  input: { tr: 'girdi', en: 'input' },
  layer: { tr: 'katman', en: 'layer' },
  output: { tr: 'çıktı', en: 'output' },
  behaviour: { tr: 'davranış', en: 'behaviour' },
};

/** Kanıt için tek satırlık, kısaltılmış kesit */
export function snippet(s, max = 120) {
  const one = String(s).replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/** Kaynağın AST'si (bir kez ayrıştırılır; ayrıştırılamazsa null) */
export function astOf(src) {
  if (src.ast === undefined) src.ast = tryParse(src.isEval ? EVAL_PREFIX + src.code : src.code)?.ast ?? null;
  return src.ast;
}

/** AST düğümünün kaynak metni (eval kaynaklarında ayrıştırma öneki düşülür; konumlar bayt konumudur) */
export function nodeText(src, node) {
  const shift = src.isEval ? EVAL_PREFIX.length : 0;
  return toText(src.code.slice(node.loc.start.offset - shift, node.loc.end.offset - shift));
}

/**
 * Analiz edilecek kaynaklar: girdi, sandbox'ın yakaladığı eval katmanları ve çözülmüş çıktı.
 * Her biri { where, code (bstr), text } olarak; aynı içerik bir kez alınır.
 */
export function sourcesOf({ input, output, trace }) {
  const seen = new Set();
  const out = [];
  const add = (where, code, isEval = false) => {
    if (typeof code !== 'string' || !code || seen.has(code)) return;
    seen.add(code);
    out.push({ where, code, text: toText(code), isEval });
  };
  add('input', input);
  for (const e of trace?.first?.evals ?? []) add('layer', e.code, true);
  add('output', output);
  return out;
}
