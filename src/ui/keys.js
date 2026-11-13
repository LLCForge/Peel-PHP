// Kısayol dizgeleri: "Ctrl+Shift+P", "Alt+ArrowLeft", "F2". Mac'te Cmd, Ctrl yerine geçer.

const MOD_ORDER = ['Ctrl', 'Alt', 'Shift'];
const NAMES = { ' ': 'Space', Esc: 'Escape', Del: 'Delete', Left: 'ArrowLeft', Right: 'ArrowRight', Up: 'ArrowUp', Down: 'ArrowDown', '+': '=' };

export function eventToKey(e, isMac = false) {
  if (['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'Dead', 'Unidentified'].includes(e.key)) return null;
  const parts = [];
  if (isMac ? e.metaKey : e.ctrlKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  let key = NAMES[e.key] ?? e.key;
  // Shift ve Alt basılıyken e.key değişir ('?' ya da 'π'): fiziksel tuşa dön
  if (/^Key[A-Z]$/.test(e.code ?? '')) key = e.code.slice(3);
  else if (/^Digit\d$/.test(e.code ?? '')) key = e.code.slice(5);
  else if (e.code === 'Slash') key = '/';
  else if (e.code === 'Period') key = '.';
  else if (e.code === 'Comma') key = ',';
  else if (e.code === 'Equal' || e.code === 'NumpadAdd') key = '=';
  else if (e.code === 'Minus' || e.code === 'NumpadSubtract') key = '-';
  if (e.shiftKey) parts.push('Shift');
  if (key.length === 1) key = key.toUpperCase();
  parts.push(key);
  return parts.join('+');
}

/** Elle yazılmış kısayolu normalize eder ("shift+ctrl+p" → "Ctrl+Shift+P"); geçersizse null */
export function normalizeKey(s) {
  const parts = String(s).split('+').map((x) => x.trim()).filter(Boolean);
  if (!parts.length) return null;
  const mods = new Set();
  let key = null;
  for (const p of parts) {
    const low = p.toLowerCase();
    if (low === 'ctrl' || low === 'cmd' || low === 'mod' || low === 'meta') mods.add('Ctrl');
    else if (low === 'alt' || low === 'option') mods.add('Alt');
    else if (low === 'shift') mods.add('Shift');
    else if (key) return null;
    else key = NAMES[p] ?? (p.length === 1 ? p.toUpperCase() : p[0].toUpperCase() + p.slice(1));
  }
  if (!key) return null;
  return [...MOD_ORDER.filter((m) => mods.has(m)), key].join('+');
}

/** Ekranda gösterim: Mac'te ⌘ ⌥ ⇧ */
export function displayKey(k, isMac = false) {
  if (!k) return '';
  if (!isMac) return k.replace('Arrow', '');
  return k.replace('Ctrl+', '⌘').replace('Alt+', '⌥').replace('Shift+', '⇧').replace('Arrow', '');
}

/** Bulanık eşleşme puanı (komut paleti): eşleşmezse -1 */
export function fuzzyScore(query, text) {
  const q = query.toLowerCase().replace(/\s+/g, '');
  const s = text.toLowerCase();
  if (!q) return 0;
  let score = 0;
  let si = 0;
  let prev = -2;
  for (const ch of q) {
    const i = s.indexOf(ch, si);
    if (i < 0) return -1;
    score += i === prev + 1 ? 5 : 1;
    if (i === 0 || /[\s\-·/:.(]/.test(s[i - 1])) score += 3;
    prev = i;
    si = i + 1;
  }
  return score - s.length * 0.01;
}
