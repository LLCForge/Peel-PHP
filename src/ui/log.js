const el = document.getElementById('log');
const MAX = 400;
const LEVELS = new Set(['info', 'warn', 'err', 'ok']);

export function log(msg, level = 'info') {
  const row = document.createElement('div');
  row.className = `l ${LEVELS.has(level) ? level : level === 'error' ? 'err' : 'info'}`;
  const time = document.createElement('span');
  time.className = 't';
  time.textContent = new Date().toLocaleTimeString('tr-TR');
  const text = document.createElement('span');
  text.className = 'm';
  text.textContent = msg;
  row.append(time, text);
  el.appendChild(row);
  while (el.childElementCount > MAX) el.firstElementChild.remove();
  el.scrollTop = el.scrollHeight;
}

export function clearLog() { el.textContent = ''; }

export function toggleLog(force) {
  el.hidden = force === undefined ? !el.hidden : !force;
  return !el.hidden;
}
