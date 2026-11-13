import { t } from '../i18n.js';
import { createEditor } from './editor.js';

const MAX_SNAPSHOTS = 80;

// Her kabul edilen pass sonrası kodun anlık görüntüsü; kaydırıcıyla ileri geri sarılır.
// Kod salt okunur editörde gösterilir (büyük dosyada yalnızca görünen satırlar çizilir).
export function createTimeline(el, { viewConfig = {} } = {}) {
  let snaps = [];
  let index = 0;
  let editor = null;
  let cfg = viewConfig;
  let showFn = null;

  function render() {
    el.textContent = '';
    editor = null;
    showFn = null;
    if (!snaps.length) {
      const p = document.createElement('p');
      p.className = 'placeholder';
      p.textContent = t('timeline.empty');
      el.appendChild(p);
      return;
    }
    const bar = document.createElement('div');
    bar.className = 'tl-bar';
    const prev = document.createElement('button');
    prev.type = 'button';
    prev.className = 'tiny';
    prev.textContent = '‹';
    prev.setAttribute('aria-label', t('timeline.prev'));
    const next = document.createElement('button');
    next.type = 'button';
    next.className = 'tiny';
    next.textContent = '›';
    next.setAttribute('aria-label', t('timeline.next'));
    const range = document.createElement('input');
    range.type = 'range';
    range.min = '0';
    range.max = String(snaps.length - 1);
    range.value = String(index);
    range.setAttribute('aria-label', t('tab.timeline'));
    const label = document.createElement('span');
    label.className = 'tl-label';
    label.setAttribute('aria-live', 'polite');
    const host = document.createElement('div');
    host.className = 'tl-code';
    editor = createEditor(host, { readOnly: true, label: t('tab.timeline') });
    editor.configure({ ...cfg, minimap: false });

    const show = (i) => {
      index = Math.max(0, Math.min(snaps.length - 1, i));
      range.value = String(index);
      const s = snaps[index];
      label.textContent = `${t('timeline.step', { i: index + 1, n: snaps.length })} · `;
      const name = document.createElement('b');
      name.textContent = s.id;
      label.append(name, s.round ? ` · ${t('timeline.round', { r: s.round })}` : '');
      editor.setState(editor.createState(s.code));
      prev.disabled = index === 0;
      next.disabled = index === snaps.length - 1;
    };
    showFn = show;
    range.addEventListener('input', () => show(Number(range.value)));
    prev.addEventListener('click', () => show(index - 1));
    next.addEventListener('click', () => show(index + 1));
    bar.append(prev, range, next, label);
    el.append(bar, host);
    show(index);
  }

  return {
    reset() { snaps = []; index = 0; render(); },
    push(s) { if (snaps.length < MAX_SNAPSHOTS) snaps.push(s); },
    finish() { index = Math.max(0, snaps.length - 1); render(); },
    /** Dışarıdan belirli bir adıma git (ısı haritasından) */
    show(i) { index = i; if (showFn) showFn(i); else render(); },
    load(list) { snaps = list.slice(0, MAX_SNAPSHOTS); index = Math.max(0, snaps.length - 1); render(); },
    get snapshots() { return snaps; },
    configure(next) { cfg = { ...cfg, ...next }; editor?.configure({ ...cfg, minimap: false }); },
    render,
  };
}
