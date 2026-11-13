// Motor içinde PHP kaynağı "bayt dizisi" (bstr) olarak tutulur: her karakter bir bayttır (0-255).
// PHP dosyaları bayt düzeyinde işler; geçersiz UTF-8, görünmez Unicode ve ikili veri bu sayede bozulmaz ve
// PHP'nin verdiği bayt konumları doğrudan dizin olarak kullanılır. Metne çevirme yalnızca girdi/çıktı sınırındadır.

const enc = new TextEncoder();
const strict = new TextDecoder('utf-8', { fatal: true });

/** Uint8Array → bstr */
export function fromBytes(bytes) {
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  return s;
}

/** bstr → Uint8Array */
export function toBytes(bstr) {
  const out = new Uint8Array(bstr.length);
  for (let i = 0; i < bstr.length; i++) out[i] = bstr.charCodeAt(i) & 0xff;
  return out;
}

/** Kullanıcı metni (UTF-16) → bstr (UTF-8 baytları) */
export const fromText = (text) => fromBytes(enc.encode(text));

/** bstr → kullanıcı metni: geçerli UTF-8 ise çözülür, değilse baytlar Latin-1 olarak gösterilir */
export function toText(bstr) {
  try {
    return strict.decode(toBytes(bstr));
  } catch {
    return bstr;
  }
}

export const isValidUtf8 = (bstr) => { try { strict.decode(toBytes(bstr)); return true; } catch { return false; } };

/** base64 → bstr */
export const fromBase64 = (b64) => (typeof atob === 'function' ? atob(b64) : Buffer.from(b64, 'base64').toString('latin1'));

/** bstr → base64 */
export const toBase64 = (bstr) => (typeof btoa === 'function' ? btoa(bstr) : Buffer.from(bstr, 'latin1').toString('base64'));
