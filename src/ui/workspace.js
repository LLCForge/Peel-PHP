import { t } from '../i18n.js';
import { h, contextMenu, promptText, confirmDialog, toast, announce } from './dom.js';
import { saveSession, loadSession, clearSession, sanitizeSession } from './store.js';
import { settings } from './settings.js';
import { fromBytes, toText } from '../core/bstr.js';

// Çalışma alanı: belgeler (sekmeler), sekme grupları, dosya/klasör yükleme ve oturum kaydı.

const GROUP_COLORS = ['#9a9ed6', '#4ade80', '#60a5fa', '#ff9f43', '#f472b6', '#2dd4bf', '#a3a3a3'];
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_FILES = 500;
// klasör bırakıldığında alınan uzantılar (tek dosya seçiminde her dosya kabul edilir)
export const PHP_NAME = /\.(php\d?|phtml|phps|inc|module|tpl|txt)$/i;
let seq = 0;
const uid = (p) => `${p}${Date.now().toString(36)}${(seq++).toString(36)}`;

export function createWorkspace(app, tabbar) {
  const docs = [];
  const groups = [];
  let active = null;

  const byId = (id) => docs.find((d) => d.id === id);
  const groupOf = (id) => groups.find((g) => g.id === id);

  function newDoc({ name, input = '', raw = null, output = '', path = '', group = null } = {}) {
    const d = {
      id: uid('d'), name: name || t('ws.untitled', { n: docs.length + 1 }), path: path || name || '', group,
      input, raw, output, outRaw: null, inState: null, outState: null, marks: { in: { bookmarks: [], notes: [] }, out: { bookmarks: [], notes: [] } },
      report: null, events: [], snapshots: [], runs: [], lastStats: {},
    };
    docs.push(d);
    return d;
  }

  function newGroup(name) {
    const g = { id: uid('g'), name, color: GROUP_COLORS[groups.length % GROUP_COLORS.length], collapsed: false };
    groups.push(g);
    return g;
  }

  function add(opts, { activate = true } = {}) {
    const d = newDoc(opts);
    if (activate) switchTo(d.id);
    else render();
    app.persist();
    return d;
  }

  function switchTo(id) {
    const d = byId(id);
    if (!d || d === active) { render(); return; }
    if (active) app.stash(active);
    active = d;
    app.load(d);
    render();
    app.persist();
  }

  const pruneGroups = () => { for (const g of [...groups]) if (!docs.some((x) => x.group === g.id)) groups.splice(groups.indexOf(g), 1); };

  function close(id) {
    const i = docs.findIndex((d) => d.id === id);
    if (i < 0) return;
    const [d] = docs.splice(i, 1);
    if (!docs.length) newDoc({});
    if (d === active) { active = null; switchTo((docs[i] ?? docs[i - 1] ?? docs[0]).id); }
    pruneGroups();
    render();
    app.persist();
  }

  async function rename(id) {
    const d = byId(id);
    if (!d) return;
    const name = await promptText(t('ws.rename'), { label: t('ws.name'), value: d.name, validate: (v) => (v.trim() ? null : t('ws.name')) });
    if (name) { d.name = name.trim().slice(0, 200); render(); app.persist(); }
  }

  async function groupDialog(id) {
    const d = byId(id);
    const name = await promptText(t('ws.newGroup'), { label: t('ws.groupName'), value: '', validate: (v) => (v.trim() ? null : t('ws.groupName')) });
    if (!name) return;
    const g = newGroup(name.trim().slice(0, 120));
    if (d) d.group = g.id;
    render();
    app.persist();
  }

  function tabMenu(d, x, y) {
    contextMenu(x, y, [
      { label: t('ws.rename'), run: () => rename(d.id) },
      { label: t('ws.close'), run: () => close(d.id) },
      { label: t('ws.closeOthers'), run: () => { for (const o of docs.filter((o) => o !== d)) close(o.id); } },
      'sep',
      { label: t('ws.newGroup'), run: () => groupDialog(d.id) },
      ...groups.filter((g) => g.id !== d.group).map((g) => ({ label: t('ws.moveTo', { g: g.name }), run: () => { d.group = g.id; render(); app.persist(); } })),
      d.group ? { label: t('ws.ungroup'), run: () => { d.group = null; pruneGroups(); render(); app.persist(); } } : null,
      d.group ? { label: t('ws.runGroup'), run: () => app.runGroup(d.group) } : null,
    ].filter(Boolean));
  }

  function render() {
    const nodes = [];
    const tabFor = (d, hidden) => {
      const g = groupOf(d.group);
      const tab = h('button', {
        type: 'button', role: 'tab', class: 'doctab', id: `doctab-${d.id}`, 'aria-selected': String(d === active), tabindex: d === active ? '0' : '-1',
        title: d.path || d.name, hidden, style: g ? `--group:${g.color}` : null, 'data-id': d.id,
      }, h('span', { class: 'doctab-name' }, d.name), d.report ? h('span', { class: 'doctab-dot', 'aria-hidden': 'true' }) : null);
      tab.addEventListener('click', () => switchTo(d.id));
      tab.addEventListener('auxclick', (e) => { if (e.button === 1) close(d.id); });
      tab.addEventListener('contextmenu', (e) => { e.preventDefault(); tabMenu(d, e.clientX, e.clientY); });
      tab.addEventListener('keydown', (e) => {
        const visible = [...tabbar.querySelectorAll('.doctab:not([hidden])')];
        const i = visible.indexOf(tab);
        if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
          e.preventDefault();
          const rtl = document.documentElement.dir === 'rtl';
          const n = visible[(i + ((e.key === 'ArrowRight') !== rtl ? 1 : -1) + visible.length) % visible.length];
          switchTo(n.dataset.id);
          tabbar.querySelector(`[data-id="${CSS.escape(n.dataset.id)}"]`)?.focus();
        } else if (e.key === 'Delete') { e.preventDefault(); close(d.id); }
        else if (e.key === 'F2') { e.preventDefault(); e.stopPropagation(); rename(d.id); }
        else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) { e.preventDefault(); e.stopPropagation(); const r = tab.getBoundingClientRect(); tabMenu(d, r.left, r.bottom); }
      });
      const x = h('button', { type: 'button', class: 'doctab-x', 'aria-label': t('ws.closeTab', { n: d.name }), tabindex: '-1', hidden, onclick: () => close(d.id) }, '×');
      return [tab, x];
    };
    const seen = new Set();
    for (const d of docs) {
      if (!d.group || seen.has(d.group)) continue;
      seen.add(d.group);
      const g = groupOf(d.group);
      if (!g) { d.group = null; continue; }
      const members = docs.filter((x) => x.group === g.id);
      const chip = h('button', { type: 'button', class: 'group-chip', style: `--group:${g.color}`, 'aria-expanded': String(!g.collapsed), title: t('ws.groupToggle') },
        h('span', { class: 'group-dot', 'aria-hidden': 'true' }), g.name, h('span', { class: 'count' }, String(members.length)));
      chip.addEventListener('click', () => { g.collapsed = !g.collapsed; render(); app.persist(); });
      chip.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        contextMenu(e.clientX, e.clientY, [
          { label: t('ws.renameGroup'), run: async () => { const n = await promptText(t('ws.renameGroup'), { value: g.name, validate: (v) => (v.trim() ? null : t('ws.groupName')) }); if (n) { g.name = n.trim().slice(0, 120); render(); app.persist(); } } },
          { label: t('ws.runGroup'), run: () => app.runGroup(g.id) },
          { label: t('ws.closeGroup'), run: () => { for (const m of members) close(m.id); } },
          { label: t('ws.dissolveGroup'), run: () => { for (const m of members) m.group = null; groups.splice(groups.indexOf(g), 1); render(); app.persist(); } },
        ]);
      });
      nodes.push(h('div', { class: 'tab-group', role: 'presentation', style: `--group:${g.color}` }, chip, ...members.flatMap((m) => tabFor(m, g.collapsed && m !== active))));
    }
    for (const d of docs) if (!d.group) nodes.push(...tabFor(d, false));
    nodes.push(h('button', { type: 'button', class: 'doctab-new', 'aria-label': t('ws.newTab'), title: t('ws.newTab'), onclick: () => add({}) }, '+'));
    tabbar.replaceChildren(...nodes);
    tabbar.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  // ── dosya ve klasör yükleme: baytlar bstr olarak okunur (ikili veri, CRLF ve geçersiz UTF-8 bozulmaz) ──
  async function readFile(f) {
    const raw = fromBytes(new Uint8Array(await f.arrayBuffer()));
    return { name: f.name, path: f.webkitRelativePath || f.relPath || f.name, raw, text: toText(raw) };
  }

  async function loadFiles(files, { groupName = null } = {}) {
    const loose = [];
    for (const f of files.slice(0, MAX_FILES)) {
      if (f.size > MAX_FILE_BYTES) { toast(t('ws.tooBig', { n: f.name }), 'err'); continue; }
      try {
        loose.push(await readFile(f));
      } catch (e) {
        toast(`${f.name}: ${e.message}`, 'err');
      }
    }
    if (files.length > MAX_FILES) toast(t('ws.tooMany', { n: MAX_FILES }), 'warn');
    if (!loose.length) { render(); return; }
    let first = null;
    // tek dosya: boş etkin sekmeye yüklenir; çoklu: dosya grubu
    if (loose.length === 1 && !groupName && active && !app.text('in') && !app.text('out')) {
      active.name = loose[0].name;
      active.path = loose[0].path;
      app.setInput(loose[0].text, loose[0].raw);
      render();
    } else {
      const g = loose.length > 1 || groupName ? newGroup(groupName ?? t('ws.files', { n: loose.length })) : null;
      for (const f of loose) {
        const d = newDoc({ name: f.name, path: f.path, input: f.text, raw: f.raw, group: g?.id ?? null });
        first ??= d;
      }
      if (g && loose.length > 1) offerBatch(g, loose.length);
    }
    if (first) switchTo(first.id);
    else render();
    app.persist();
    announce(t('ws.loaded', { n: loose.length }));
  }

  async function offerBatch(g, n) {
    await new Promise((r) => setTimeout(r, 0));
    if (await confirmDialog(t('ws.batchTitle'), t('ws.batchBody', { n, g: g.name }), { ok: t('ws.batchRun') })) app.runGroup(g.id);
  }

  // Sürükle-bırak klasörü: FileSystemEntry ağacı gezilir (yalnızca PHP uzantılı dosyalar)
  async function filesFromDrop(dt) {
    const items = [...(dt.items ?? [])];
    const entries = items.map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
    if (!entries.some((e) => e.isDirectory)) return { files: [...dt.files], group: null };
    const out = [];
    const walk = async (entry, prefix) => {
      if (out.length >= MAX_FILES) return;
      if (entry.isFile) {
        if (!PHP_NAME.test(entry.name)) return;
        const f = await new Promise((res, rej) => entry.file(res, rej));
        f.relPath = `${prefix}${entry.name}`;
        out.push(f);
      } else if (entry.isDirectory) {
        if (entry.name === 'vendor' || entry.name === 'node_modules' || entry.name.startsWith('.')) return;
        const reader = entry.createReader();
        for (;;) {
          const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
          if (!batch.length) break;
          for (const e of batch) await walk(e, `${prefix}${entry.name}/`);
        }
      }
    };
    for (const e of entries) await walk(e, '');
    return { files: out, group: entries.find((e) => e.isDirectory)?.name ?? null };
  }

  // ── oturum ──
  function serialize() {
    if (active) app.stash(active);
    return {
      format: 'peel-php-session',
      version: 1,
      savedAt: new Date().toISOString(),
      active: active?.id,
      groups: groups.map(({ id, name, color, collapsed }) => ({ id, name, color, collapsed })),
      docs: docs.map((d) => ({
        id: d.id, name: d.name, path: d.path, group: d.group,
        input: d.inState ? d.inState.doc.toString() : d.input,
        output: d.outState ? d.outState.doc.toString() : d.output,
        raw: d.raw, outRaw: d.outRaw,
        marks: d.marks, report: d.report, events: d.events, runs: d.runs,
      })),
    };
  }

  function restore(raw) {
    const s = sanitizeSession(raw);
    docs.length = 0;
    groups.length = 0;
    groups.push(...s.groups);
    for (const d of s.docs) docs.push({ ...d, inState: null, outState: null, snapshots: [], lastStats: {} });
    active = null;
    switchTo(s.active);
  }

  let saveTimer;
  function persist() {
    clearTimeout(saveTimer);
    if (!settings().persist) return;
    saveTimer = setTimeout(() => {
      saveSession(serialize()).catch((e) => app.log(`IndexedDB: ${e.message}`, 'warn'));
    }, 1200);
  }

  async function init() {
    if (settings().persist) {
      try {
        const saved = await loadSession();
        if (saved) { restore(saved); return true; }
      } catch (e) {
        app.log(`IndexedDB: ${e.message}`, 'warn');
      }
    }
    switchTo(newDoc({}).id);
    return false;
  }

  async function clearAll() {
    clearTimeout(saveTimer);
    await clearSession().catch(() => {});
    docs.length = 0;
    groups.length = 0;
    active = null;
    switchTo(newDoc({}).id);
  }

  return {
    get docs() { return docs; },
    get groups() { return groups; },
    get active() { return active; },
    byId, add, switchTo, close, rename, render, loadFiles, filesFromDrop, serialize, restore, persist, init, clearAll,
    newGroupForActive: () => groupDialog(active?.id),
    next(d) { const i = docs.indexOf(active); switchTo(docs[(i + d + docs.length) % docs.length].id); },
    groupDocs: (gid = active?.group) => (gid ? docs.filter((d) => d.group === gid) : docs),
  };
}
