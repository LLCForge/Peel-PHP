import { t } from '../i18n.js';
import { h, modal } from './dom.js';
import { eventToKey, normalizeKey, displayKey, fuzzyScore } from './keys.js';
import { settings, update } from './settings.js';

// Komut kaydı, atanabilir kısayollar, komut paleti ve kısayol rehberi.

export const isMac = /Mac|iPhone|iPad/.test(navigator.platform ?? '') || /Mac OS/.test(navigator.userAgent);
const commands = new Map();

/** cmd: { id, title: () => string, run, key?: 'Ctrl+Shift+P', group?: string, when?: () => boolean } */
export function register(...list) { for (const c of list) commands.set(c.id, c); }
export const allCommands = () => [...commands.values()];
export const keyOf = (id) => { const map = settings().keymap; return Object.hasOwn(map, id) ? map[id] : commands.get(id)?.key ?? null; };
export const run = (id) => { const c = commands.get(id); if (c && (!c.when || c.when())) { c.run(); return true; } return false; };

function lookup(key) {
  for (const c of commands.values()) if (keyOf(c.id) === key) return c;
  return null;
}

let suspended = false;
/** Kısayol kaydı sırasında genel dinleyiciyi durdurur */
export const suspendKeys = (v) => { suspended = v; };

// Yakalama aşaması: editörün kendi tuş eşlemesinden önce çalışır; uygulama komutu kazanır
document.addEventListener('keydown', (e) => {
  if (suspended || e.defaultPrevented || e.isComposing) return;
  if (document.querySelector('dialog[open]') && !e.target.closest?.('.palette')) return;
  const key = eventToKey(e, isMac);
  if (!key) return;
  // yalın tuşlar (F tuşları hariç) metin alanında yazılabilir kalsın
  const plain = !/^(Ctrl|Alt)\+/.test(key) && !/^(Shift\+)?F\d+$/.test(key) && key !== 'Escape';
  const typing = e.target.closest?.('input, textarea, select, [contenteditable="true"], .cm-content');
  if (plain && typing) return;
  const c = lookup(key);
  if (!c || (c.when && !c.when())) return;
  e.preventDefault();
  e.stopPropagation();
  c.run();
}, true);

export function setKey(id, key) {
  const keymap = { ...settings().keymap, [id]: key };
  update({ keymap });
}

export function resetKeys() { update({ keymap: {} }); }

