import { t } from '../i18n.js';

// LCS tablosu n*m hücre: büyük dosyada belleği patlatmasın (ortak önek/sonek bu sınırın dışında)
const MAX_CELLS = 4_000_000;
const ROW_H = 20;

function lcs(a, b) {
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push(['same', a[i]]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push(['del', a[i]]); i++; }
    else { out.push(['add', b[j]]); j++; }
  }
  while (i < n) out.push(['del', a[i++]]);
  while (j < m) out.push(['add', b[j++]]);
  return out;
}

/**
 * Satır farkı: [['same'|'add'|'del', text], ...]. Ortak önek ve sonek LCS'e girmez.
 * Orta bölüm sınırı aşarsa null döner.
 */
export function lineDiff(a, b) {
  const left = a.split('\n');
  const right = b.split('\n');
  let p = 0;
  while (p < left.length && p < right.length && left[p] === right[p]) p++;
  let s = 0;
  while (s < left.length - p && s < right.length - p && left[left.length - 1 - s] === right[right.length - 1 - s]) s++;
  const midA = left.slice(p, left.length - s);
  const midB = right.slice(p, right.length - s);
  if (midA.length * midB.length > MAX_CELLS) return null;
  return [
    ...left.slice(0, p).map((x) => ['same', x]),
    ...lcs(midA, midB),
    ...left.slice(left.length - s).map((x) => ['same', x]),
  ];
}

/** Fark özeti: eklenen/silinen satır sayısı */
export function diffStats(rows) {
  let add = 0;
  let del = 0;
  for (const [k] of rows ?? []) { if (k === 'add') add++; else if (k === 'del') del++; }
  return { add, del };
}

/** Yalnızca değişen satırlar ve çevresindeki `context` satır (adım onayı ve önizleme için) */
export function compactDiff(rows, context = 2) {
  // özgün satır numaraları korunur: [tür, metin, satırNo]
  let ln = 0;
  rows = rows.map(([k, x]) => [k, x, k === 'del' ? 0 : ++ln]);
  const keep = new Uint8Array(rows.length);
  rows.forEach(([k], i) => {
    if (k === 'same') return;
    for (let j = Math.max(0, i - context); j <= Math.min(rows.length - 1, i + context); j++) keep[j] = 1;
  });
  const out = [];
  let gap = false;
  rows.forEach((r, i) => {
    if (keep[i]) { out.push(r); gap = false; } else if (!gap) { out.push(['gap', '']); gap = true; }
  });
  return out;
}

const cleanups = new WeakMap();

// Sanal liste: yalnızca görünen satırlar DOM'da (büyük farklar için)
export function renderRows(el, rows) {
  const host = document.createElement('div');
  host.className = 'diff-rows';
  host.style.height = `${rows.length * ROW_H}px`;
  el.appendChild(host);
  const lineNo = new Int32Array(rows.length);
  let ln = 1;
  rows.forEach(([k, , n], i) => { lineNo[i] = n ?? (k === 'del' || k === 'gap' ? 0 : ln++); });
  let first = -1;
  let last = -1;
  const draw = () => {
    const top = Math.max(0, el.scrollTop - host.offsetTop);
    const a = Math.max(0, Math.floor(top / ROW_H) - 20);
    const b = Math.min(rows.length, Math.ceil((top + el.clientHeight) / ROW_H) + 20);
    if (a === first && b === last) return;
    first = a;
    last = b;
    const frag = document.createDocumentFragment();
    for (let i = a; i < b; i++) {
      const [kind, text] = rows[i];
      const r = document.createElement('div');
      r.className = kind === 'same' ? 'row' : `row ${kind}`;
      r.style.top = `${i * ROW_H}px`;
      const n = document.createElement('span');
      n.className = 'n';
      n.textContent = lineNo[i] ? String(lineNo[i]) : kind === 'gap' ? '⋯' : '';
      const sign = document.createElement('span');
      sign.className = 's';
      sign.textContent = kind === 'add' ? '+' : kind === 'del' ? '−' : '';
      const c = document.createElement('span');
      c.className = 'c';
      c.textContent = text;
      r.append(n, sign, c);
      frag.appendChild(r);
    }
    host.replaceChildren(frag);
  };
  cleanups.get(el)?.();
  const ro = new ResizeObserver(draw);
  el.addEventListener('scroll', draw, { passive: true });
  ro.observe(el);
  cleanups.set(el, () => { el.removeEventListener('scroll', draw); ro.disconnect(); });
  draw();
}

export function renderDiff(el, a, b) {
  el.textContent = '';
  const rows = lineDiff(a, b);
  const h = document.createElement('div');
  h.className = 'hdr';
  if (!rows) {
    h.textContent = t('diff.header');
    el.appendChild(h);
    const msg = document.createElement('p');
    msg.className = 'placeholder';
    msg.textContent = t('diff.tooBig', { a: a.split('\n').length, b: b.split('\n').length });
    el.appendChild(msg);
    return;
  }
  const { add, del } = diffStats(rows);
  h.textContent = `${t('diff.header')} · +${add} −${del}`;
  el.appendChild(h);
  renderRows(el, rows);
}
