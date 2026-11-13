// Etiket artıkları: açılan katmanlar "?><?php" bırakır. Arada çıktı yoksa (kapanış etiketi doğrudan açılışa
// bitişikse) iki etiket kaldırılır. Arada metin olan etiketlere dokunulmaz (çıktıyı değiştirirdi).
import { tokens } from '../core/parse.js';

export const id = 'tags';

export async function run(code, ctx) {
  let toks;
  try {
    toks = tokens(code);
  } catch {
    return code;
  }
  let pos = 0;
  const marks = toks.map((t) => {
    const text = Array.isArray(t) ? t[1] : t;
    const m = { name: Array.isArray(t) ? t[0] : null, text, start: pos };
    pos += text.length;
    return m;
  });
  if (pos !== code.length) return code;
  let out = '';
  let last = 0;
  let n = 0;
  for (let i = 0; i < marks.length - 1; i++) {
    const a = marks[i];
    const b = marks[i + 1];
    if (a.name !== 'T_CLOSE_TAG' || b.name !== 'T_OPEN_TAG') continue;
    out += `${code.slice(last, a.start)}\n`;
    last = b.start + b.text.length;
    n++;
    i++;
  }
  if (!n) return code;
  ctx.log(`tags: ${n} gereksiz ?><?php birleştirildi`, 'info');
  ctx.bump('tags', n);
  return out + code.slice(last);
}
