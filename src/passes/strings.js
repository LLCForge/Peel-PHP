// Okunmaz dizgeler (sandbox gerektirmez, fold'un dokunmadığı yerler dahil): \x / sekizli / \u{} kaçışlı çift tırnaklı
// dizgeler okunur literal olur (sınıf sabiti, varsayılan parametre, static başlatıcı içinde de); değişken içeren çift
// tırnaklı dizgelerin ("\x65\166 $i\xa") düz metin parçaları okunur kaçışlarla yeniden yazılır; chr(sayı) ve
// literal dizge birleştirmeleri ('a' . 'b') statik olarak katlanır.
import { tryParse, walk, span, applyEdits } from '../core/parse.js';
import { phpString } from '../core/values.js';

export const id = 'strings';

// gizleme kaçışları: \x, sekizli, \u{}, \e \v \f (yalnızca \n \t gibi olağan kaçışlar varsa dokunulmaz)
const OBSCURE = /\\(x[0-9A-Fa-f]|[0-7]|u\{|e|v|f)/;
const SIMPLE = { n: '\n', t: '\t', r: '\r', v: '\v', e: '\x1b', f: '\f', '\\': '\\', $: '$', '"': '"' };

const utf8 = (cp) => {
  if (cp < 0x80) return String.fromCharCode(cp);
  if (cp < 0x800) return String.fromCharCode(0xc0 | (cp >> 6), 0x80 | (cp & 63));
  if (cp < 0x10000) return String.fromCharCode(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
  return String.fromCharCode(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
};

/** Çift tırnaklı dizge gövdesinin (değişkensiz parça) PHP kurallarıyla çözülmesi → bstr; çözülemezse null */
export function decodeDq(raw) {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch !== '\\' || i + 1 >= raw.length) { out += ch; continue; }
    const n = raw[i + 1];
    if (n in SIMPLE) { out += SIMPLE[n]; i++; continue; }
    let m = /^[0-7]{1,3}/.exec(raw.slice(i + 1, i + 4));
    if (m) { out += String.fromCharCode(parseInt(m[0], 8) & 0xff); i += m[0].length; continue; }
    m = /^x([0-9A-Fa-f]{1,2})/.exec(raw.slice(i + 1, i + 4));
    if (m) { out += String.fromCharCode(parseInt(m[1], 16)); i += m[0].length; continue; }
    m = /^u\{([0-9A-Fa-f]+)\}/.exec(raw.slice(i + 1, i + 12));
    if (m) {
      const cp = parseInt(m[1], 16);
      if (cp > 0x10ffff) return null;
      out += utf8(cp);
      i += m[0].length;
      continue;
    }
    out += ch; // bilinmeyen kaçış: ters eğik çizgi kalır
  }
  return out;
}

// değişken içeren çift tırnaklı dizgenin düz parçası: okunur kaçışlarla (${, {$ ve "$ad" yorumlanmasın diye $ hep kaçışlı)
function encodeDqPart(s, inHeredoc) {
  const lit = phpString(s);
  let body;
  if (lit.startsWith("'")) {
    body = lit.slice(1, -1).replace(/\\'/g, "'").replace(/\\\\/g, '\\');
    body = body.replace(/\\/g, '\\\\').replace(/\$/g, '\\$').replace(/\n/g, inHeredoc ? '\n' : '\\n');
    if (!inHeredoc) body = body.replace(/"/g, '\\"');
  } else {
    body = lit.slice(1, -1);
    if (inHeredoc) body = body.replace(/\\"/g, '"').replace(/\\n/g, '\n');
  }
  return body;
}

// satır sonu içeren düz metin "\n" kaçışıyla tek satırda kalır ('bucket zero\n' iki satıra bölünmesin)
const literal = (v) => {
  const l = phpString(v);
  if (!l.startsWith("'") || !v.includes('\n')) return l;
  return `"${v.replace(/[\\"$]/g, (c) => `\\${c}`).replace(/\n/g, '\\n')}"`;
};

const isStr = (n) => n?.kind === 'string';
const callName = (n) => (n.kind === 'call' && n.what?.kind === 'name' ? String(n.what.name).replace(/^\\/, '').toLowerCase() : null);

export async function run(code, ctx) {
  const parsed = tryParse(code);
  if (!parsed) return code;
  const edits = [];
  // statik değer: literal dizge, chr(tamsayı) ya da bunların birleştirmesi
  const value = (node) => {
    if (isStr(node)) {
      if (!node.isDoubleQuote) return node.value;
      const [s, e] = span(node);
      return decodeDq(code.slice(s + 1, e - 1));
    }
    if (node.kind === 'parenthesis') return value(node.inner);
    if (callName(node) === 'chr' && node.arguments.length === 1 && node.arguments[0].kind === 'number' && /^\d+$/.test(node.arguments[0].value)) {
      return String.fromCharCode(Number(node.arguments[0].value) % 256);
    }
    if (node.kind === 'bin' && node.type === '.') {
      const l = value(node.left);
      const r = l === null ? null : value(node.right);
      return l === null || r === null ? null : l + r;
    }
    return null;
  };
  // dönüştürmeye değer mi: gizleme kaçışı, chr() ya da birleştirme içeriyor
  const obscure = (node) => {
    if (isStr(node)) return node.isDoubleQuote && OBSCURE.test(code.slice(...span(node)));
    if (node.kind === 'parenthesis') return obscure(node.inner);
    return node.kind === 'call' || node.kind === 'bin';
  };
  walk(parsed.ast, (node, parent, key) => {
    // atama hedefi ve list() içi yazılmaz
    if (key === 'left' && parent?.kind === 'assign') return true;
    if (isStr(node) || node.kind === 'call' || (node.kind === 'bin' && node.type === '.') || node.kind === 'parenthesis') {
      const v = obscure(node) ? value(node) : null;
      if (v === null || v === undefined) return true;
      const lit = literal(v);
      const [s, e] = span(node);
      if (code.slice(s, e) !== lit) edits.push({ start: s, end: e, text: lit });
      return false;
    }
    if (node.kind === 'encapsed' && (node.type === 'string' || node.type === 'heredoc')) {
      const heredoc = node.type === 'heredoc';
      for (const part of node.value) {
        if (part.kind !== 'encapsedpart' || !isStr(part.expression) || !part.loc) continue;
        const [s, e] = span(part);
        const raw = code.slice(s, e);
        if (!OBSCURE.test(raw)) continue;
        const dec = decodeDq(raw);
        if (dec === null) continue;
        // sondaki "{" ardından gelen "$ad" ile "{$" karmaşık sözdizimine dönüşmesin
        const text = encodeDqPart(dec, heredoc).replace(/\{$/, '\\x7b');
        if (text === raw) continue;
        edits.push({ start: s, end: e, text });
      }
      return false;
    }
    return true;
  });
  if (!edits.length) return code;
  const r = applyEdits(code, edits);
  ctx.log(`strings: ${r.applied} okunmaz dizge okunur yazıldı`, 'info');
  ctx.bump('strings', r.applied);
  return r.code;
}
