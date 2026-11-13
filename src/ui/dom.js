import { t } from '../i18n.js';

// Küçük DOM yardımcıları. Metin her zaman textContent/append ile girer; HTML dizgesi hiç kullanılmaz.

/** h('button', { class: 'tiny', onclick: fn, 'aria-label': 'x' }, 'metin', childNode) */
export function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'value') node.value = v;
    else if (k === 'checked' || k === 'disabled' || k === 'hidden' || k === 'selected') node[k] = Boolean(v);
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) if (c != null && c !== false) node.append(c);
  return node;
}

const live = document.createElement('div');
live.className = 'sr-only';
live.setAttribute('aria-live', 'polite');
live.setAttribute('role', 'status');
document.body.appendChild(live);

/** Ekran okuyucuya duyuru (görsel değişiklik olmadan) */
export function announce(msg) {
  live.textContent = '';
  setTimeout(() => { live.textContent = msg; }, 30);
}

const toastHost = h('div', { class: 'toasts', 'aria-live': 'polite' });
document.body.appendChild(toastHost);

export function toast(msg, kind = 'info', ms = 3200) {
  const el = h('div', { class: `toast ${kind}`, role: kind === 'err' ? 'alert' : 'status' }, msg);
  toastHost.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

/**
 * Modal pencere: yerel <dialog> odak tuzağı ve Escape ile kapanma sağlar.
 * build(close) gövde düğümünü döner; close(value) promise'i çözer.
 */
export function modal(title, build, { wide = false, className = '' } = {}) {
  return new Promise((resolve) => {
    const prev = document.activeElement;
    const id = `dlg-${Math.random().toString(36).slice(2, 8)}`;
    const dlg = h('dialog', { class: `dlg ${wide ? 'wide' : ''} ${className}`, 'aria-labelledby': id });
    let done = false;
    const close = (value) => {
      if (done) return;
      done = true;
      dlg.close();
      dlg.remove();
      if (prev && typeof prev.focus === 'function') prev.focus();
      resolve(value);
    };
    const head = h('div', { class: 'dlg-head' },
      h('h2', { id }, title),
      h('button', { type: 'button', class: 'tiny dlg-x', 'aria-label': t('ui.close'), onclick: () => close(undefined) }, '✕'));
    dlg.append(head, build(close));
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(undefined); });
    dlg.addEventListener('click', (e) => { if (e.target === dlg) close(undefined); });
    document.body.appendChild(dlg);
    dlg.showModal();
    const first = dlg.querySelector('[autofocus]') ?? dlg.querySelector('input, select, textarea, button:not(.dlg-x)');
    first?.focus();
  });
}

export function promptText(title, { label, value = '', multiline = false, validate = () => null } = {}) {
  return modal(title, (close) => {
    const field = multiline
      ? h('textarea', { class: 'field', rows: '5', autofocus: true, 'aria-label': label ?? title }, value)
      : h('input', { class: 'field', type: 'text', value, autofocus: true, spellcheck: 'false', 'aria-label': label ?? title });
    if (multiline) field.value = value;
    const err = h('p', { class: 'dlg-err', role: 'alert' });
    const submit = (e) => {
      e?.preventDefault();
      const msg = validate(field.value);
      if (msg) { err.textContent = msg; field.setAttribute('aria-invalid', 'true'); return; }
      close(field.value);
    };
    const form = h('form', { class: 'dlg-body', onsubmit: submit },
      label ? h('label', { class: 'dlg-label' }, label, field) : field, err,
      h('div', { class: 'dlg-actions' },
        h('button', { type: 'button', class: 'ghost', onclick: () => close(undefined) }, t('ui.cancel')),
        h('button', { type: 'submit', class: 'ghost accent' }, t('ui.ok'))));
    if (multiline) field.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submit(e); });
    setTimeout(() => { if (!multiline) field.select(); }, 0);
    return form;
  });
}

export function confirmDialog(title, body, { ok = t('ui.ok'), danger = false } = {}) {
  return modal(title, (close) => h('div', { class: 'dlg-body' },
    typeof body === 'string' ? h('p', {}, body) : body,
    h('div', { class: 'dlg-actions' },
      h('button', { type: 'button', class: 'ghost', onclick: () => close(false) }, t('ui.cancel')),
      h('button', { type: 'button', class: `ghost ${danger ? 'danger' : 'accent'}`, autofocus: true, onclick: () => close(true) }, ok))));
}

/**
 * Bağlam menüsü: role=menu, ok tuşlarıyla gezinme, Escape ile kapanır.
 * items: [{label, key?, run, disabled?} | 'sep']
 */
export function contextMenu(x, y, items) {
  document.querySelector('.ctx-menu')?.remove();
  const prev = document.activeElement;
  const menu = h('div', { class: 'ctx-menu', role: 'menu' });
  const buttons = [];
  for (const it of items) {
    if (it === 'sep') { menu.append(h('div', { class: 'ctx-sep', role: 'separator' })); continue; }
    const b = h('button', { type: 'button', role: 'menuitem', tabindex: '-1', disabled: it.disabled },
      h('span', {}, it.label), it.key ? h('kbd', {}, it.key) : null);
    b.addEventListener('click', () => { close(); it.run(); });
    buttons.push(b);
    menu.append(b);
  }
  const close = () => {
    menu.remove();
    document.removeEventListener('pointerdown', outside, true);
    if (prev && document.contains(prev)) prev.focus();
  };
  const outside = (e) => { if (!menu.contains(e.target)) close(); };
  menu.addEventListener('keydown', (e) => {
    const enabled = buttons.filter((b) => !b.disabled);
    const i = enabled.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      enabled[(i + (e.key === 'ArrowDown' ? 1 : -1) + enabled.length) % enabled.length]?.focus();
    } else if (e.key === 'Home') { e.preventDefault(); enabled[0]?.focus(); } else if (e.key === 'End') { e.preventDefault(); enabled[enabled.length - 1]?.focus(); } else if (e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); close(); }
  });
  document.body.appendChild(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(4, Math.min(x, innerWidth - r.width - 4))}px`;
  menu.style.top = `${Math.max(4, Math.min(y, innerHeight - r.height - 4))}px`;
  setTimeout(() => document.addEventListener('pointerdown', outside, true), 0);
  buttons.find((b) => !b.disabled)?.focus();
}

export function download(name, data, type) {
  const url = URL.createObjectURL(data instanceof Blob ? data : new Blob([data], { type }));
  const a = h('a', { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Bir sonuç listesini CSV'ye çevirir (formül enjeksiyonuna karşı = + - @ ile başlayan hücreler kaçırılır) */
export function toCsv(rows, columns) {
  const cell = (v) => {
    let s = String(v ?? '');
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // SECURITY FIX: CWE-1236 CSV formül enjeksiyonu
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.join(','), ...rows.map((r) => columns.map((c) => cell(r[c])).join(','))].join('\r\n');
}
