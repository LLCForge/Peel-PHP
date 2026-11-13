// Tanımlayıcı okunurluğu: obfuscator'ların ürettiği adları (görünmez/geçersiz Unicode, O0O0 / lIl1 / ____,
// _0x.., hash benzeri onaltılık, rastgele harf dizileri) okunur adlardan ayırır. Girdi bstr'dir (UTF-8 baytları).

const strict = new TextDecoder('utf-8', { fatal: true });
const INVISIBLE = /[­͏؜ᅟᅠ឴឵᠋-᠎​-‏‪-‮⁠-⁯ㅤ︀-️﻿ﾠ]/u;
// rakam içeren olağan sözcükler (utf8, base64, md5, x2, sha256...)
const DIGIT_WORDS = /(utf|base|md|sha|crc|rot|ipv|int|uint|float|bin|hex|oct|level|h|x|y|z|v|p|i|id|col|row|tab|arg|var|item|key|str|num|tmp|temp|param|data|file|step|page|line|test)\d+/gi;

function decode(bname) {
  const bytes = Uint8Array.from(bname, (c) => c.charCodeAt(0) & 0xff);
  try { return strict.decode(bytes); } catch { return null; }
}

/** Ad (başında $ olmadan) obfuscator ürünü gibi mi görünüyor? */
export function unreadable(bname) {
  const s = decode(bname);
  if (s === null) return true; // geçersiz UTF-8 baytlar
  if (INVISIBLE.test(s)) return true;
  if (/[^\x00-\x7f]/.test(s)) return !/^[\p{L}\p{N}_]+$/u.test(s) || /^[_\p{N}]*$/u.test(s);
  const core = s.replace(/^_+|_+$/g, '');
  if (!core) return true; // _____
  if (s.length >= 4 && /^[O0Il1_]+$/.test(s) && new Set(s.replace(/_/g, '')).size >= 2) return true; // O0O0O, lIlI1
  if (/^0x[0-9a-f]+$/i.test(core)) return true; // _0x1a2b
  const hex = core.match(/[0-9a-f]{6,}/gi) ?? [];
  if (hex.some((h) => /\d.*\d/.test(h) && /[a-f]/i.test(h))) return true; // hash benzeri
  if (/^[a-z]{0,2}\d{4,}$/i.test(core)) return true; // _12345, O4369
  let bad = 0;
  if (/[a-z]\d+[a-z]/i.test(core.replace(DIGIT_WORDS, 'w'))) bad++; // harfler arasında rakam: Z9Vw
  if (/_[A-Za-z]?\d|\d_[A-Za-z]/.test(core) && core.length <= 8) bad++;
  const tokens = core.match(/[A-Z]{2,}(?![a-z])|[A-Z]?[a-z]+|[A-Z]|\d+/g) ?? [];
  const alpha = tokens.filter((t) => /^[A-Za-z]+$/.test(t));
  for (const t of alpha) {
    if (t.length >= 2 && !/[aeiouy]/i.test(t) && !(t === t.toUpperCase() && t.length <= 4) && !/^(str|len|cnt|ctx|cfg|msg|src|dst|tmp|req|res|db|fn|cb|sql|xml|html|php|rgb|px|ts|dt|tz|js|css|pdf|png|jpg|nth|mb|kb)$/i.test(t)) bad++;
  }
  const short = alpha.slice(1).filter((t) => t.length <= 2).length;
  if (short >= 2) bad++;
  const letters = core.replace(/[^A-Za-z]/g, '');
  if (letters.length >= 6 && (letters.match(/[aeiouy]/gi) ?? []).length / letters.length < 0.2) bad++;
  // büyük-küçük harf düzensizliği: küçük harften sonra tek büyük harf ve ardından tek küçük harf, birden çok kez
  if ((core.match(/[a-z][A-Z][a-z](?![a-z])/g) ?? []).length >= 2) bad++;
  // 4+ ünsüz yan yana (rastgele harf dizisi)
  if (/[bcdfghjklmnpqrstvwxz]{4,}/i.test(alpha.join(' ').replace(/(str|sch|scr|spr|spl|thr|chr|tch|ght|nch|nst|rst|ngth|mpl|nts|rts|rds|cks)/gi, 'a'))) bad++;
  return bad >= 1;
}

/**
 * Dosya düzeyinde: obfuscator'lar tüm adları aynı biçimde üretir (YAK Pro: hep 5 karakter; GLOBUS: "v"+rastgele).
 * Aynı uzunluktaki ya da aynı önek biçimindeki adların çoğu okunmazsa grubun tamamı okunmaz sayılır.
 * @param {string[]} names benzersiz adlar
 * @returns {Set<string>} okunmaz adlar
 */
export function unreadableSet(names) {
  const bad = new Set(names.filter(unreadable));
  const groups = new Map();
  const add = (k, n) => { if (!groups.has(k)) groups.set(k, []); groups.get(k).push(n); };
  for (const n of names) {
    if (/^__/.test(n)) continue;
    add(`len:${n.length}`, n);
    if (/^[a-z][A-Z]/.test(n)) add(`pre:${n[0]}`, n);
  }
  for (const [k, list] of groups) {
    const min = k.startsWith('len:') ? 4 : 3;
    if (list.length >= min && list.filter((n) => bad.has(n)).length / list.length >= 0.5) list.forEach((n) => bad.add(n));
  }
  return bad;
}
