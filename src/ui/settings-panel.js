import { t, getLang, setLang, LANGS } from '../i18n.js';
import { h, modal } from './dom.js';
import { settings, update, resetSettings } from './settings.js';
import { openShortcuts } from './commands.js';

// Ayarlar penceresi: görünüm, editör, çıktı biçimi, dil, gizlilik. Her değişiklik anında uygulanır.

const field = (label, control, hint) => h('label', { class: 'set-row' }, h('span', { class: 'set-label' }, label, hint ? h('small', {}, hint) : null), control);

const read = (key, path) => (path ? settings()[path][key] : settings()[key]);
const write = (key, v, path) => update(path ? { [path]: { [key]: v } } : { [key]: v });

function select(key, options) {
  const el = h('select', { class: 'field small' }, options.map(([v, label]) => h('option', { value: String(v), selected: String(v) === String(read(key)) }, label)));
  el.addEventListener('change', () => write(key, el.value));
  return el;
}
function toggle(key, path = null) {
  const el = h('input', { type: 'checkbox', checked: read(key, path) });
  el.addEventListener('change', () => write(key, el.checked, path));
  return el;
}
function number(key, min, max, path = null) {
  const el = h('input', { class: 'field small num', type: 'number', min: String(min), max: String(max), value: String(read(key, path)) });
  el.addEventListener('change', () => {
    const v = Math.max(min, Math.min(max, Number(el.value) || min));
    el.value = String(v);
    write(key, v, path);
  });
  return el;
}

export function openSettings({ onClearSession } = {}) {
  return modal(t('settings.title'), (close) => {
    const lang = h('select', { class: 'field small' }, LANGS.map(([v, label]) => h('option', { value: v, selected: v === getLang() }, label)));
    lang.addEventListener('change', () => setLang(lang.value));
    const section = (title, ...rows) => h('fieldset', { class: 'set-group' }, h('legend', {}, title), ...rows);
    return h('div', { class: 'dlg-body settings' },
      section(t('settings.appearance'),
        field(t('settings.lang'), lang),
        field(t('settings.theme'), select('theme', ['dark', 'light', 'contrast', 'system'].map((v) => [v, t(`settings.theme.${v}`)]))),
        field(t('settings.palette'), select('palette', ['default', 'deutan', 'protan', 'tritan'].map((v) => [v, t(`settings.palette.${v}`)])), t('settings.palette.hint')),
        field(t('settings.fontSize'), number('fontSize', 9, 32)),
        field(t('settings.ligatures'), toggle('ligatures'), t('settings.ligatures.hint'))),
      section(t('settings.editor'),
        field(t('settings.wrap'), toggle('wrap')),
        field(t('settings.invisibles'), toggle('invisibles')),
        field(t('settings.minimap'), toggle('minimap')),
        field(t('settings.indentGuides'), toggle('indentGuides')),
        field(t('settings.activeLine'), toggle('activeLine')),
        field(t('settings.syncScroll'), toggle('syncScroll')),
        field(t('settings.reading'), toggle('reading'))),
      section(t('settings.format'),
        field(t('settings.format.enabled'), toggle('enabled', 'format'), t('settings.format.enabled.hint')),
        field(t('settings.format.printWidth'), number('printWidth', 40, 240, 'format')),
        field(t('settings.format.tabWidth'), number('tabWidth', 1, 8, 'format')),
        field(t('settings.format.useTabs'), toggle('useTabs', 'format')),
        field(t('settings.format.singleQuote'), toggle('singleQuote', 'format')),
        h('p', { class: 'rep-muted small' }, t('settings.format.hint'))),
      section(t('settings.privacy'),
        field(t('settings.persist'), toggle('persist'), t('settings.persist.hint')),
        h('div', { class: 'row' }, h('button', { type: 'button', class: 'ghost small danger', onclick: () => onClearSession?.() }, t('settings.clearSession')))),
      h('div', { class: 'dlg-actions' },
        h('button', { type: 'button', class: 'ghost', onclick: () => { close(); openShortcuts(); } }, t('settings.shortcuts')),
        h('button', { type: 'button', class: 'ghost', onclick: () => { resetSettings(); close(); openSettings({ onClearSession }); } }, t('settings.reset')),
        h('button', { type: 'button', class: 'ghost accent', onclick: () => close() }, t('ui.done'))));
  }, { wide: true });
}