/** Komut paleti: bulanık arama; ":" satıra git, "@" sembole git, ">" komut */
export function openPalette({ gotoLine, symbols } = {}) {
  return modal(t('palette.title'), (close) => {
    const input = h('input', { class: 'field palette-input', type: 'text', autofocus: true, spellcheck: 'false', role: 'combobox', 'aria-expanded': 'true', 'aria-controls': 'palette-list', 'aria-autocomplete': 'list', placeholder: t('palette.placeholder') });
    const list = h('ul', { class: 'palette-list', id: 'palette-list', role: 'listbox', 'aria-label': t('palette.title') });
    let items = [];
    let active = 0;
    const render = () => {
      const q = input.value;
      if (q.startsWith(':') && gotoLine) {
        const n = Number(q.slice(1));
        items = Number.isInteger(n) && n > 0 ? [{ label: t('palette.gotoLine', { n }), run: () => gotoLine(n) }] : [];
      } else if (q.startsWith('@') && symbols) {
        const sq = q.slice(1);
        items = symbols().map((s) => ({ s, score: fuzzyScore(sq, s.name) })).filter((x) => x.score >= 0).sort((a, b) => b.score - a.score)
          .slice(0, 200).map(({ s }) => ({ label: s.name, hint: s.kind, run: s.go }));
      } else {
        const cq = q.replace(/^>/, '');
        items = allCommands().filter((c) => !c.when || c.when())
          .map((c) => ({ c, label: c.title(), score: fuzzyScore(cq, `${c.group ? `${t(c.group)}: ` : ''}${c.title()}`) }))
          .filter((x) => x.score >= 0).sort((a, b) => b.score - a.score)
          .map(({ c, label }) => ({ label, group: c.group ? t(c.group) : '', hint: displayKey(keyOf(c.id), isMac), run: c.run }));
      }
      active = Math.min(active, Math.max(0, items.length - 1));
      list.replaceChildren(...items.slice(0, 300).map((it, i) => {
        const li = h('li', { id: `pal-${i}`, role: 'option', 'aria-selected': String(i === active), class: i === active ? 'on' : '' },
          it.group ? h('span', { class: 'pal-group' }, it.group) : null, h('span', { class: 'pal-label' }, it.label), it.hint ? h('kbd', {}, it.hint) : null);
        li.addEventListener('pointerdown', (e) => { e.preventDefault(); choose(i); });
        return li;
      }));
      if (!items.length) list.append(h('li', { class: 'pal-empty', role: 'option', 'aria-disabled': 'true' }, t('palette.none')));
      input.setAttribute('aria-activedescendant', items.length ? `pal-${active}` : '');
      list.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
    };
    const choose = (i) => { const it = items[i]; if (!it) return; close(); setTimeout(() => it.run(), 0); };
    input.addEventListener('input', () => { active = 0; render(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(items.length - 1, active + 1); render(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(0, active - 1); render(); }
      else if (e.key === 'Enter') { e.preventDefault(); choose(active); }
    });
    render();
    return h('div', { class: 'palette' }, input, list, h('p', { class: 'pal-hint' }, t('palette.hint')));
  }, { className: 'dlg-palette' });
}

/** Kısayol rehberi + atama: her komutun kısayolu tıklanıp yeni tuşa basılarak değiştirilir */
export function openShortcuts() {
  return modal(t('shortcuts.title'), () => {
    const filter = h('input', { class: 'field', type: 'search', placeholder: t('shortcuts.filter'), 'aria-label': t('shortcuts.filter') });
    const body = h('tbody');
    const render = () => {
      const q = filter.value.toLowerCase();
      const groups = new Map();
      for (const c of allCommands()) {
        if (q && !`${c.title()} ${keyOf(c.id) ?? ''}`.toLowerCase().includes(q)) continue;
        const g = c.group ? t(c.group) : t('cmd.group.general');
        (groups.get(g) ?? groups.set(g, []).get(g)).push(c);
      }
      const rows = [];
      for (const [g, list] of groups) {
        rows.push(h('tr', { class: 'sc-group' }, h('th', { colspan: '3', scope: 'colgroup' }, g)));
        for (const c of list) {
          const key = keyOf(c.id);
          const keyBtn = h('button', { type: 'button', class: 'kbd-btn', 'aria-label': t('shortcuts.assign', { c: c.title() }) }, key ? displayKey(key, isMac) : t('shortcuts.none'));
          keyBtn.addEventListener('click', () => record(c, keyBtn));
          const clear = h('button', { type: 'button', class: 'tiny', 'aria-label': t('shortcuts.clear', { c: c.title() }), onclick: () => { setKey(c.id, null); render(); } }, '✕');
          rows.push(h('tr', {}, h('td', {}, c.title()), h('td', {}, keyBtn), h('td', {}, key ? clear : null)));
        }
      }
      body.replaceChildren(...rows);
    };
    const record = (c, btn) => {
      btn.textContent = t('shortcuts.press');
      btn.classList.add('rec');
      suspendKeys(true);
      const onKey = (e) => {
        if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;
        e.preventDefault();
        e.stopPropagation();
        window.removeEventListener('keydown', onKey, true);
        suspendKeys(false);
        if (e.key === 'Escape') { render(); return; }
        const key = normalizeKey(eventToKey(e, isMac) ?? '');
        if (key) {
          // aynı tuş başka komuttaysa oradan kaldır: çakışma bırakma
          for (const other of allCommands()) if (other.id !== c.id && keyOf(other.id) === key) setKey(other.id, null);
          setKey(c.id, key);
        }
        render();
        btn.focus();
      };
      window.addEventListener('keydown', onKey, true);
    };
    filter.addEventListener('input', render);
    render();
    return h('div', { class: 'dlg-body' }, filter,
      h('div', { class: 'sc-scroll' }, h('table', { class: 'rep-table sc-table' },
        h('thead', {}, h('tr', {}, h('th', {}, t('shortcuts.command')), h('th', {}, t('shortcuts.key')), h('th', {}, h('span', { class: 'sr-only' }, t('shortcuts.clearCol'))))), body)),
      h('div', { class: 'dlg-actions' }, h('button', { type: 'button', class: 'ghost', onclick: () => { resetKeys(); render(); } }, t('shortcuts.reset'))));
  }, { wide: true });
}
