// PHP değerleri: serialize() çıktısını okuma ve değeri PHP literali olarak yazma. Dizgeler bstr'dir.

/** serialize() çıktısı → JS değeri. Desteklenmeyen (nesne, referans) için undefined. */
export function unserialize(s) {
  let i = 0;
  const readUntil = (ch) => { const j = s.indexOf(ch, i); if (j < 0) throw new Error('bozuk'); const v = s.slice(i, j); i = j + 1; return v; };
  function value() {
    const t = s[i];
    i += 2; // "x:"
    switch (t) {
      case 'N': return null; // "N;"
      case 'b': return readUntil(';') === '1';
      case 'i': return { int: BigInt(readUntil(';')) };
      case 'd': { const v = readUntil(';'); return { float: v === 'INF' ? Infinity : v === '-INF' ? -Infinity : v === 'NAN' ? NaN : Number(v) }; }
      case 's': {
        const len = Number(readUntil(':'));
        i += 1; // "
        const v = s.slice(i, i + len);
        i += len + 2; // ";
        return v;
      }
      case 'a': {
        const n = Number(readUntil(':'));
        i += 1; // {
        const entries = [];
        for (let k = 0; k < n; k++) entries.push([value(), value()]);
        i += 1; // }
        return { array: entries };
      }
      default: throw new Error(`desteklenmeyen tür ${t}`);
    }
  }
  try {
    const v = value();
    return i === s.length ? v : undefined;
  } catch {
    return undefined;
  }
}

const printable = (c) => c >= 0x20 && c < 0x7f;

// Geçerli UTF-8 çok baytlı dizileri olduğu gibi bırakılabilir (çıktıda okunur karakter olur)
function utf8Len(s, i) {
  const c = s.charCodeAt(i);
  const n = c >= 0xf0 && c < 0xf5 ? 4 : c >= 0xe0 ? 3 : c >= 0xc2 && c < 0xe0 ? 2 : 0;
  if (!n || i + n > s.length) return 0;
  for (let k = 1; k < n; k++) { const d = s.charCodeAt(i + k); if (d < 0x80 || d > 0xbf) return 0; }
  return n;
}

/** bstr → PHP dizge literali: düz metin tek tırnakla, kontrol/ikili bayt içeren çift tırnak + kaçış ile */
export function phpString(s) {
  let plain = true;
  // gerçek çok satırlı metin (3+ satır sonu) tek tırnakta okunur kalır; "satır\n" gibi kısa metin "\n" kaçışıyla yazılır
  const multiline = (s.match(/\n/g) ?? []).length >= 3;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (printable(c)) continue;
    const n = c >= 0x80 ? utf8Len(s, i) : 0;
    if (n) { i += n - 1; continue; }
    if (c === 0x0a && multiline) continue;
    plain = false;
    break;
  }
  if (plain) return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const ch = s[i];
    if (ch === '\\') out += '\\\\';
    else if (ch === '"') out += '\\"';
    else if (ch === '$') out += '\\$';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (printable(c)) out += ch;
    else {
      const n = c >= 0x80 ? utf8Len(s, i) : 0;
      if (n) { out += s.slice(i, i + n); i += n - 1; } else out += `\\x${c.toString(16).padStart(2, '0')}`;
    }
  }
  return `${out}"`;
}

/** unserialize() sonucu → PHP literali; yazılamazsa null. Negatif sayılar parantezlenir (a - -1 güvenliği). */
export function phpLiteral(v, { shortArray = true } = {}) {
  if (v === null) return 'null';
  if (v === true) return 'true';
  if (v === false) return 'false';
  if (typeof v === 'string') return phpString(v);
  if (v && typeof v === 'object') {
    if ('int' in v) return v.int < 0n ? `(${v.int})` : String(v.int);
    if ('float' in v) {
      const f = v.float;
      if (!Number.isFinite(f)) return Number.isNaN(f) ? 'NAN' : f > 0 ? 'INF' : '(-INF)';
      let t = String(f);
      if (!/[.eE]/.test(t)) t += '.0';
      return f < 0 || Object.is(f, -0) ? `(${t})` : t;
    }
    if ('array' in v) {
      const parts = [];
      let next = 0n;
      for (const [k, val] of v.array) {
        const lit = phpLiteral(val, { shortArray });
        if (lit === null) return null;
        // ardışık 0..n anahtarları yazılmaz
        if (k && typeof k === 'object' && 'int' in k && k.int === next) { parts.push(lit); next++; continue; }
        next = -1n;
        parts.push(`${phpLiteral(k)} => ${lit}`);
      }
      return shortArray ? `[${parts.join(', ')}]` : `array(${parts.join(', ')})`;
    }
  }
  return null;
}
