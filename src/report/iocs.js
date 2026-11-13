// IOC çıkarımı: URL, alan adı, IP, e-posta, kripto cüzdanı, Telegram bot token/chat id, Discord webhook.
// Yanlış pozitifleri azaltmak için: base58 adresleri sağlama toplamıyla (base58check) doğrulanır, adaylar
// base64 alfabesine bitişik olamaz (kodlu blokların içinden geçen eşleşmeler atılır), zararsız alanlar ayrı tutulur.

// Zararsız ya da encoder/loader üreticisine ait alanlar: IOC listesinden çıkarılıp "benign"a yazılır
const BENIGN = ['php.net', 'w3.org', 'schema.org', 'xmlsoap.org', 'purl.org', 'apache.org', 'mozilla.org', 'example.com', 'example.org', 'example.net',
  'phpkoru.com', 'aponkral.dev', 'sourceguardian.com', 'ioncube.com', 'zend.com', 'fopo.com.ar'];
const isBenign = (host) => BENIGN.some((d) => host === d || host.endsWith(`.${d}`));
// genel barındırma alanlarında yalnızca bilinen ürün/proje adresleri zararsızdır
const BENIGN_URL = [/^https?:\/\/github\.com\/pk-fr\/yakpro-po\b/i];

// --- SHA-256 (base58check için; tarayıcıda da eşzamanlı çalışsın diye saf JS) ---
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]);

export function sha256(bytes) {
  const len = bytes.length;
  const padded = new Uint8Array(((len + 9 + 63) >> 6) << 6);
  padded.set(bytes);
  padded[len] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 4, len * 8);
  view.setUint32(padded.length - 8, Math.floor(len / 0x20000000));
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let o = 0; o < padded.length; o += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(o + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = w[i - 16] + s0 + w[i - 7] + s1;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i];
      const t2 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c));
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
  }
  const out = new Uint8Array(32);
  const ov = new DataView(out.buffer);
  h.forEach((x, i) => ov.setUint32(i * 4, x));
  return out;
}

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** base58check: son 4 bayt, ilk baytların çift SHA-256 özetinin başı olmalı. Geçerliyse sürüm baytı, değilse -1 */
export function base58check(s) {
  let n = 0n;
  for (const ch of s) {
    const v = B58.indexOf(ch);
    if (v < 0) return -1;
    n = n * 58n + BigInt(v);
  }
  const bytes = [];
  while (n > 0n) { bytes.unshift(Number(n & 0xffn)); n >>= 8n; }
  for (const ch of s) { if (ch !== '1') break; bytes.unshift(0); }
  if (bytes.length < 5) return -1;
  const body = Uint8Array.from(bytes.slice(0, -4));
  const sum = sha256(sha256(body));
  for (let i = 0; i < 4; i++) if (sum[i] !== bytes[bytes.length - 4 + i]) return -1;
  return body[0];
}

// adayın iki yanı base64/kimlik karakteri olmamalı
const bounded = (body, flags = 'g') => new RegExp(`(?<![A-Za-z0-9+/_])(?:${body})(?![A-Za-z0-9+/_])`, flags);

const RE = {
  url: /\b(?:https?|ftp):\/\/[^\s'"<>()\\{}|^`]+/gi,
  email: /(?<![\w.+-])[A-Za-z0-9._%+-]{1,64}@(?:[A-Za-z0-9-]{1,63}\.)+[A-Za-z]{2,24}\b/g,
  ip: /(?<![\d.])(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}(?![\d.])/g,
  btcLegacy: bounded('[13][1-9A-HJ-NP-Za-km-z]{25,34}'),
  btcBech32: bounded('bc1[ac-hj-np-z02-9]{11,71}'),
  eth: bounded('0x[0-9a-fA-F]{40}'),
  xmr: bounded('[48][1-9A-HJ-NP-Za-km-z]{94}'),
  trx: bounded('T[1-9A-HJ-NP-Za-km-z]{33}'),
  tgToken: /(?:(?<=bot)|(?<![\w:]))\d{8,10}:[A-Za-z0-9_-]{35}(?![\w-])/g,
  tgChat: /chat_id['"]?\s*(?:=>|=|:)\s*['"]?(-?\d{5,16})/g,
  discord: /https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+/g,
};

const hostOf = (url) => {
  const m = url.match(/^[a-z]+:\/\/(?:[^@/]*@)?(\[[^\]]+\]|[^:/?#]+)/i);
  return m ? m[1].toLowerCase().replace(/\.$/, '') : null;
};
const isIp = (h) => /^\d+\.\d+\.\d+\.\d+$/.test(h);
const boringIp = (ip) => /^(?:0\.|127\.|255\.255\.255\.255$)/.test(ip);

/**
 * @param {string[]} texts taranacak metinler (girdi, katmanlar, çıktı, sandbox yan etki argümanları)
 * @param {string[]} hosts sandbox'ın bağlanmaya çalıştığı ana makineler
 */
export function iocs(texts, hosts = []) {
  const sets = { urls: new Set(), domains: new Set(), ips: new Set(), emails: new Set(), wallets: new Set(), telegram: new Set(), discord: new Set(), benign: new Set() };
  const addHost = (h) => {
    if (!h) return;
    if (isIp(h)) { if (!boringIp(h)) sets.ips.add(h); return; }
    if (!/^[a-z0-9.-]+\.[a-z]{2,24}$/i.test(h) || h === 'localhost') return;
    (isBenign(h) ? sets.benign : sets.domains).add(h);
  };
  for (const text of texts) {
    if (!text) continue;
    for (const [u] of text.matchAll(RE.url)) {
      const url = u.replace(/[.,;:!?'")\]]+$/, '');
      const h = hostOf(url);
      if (!h) continue;
      if (BENIGN_URL.some((re) => re.test(url))) { sets.benign.add(url); continue; }
      if (isBenign(h)) sets.benign.add(h);
      else sets.urls.add(url);
      addHost(h);
    }
    for (const [u] of text.matchAll(RE.discord)) sets.discord.add(u);
    for (const [e] of text.matchAll(RE.email)) {
      const host = e.split('@')[1].toLowerCase();
      if (/\.(?:png|jpe?g|gif|svg|webp|css|js)$/i.test(host) || isBenign(host)) continue;
      sets.emails.add(e);
    }
    for (const [ip] of text.matchAll(RE.ip)) if (!boringIp(ip)) sets.ips.add(ip);
    for (const [a] of text.matchAll(RE.btcLegacy)) if ([0, 5].includes(base58check(a))) sets.wallets.add(`BTC:${a}`);
    for (const [a] of text.matchAll(RE.btcBech32)) sets.wallets.add(`BTC:${a}`);
    for (const [a] of text.matchAll(RE.eth)) if (/[a-f]/i.test(a.slice(2)) && /\d/.test(a.slice(2))) sets.wallets.add(`ETH:${a}`);
    for (const [a] of text.matchAll(RE.xmr)) sets.wallets.add(`XMR:${a}`);
    for (const [a] of text.matchAll(RE.trx)) if (base58check(a) === 0x41) sets.wallets.add(`TRX:${a}`);
    for (const [tok] of text.matchAll(RE.tgToken)) sets.telegram.add(`bot:${tok}`);
    for (const m of text.matchAll(RE.tgChat)) sets.telegram.add(`chat_id:${m[1]}`);
  }
  for (const h of hosts) addHost(String(h).replace(/^[a-z]+:\/\//i, '').split(/[:/]/)[0].toLowerCase());
  return Object.fromEntries(Object.entries(sets).map(([k, v]) => [k, [...v].sort()]));
}
