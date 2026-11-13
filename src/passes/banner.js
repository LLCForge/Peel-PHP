// Encoder banner/lisans yorumları (YAK Pro, ALOM, PHPkoru, "PHP Encoder - Free Code Protection Tool", FOPO...) ve
// encoder'ların koda serptiği iç yorumlar (/*848c*/, /* Y */ /* A */ ... /** */) kaldırılır. Yalnızca kod artık kendi
// dosyasını okumuyorsa (bütünlük denetimi kaldırılmışsa): __FILE__, __COMPILER_HALT_OFFSET__ ya da betik yolu
// geçiyorsa yorumlara dokunulmaz (banner'ın kendisi denetlenen metin olabilir). Kullanıcı yorumları kalır.
import { tokens } from '../core/parse.js';

export const id = 'banner';

// her yerde tanınan encoder imzaları
const KNOWN = [
  /Obfuscated by YAK Pro/i, /yakpro-po/i, /ALOM (Obfuscator|ANTITAMPER)/i, /This script has protected by Alom/i, /PHPKoru/i,
  /PHP Encoder\s*-\s*Free Code Protection Tool/i, /\bFOPO\b|Free Online PHP Obfuscator/i, /Obfuscated by ALOM/i,
  /obfuscator\.io/i, /phpprotect\.info|php-obfuscator\.com|phpobfuscator\.net/i, /Obfuscated (by|with|using) .{0,40}(Obfuscator|Encoder)/i,
];
// yalnızca dosya başlığında (ilk deyimden önce) tanınanlar
const HEADER = [/\b(protected|encoded|encrypted|obfuscated) (by|with|using)\b/i, /do not (modify|edit|change)/i, /ioncube|sourceguardian|zend ?guard/i];
// encoder iç yorumu: yalnızca onaltılık gürültü, tek harf ya da boş belge yorumu
const NOISE = /^\/\*+\s*([0-9a-f]{2,16}|[A-Z]|)\s*\*+\/$/;
const SELF = /__FILE__|__COMPILER_HALT_OFFSET__|SCRIPT_FILENAME|get_included_files|PHP_SELF|_OUTER_FILE/i;

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
  // kod kendi dosyasına bakıyorsa banner denetleniyor olabilir
  if (marks.some((m) => m.name !== 'T_COMMENT' && m.name !== 'T_DOC_COMMENT' && m.name !== 'T_INLINE_HTML' && SELF.test(m.text))) return code;
  const firstCode = marks.findIndex((m) => m.name && !['T_OPEN_TAG', 'T_WHITESPACE', 'T_COMMENT', 'T_DOC_COMMENT', 'T_INLINE_HTML'].includes(m.name));
  const edits = [];
  marks.forEach((m, i) => {
    if (m.name !== 'T_COMMENT' && m.name !== 'T_DOC_COMMENT') return;
    const header = firstCode < 0 || i < firstCode;
    const hit = KNOWN.some((r) => r.test(m.text)) || (header && HEADER.some((r) => r.test(m.text))) || NOISE.test(m.text.trim());
    if (!hit) return;
    // ardından gelen satır sonu da gider (satır yorumu kendi satır sonunu içerir)
    let end = m.start + m.text.length;
    const next = marks[i + 1];
    if (!m.text.endsWith('\n') && next?.name === 'T_WHITESPACE' && /^[ \t]*\r?\n/.test(next.text)) end += /^[ \t]*\r?\n/.exec(next.text)[0].length;
    edits.push([m.start, end]);
  });
  if (!edits.length) return code;
  let out = '';
  let last = 0;
  for (const [s, e] of edits) { out += code.slice(last, s); last = e; }
  out += code.slice(last);
  ctx.log(`banner: ${edits.length} encoder yorumu kaldırıldı`, 'info');
  ctx.bump('banner', edits.length);
  return out;
}
