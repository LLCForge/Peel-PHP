import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import { undo, redo, selectAll } from '@codemirror/commands';
import { openSearchPanel, searchPanelOpen, findNext, findPrevious } from '@codemirror/search';
import { foldAll, unfoldAll } from '@codemirror/language';
import { peel, passes, createSandbox } from './index.js';
import { fromText, toText, toBytes } from './core/bstr.js';
import { format } from './core/format.js';
import { tryParse } from './core/parse.js';
import { initPanels } from './ui/panels.js';
import { log, clearLog, toggleLog } from './ui/log.js';
import { renderDiff } from './ui/diff.js';
import { renderReport } from './ui/report.js';
import { createTimeline } from './ui/timeline.js';
import { createEditor } from './ui/editor.js';
import { createWorkspace } from './ui/workspace.js';
import { register, run as runCommand, openPalette, openShortcuts, keyOf, isMac } from './ui/commands.js';
import { displayKey } from './ui/keys.js';
import { settings, update, onSettings, sanitize as sanitizeSettings } from './ui/settings.js';
import { openSettings } from './ui/settings-panel.js';
import { promptText, confirmDialog, contextMenu, download, toast, announce } from './ui/dom.js';
import { registerServiceWorker } from './ui/pwa.js';
import { t, applyI18n, toggleLang, onLang, getLang, LANGS } from './i18n.js';
import { SAMPLE } from './sample.js';

const $ = (id) => document.getElementById(id);
const status = $('status');
const stats = $('stats');
const passbar = $('passbar');
const runBtn = $('btn-run');
const stopBtn = $('btn-stop');
const logBtn = $('btn-log');
const empty = $('empty');
const main = $('main');
const views = { code: $('view-code'), report: $('view-report'), timeline: $('view-timeline'), diff: $('view-diff') };
const outTabs = [...document.querySelectorAll('#pane-out .tabs [role="tab"]')];
const PASS_IDS = passes().map((p) => p.id);

let controller = null;
let lastStatus = ['status.ready', {}, ''];
let lastStats = {};
let diffDirty = true;
let activeTab = 'code';
let activeSide = 'in';
let settingInput = false; // programla yazılan girdi, dosyanın ham baytlarını (doc.raw) geçersiz kılmaz

// Bekçili PHP sandbox'ı (Web Worker + php-wasm). WASM ilk çözmede indirilir; hata olursa statik modda çalışılır.
let sandboxPromise = null;
const getSandbox = () => (sandboxPromise ??= createSandbox().catch((e) => { log(`sandbox: ${e.message}`, 'warn'); return null; }));

// ── editörler ──
const editorView = () => {
  const s = settings();
  return { fontSize: s.fontSize, wrap: s.wrap, invisibles: s.invisibles, ligatures: s.ligatures, minimap: s.minimap, indentGuides: s.indentGuides, activeLine: s.activeLine, tabWidth: s.format.tabWidth };
};
const edIn = createEditor($('ed-in'), {
  label: t('panel.input'),
  onChange: () => onTextChange('in'),
  onCursor: (st) => onCursor('in', st),
  onScroll: () => syncScroll('in'),
});
const edOut = createEditor(views.code, {
  readOnly: true,
  label: t('panel.output'),
  onChange: () => onTextChange('out'),
  onCursor: (st) => onCursor('out', st),
  onScroll: () => syncScroll('out'),
});
const editors = { in: edIn, out: edOut };
for (const [side, ed] of Object.entries(editors)) ed.view.dom.addEventListener('focusin', () => { activeSide = side; });
const timeline = createTimeline(views.timeline, { viewConfig: editorView() });

const setInput = (text, raw = null) => {
  settingInput = true;
  try { edIn.setText(text); } finally { settingInput = false; }
  if (ws.active) ws.active.raw = raw;
};

// ── durum çubuğu ──
function setStatus(key, vars = {}, cls = '') {
  lastStatus = [key, vars, cls];
  status.textContent = t(key, vars);
  status.className = cls;
}
function rawStatus(msg, cls = '') {
  lastStatus = ['', {}, cls];
  status.textContent = msg;
  status.className = cls;
}
function setStats(o) {
  lastStats = o ?? {};
  stats.textContent = '';
  for (const [k, v] of Object.entries(lastStats)) {
    if (!v) continue;
    const label = t(`stat.${k}`);
    if (label === `stat.${k}`) continue;
    const s = document.createElement('span');
    const b = document.createElement('b');
    b.textContent = v.toLocaleString(getLang());
    s.append(b, ` ${label}`);
    stats.appendChild(s);
  }
}
// Kodun cihazdan çıkmadığının kanıtı: sayfanın kendi kökeni dışına giden istek sayısı
function updateNetworkBadge() {
  const external = performance.getEntriesByType('resource').filter((e) => {
    try {
      const u = new URL(e.name);
      return /^https?:$/.test(u.protocol) && u.origin !== location.origin;
    } catch {
      return false;
    }
  });
  const badge = $('net');
  badge.hidden = false;
  badge.classList.toggle('leak', external.length > 0);
  badge.textContent = external.length ? t('status.external', { n: external.length }) : t('status.offline');
}
const setLog = (open) => logBtn.setAttribute('aria-expanded', String(toggleLog(open)));

function onCursor(side, st) {
  const sel = st.selection.main;
  const line = st.doc.lineAt(sel.head);
  $('cursor').textContent = `${t(side === 'in' ? 'panel.input' : 'panel.output')} · ${t('status.cursor', { l: line.number, c: sel.head - line.from + 1 })}${sel.empty ? '' : ` · ${t('status.selected', { n: sel.to - sel.from })}`}`;
}

// ── belge değişimi ──
let changeTimer;
function onTextChange(side) {
  const n = editors[side].length;
  $(side === 'in' ? 'in-info' : 'out-info').textContent = n.toLocaleString(getLang());
  diffDirty = true;
  if (side === 'in') {
    syncEmpty();
    // kullanıcı girdiyi düzenledi: dosyanın ham baytları artık geçerli değil
    if (!settingInput && ws?.active) ws.active.raw = null;
  } else for (const id of ['btn-copy', 'btn-dl']) $(id).disabled = n === 0;
  ws?.persist();
  clearTimeout(changeTimer);
  changeTimer = setTimeout(() => { if (activeTab === 'diff') selectTab('diff'); }, 450);
}
const syncEmpty = () => { empty.hidden = edIn.length > 0; };

// ── çalışma alanı ──
const ws = createWorkspace({
  text: (side) => editors[side].text,
  setInput,
  persist: () => ws?.persist(),
  log,
  runGroup: (gid) => runGroup(gid),
  stash(doc) {
    doc.inState = edIn.state;
    doc.outState = edOut.state;
    doc.marks = { in: edIn.marks(), out: edOut.marks() };
  },
  load(doc) {
    edIn.setState(doc.inState ?? edIn.createState(doc.input));
    edOut.setState(doc.outState ?? edOut.createState(doc.output));
    if (!doc.inState) edIn.resetMarks(doc.marks.in);
    if (!doc.outState) edOut.resetMarks(doc.marks.out);
    $('in-info').textContent = edIn.length.toLocaleString(getLang());
    $('out-info').textContent = edOut.length.toLocaleString(getLang());
    for (const id of ['btn-copy', 'btn-dl']) $(id).disabled = edOut.length === 0;
    syncEmpty();
    diffDirty = true;
    resetResultsView();
    if (doc.report) showReport(doc);
    timeline.load(doc.snapshots ?? []);
    setStats(doc.lastStats ?? {});
    for (const e of doc.events ?? []) markPass(e.id, e.state);
    if (activeTab === 'diff') selectTab('diff');
  },
}, $('doctabs'));

// ── sonuç görünümleri ──
function selectTab(name, focus = false) {
  activeTab = name;
  for (const tab of outTabs) {
    const on = tab.id === `tab-${name}`;
    tab.setAttribute('aria-selected', String(on));
    tab.tabIndex = on ? 0 : -1;
    if (on && focus) tab.focus();
  }
  for (const [key, view] of Object.entries(views)) view.hidden = key !== name;
  if (name === 'diff' && diffDirty) {
    renderDiff(views.diff, edIn.text, edOut.text);
    diffDirty = false;
  }
}

function markPass(id, state) {
  let seg = passbar.querySelector(`i[data-id="${CSS.escape(id)}"]`);
  if (!seg) {
    seg = document.createElement('i');
    seg.dataset.id = id;
    seg.title = id;
    passbar.appendChild(seg);
  }
  // birden çok turda en iyi sonucu koru: bir kez değişiklik yapan pass işaretli kalır
  if (state === 'skip' && seg.className === 'ok') return;
  seg.className = state;
}

function resetResultsView() {
  setStats({});
  passbar.textContent = '';
  renderReport(views.report, null);
  timeline.reset();
  diffDirty = true;
}

function showReport(doc) {
  try {
    renderReport(views.report, doc.report, { verified: doc.verified, ms: doc.ms, events: doc.events, onExport: exportReport });
  } catch (e) {
    // içe aktarılmış oturumdaki bozuk rapor arayüzü kırmasın
    log(`report: ${e.message}`, 'warn');
    renderReport(views.report, null);
  }
}

// core/format.js'in varsayılanları: bunlarla aynıysa çözücünün (davranışı doğrulanmış) biçimi kullanılır
const DEFAULT_FORMAT = { printWidth: 100, tabWidth: 4, useTabs: false, singleQuote: true };

// Kullanıcının biçim tercihi varsayılandan farklıysa çözülmüş kod yeniden biçimlenir; ayrıştırılamazsa çözücü çıktısı kalır
async function applyFormat(code) {
  const f = settings().format;
  const same = f.printWidth === DEFAULT_FORMAT.printWidth && f.tabWidth === DEFAULT_FORMAT.tabWidth && f.useTabs === DEFAULT_FORMAT.useTabs && f.singleQuote === DEFAULT_FORMAT.singleQuote;
  if (!f.enabled || same) return code;
  const out = await format(code, { printWidth: f.printWidth, tabWidth: f.tabWidth, useTabs: f.useTabs, singleQuote: f.singleQuote });
  return out && tryParse(out) ? out : code;
}

// Motorun girdisi: dosyadan açılıp düzenlenmemişse dosyanın kendi baytları (Uint8Array), değilse editör metni.
// peel() dizgeyi kullanıcı metni sayıp UTF-8'e çevirir; bstr'yi dizge olarak vermek çift kodlama yapar.
const inputOf = (doc) => (doc?.raw ? toBytes(doc.raw) : edIn.text);

// ── çalıştırma: tek düğme, tüm pass'ler en yüksek seviyede; sandbox her dönüşümü davranışla doğrular ──
async function run() {
  if (controller) return null;
  const doc = ws.active;
  if (!edIn.text.trim()) {
    setStatus('status.empty', {}, 'err');
    edIn.focus();
    return null;
  }
  controller = new AbortController();
  const { signal } = controller;
  runBtn.disabled = true;
  runBtn.setAttribute('aria-busy', 'true');
  stopBtn.hidden = false;
  resetResultsView();
  clearLog();
  for (const id of PASS_IDS) markPass(id, 'idle');
  const t0 = performance.now();
  const snapshots = [];
  try {
    setStatus('status.loadingPhp', {}, 'busy');
    const sandbox = await getSandbox();
    if (signal.aborted) throw new Error(t('status.stopped'));
    setStatus(sandbox ? 'status.running' : 'status.runningStatic', {}, 'busy');
    const src = inputOf(doc);
    // durdurulduktan sonra hat sandbox'a yeni iş (ör. sıradaki PHP sürümünü yükleme) göndermesin
    const guard = (fn) => (o) => (signal.aborted ? Promise.reject(new Error(t('status.stopped'))) : fn(o));
    const guarded = sandbox && { versions: sandbox.versions, run: guard(sandbox.run), evaluate: guard(sandbox.evaluate) };
    const res = await peel(src, {
      sandbox: guarded ?? false,
      lang: getLang(),
      formatOutput: settings().format.enabled,
      signal,
      onLog: (m, level) => log(m, level),
      onPass: (id, state) => markPass(id, state),
      onSnapshot: (s) => { const snap = { id: s.id, round: s.round, code: toText(s.code) }; snapshots.push(snap); timeline.push(snap); },
    });
    if (signal.aborted) throw new Error(t('status.stopped'));
    if (res.error) {
      log(res.error, 'err');
      setStatus('status.parse', {}, 'err');
      setLog(true);
      timeline.finish();
      return null;
    }
    const code = settings().format.enabled ? await applyFormat(res.code) : res.code;
    const text = toText(code);
    const ms = Math.round(performance.now() - t0);
    const secs = (ms / 1000).toFixed(2);
    Object.assign(doc, {
      snapshots, events: res.events, lastStats: res.stats, report: res.report, verified: res.verified, ms,
      // çıktının baytları metinle birebir değilse (CRLF, ikili veri) indirme için ayrıca saklanır
      outRaw: fromText(text) === code ? null : code,
    });
    doc.runs = [...(doc.runs ?? []), { at: Date.now(), inBytes: res.report?.metrics?.inBytes ?? 0, outBytes: code.length, ms, version: res.version, verified: res.verified }].slice(-20);
    timeline.finish();
    edOut.setText(text);
    setStats(res.stats);
    log(`OK (${secs}s, PHP ${res.version})`, 'ok');
    if (sandbox && !res.verified) setStatus('status.unverified', { s: secs }, 'err');
    else if (!sandbox) setStatus('status.doneStatic', { s: secs }, 'ok');
    else setStatus(text.trim() === edIn.text.trim() ? 'status.unchanged' : 'status.done', { s: secs, v: res.version }, 'ok');
    announce(status.textContent);
    showReport(doc);
    ws.render();
    ws.persist();
    return res.report;
  } catch (e) {
    if (signal.aborted) setStatus('status.stopped', {}, 'err');
    else { log(e.message, 'err'); setStatus('status.error', { m: e.message }, 'err'); }
    timeline.finish();
    return null;
  } finally {
    controller = null;
    runBtn.disabled = false;
    runBtn.removeAttribute('aria-busy');
    stopBtn.hidden = true;
    for (const seg of passbar.querySelectorAll('i.run, i.idle')) seg.className = 'skip';
    updateNetworkBadge();
  }
}

// Çoklu dosya: grup belgeleri sırayla çözülür
async function runGroup(gid) {
  const list = ws.groupDocs(gid);
  for (let i = 0; i < list.length; i++) {
    ws.switchTo(list[i].id);
    rawStatus(t('status.batch', { i: i + 1, n: list.length, name: list[i].name }), 'busy');
    if (!edIn.text.trim()) continue;
    await run();
    if (lastStatus[0] === 'status.stopped') return;
  }
  announce(t('status.batchDone', { n: list.length }));
  toast(t('status.batchDone', { n: list.length }), 'ok');
}

// Durdur: hat bir sonraki pass sınırında durur; uçuştaki PHP çalıştırması worker sonlandırılarak kesilir
async function stop() {
  if (!controller) return;
  controller.abort();
  (await sandboxPromise)?.kill?.(t('status.stopped'));
  log(t('status.stopped'), 'warn');
}

function exportReport() {
  const d = ws.active;
  if (d?.report) download(`${baseName(d)}.peel-report.json`, JSON.stringify({ report: d.report, events: d.events, verified: d.verified }, null, 2), 'application/json');
}
const baseName = (d) => (d?.name || 'peeled').replace(/\.[^.]+$/, '');

// Senkron kaydırma: orantılı
let syncing = false;
function syncScroll(from) {
  if (!settings().syncScroll || syncing) return;
  const a = editors[from].scrollDOM;
  const b = editors[from === 'in' ? 'out' : 'in'].scrollDOM;
  syncing = true;
  const frac = a.scrollTop / Math.max(1, a.scrollHeight - a.clientHeight);
  b.scrollTop = frac * (b.scrollHeight - b.clientHeight);
  requestAnimationFrame(() => { syncing = false; });
}

// ── satır notları ve yer imleri ──
async function editNote(side = activeSide, pos = editors[side].cursor) {
  const ed = editors[side];
  const text = await promptText(t('notes.title', { l: ed.lineAt(pos).number }), { label: t('notes.label'), value: ed.noteAt(pos), multiline: true });
  if (text === undefined) return;
  ed.setNote(pos, text.trim().slice(0, 4000));
  ws.persist();
}
function toggleBookmark() { editors[activeSide].toggleBookmark(); ws.persist(); }

const panels = initPanels({
  split: settings().split,
  onSplit: (v) => updateSoon({ split: Math.round(v) }),
  onFiles: async (dt) => { const { files, group } = await ws.filesFromDrop(dt); ws.loadFiles(files, { groupName: group }); },
  onPane: () => { for (const ed of Object.values(editors)) ed.view.requestMeasure(); },
});
let splitTimer;
const updateSoon = (patch) => { clearTimeout(splitTimer); splitTimer = setTimeout(() => update(patch), 300); };

// ── modlar: okuma, odak, tam ekran ──
const setReading = (on) => update({ reading: on });
function setFocusMode(on) {
  document.body.classList.toggle('focus-mode', on);
  document.body.dataset.focusSide = activeSide;
  if (on) { editors[activeSide].focus(); toast(t('focus.on'), 'info'); }
  announce(t(on ? 'focus.on' : 'focus.off'));
  for (const ed of Object.values(editors)) ed.view.requestMeasure();
}
function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen?.();
  else document.documentElement.requestFullscreen?.().catch((e) => setStatus('status.error', { m: e.message }, 'err'));
}

// ── ayarların uygulanması ──
const mq = matchMedia('(prefers-color-scheme: light)');
const mobileMq = matchMedia('(max-width: 767px)');
function applySettings(s) {
  document.documentElement.dataset.theme = s.theme === 'system' ? (mq.matches ? 'light' : 'dark') : s.theme;
  document.documentElement.dataset.palette = s.palette;
  document.querySelector('meta[name="theme-color"]').content = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || '#0c0c0c';
  const view = editorView();
  edIn.configure(view);
  edOut.configure(s.reading ? { ...view, wrap: true, fontSize: s.fontSize + 2, minimap: false } : view);
  timeline.configure(view);
  document.body.classList.toggle('reading', s.reading);
  $('btn-reading').setAttribute('aria-pressed', String(s.reading));
  if (s.reading && activeTab !== 'code') selectTab('code');
  if (s.reading && document.body.classList.contains('mobile')) panels.setPane('out');
  for (const ed of Object.values(editors)) ed.view.requestMeasure();
}
onSettings(applySettings);
mq.addEventListener('change', () => applySettings(settings()));
const applyMobile = () => { document.body.classList.toggle('mobile', mobileMq.matches); applySettings(settings()); };
mobileMq.addEventListener('change', applyMobile);

function viewMenu(btn, side) {
  const s = settings();
  const r = btn.getBoundingClientRect();
  const item = (key) => ({ label: `${s[key] ? '✓ ' : '  '}${t(`settings.${key}`)}`, run: () => update({ [key]: !s[key] }) });
  contextMenu(r.left, r.bottom + 4, [
    item('wrap'), item('invisibles'), item('minimap'), item('indentGuides'), item('activeLine'), item('ligatures'), 'sep',
    item('syncScroll'), 'sep',
    { label: t('cmd.foldAll'), run: () => foldAll(editors[side].view) },
    { label: t('cmd.unfoldAll'), run: () => unfoldAll(editors[side].view) },
    { label: t('cmd.zoomIn'), key: displayKey(keyOf('zoomIn'), isMac), run: () => runCommand('zoomIn') },
    { label: t('cmd.zoomOut'), key: displayKey(keyOf('zoomOut'), isMac), run: () => runCommand('zoomOut') },
  ]);
}

function openMenu(btn) {
  const r = btn.getBoundingClientRect();
  const k = (id) => displayKey(keyOf(id), isMac);
  contextMenu(r.left, r.bottom + 4, [
    { label: t('cmd.openFile'), key: k('openFile'), run: () => $('file').click() },
    { label: t('cmd.openFolder'), run: () => $('folder').click() },
    'sep',
    { label: t('cmd.newTab'), key: k('newTab'), run: () => ws.add({}) },
    { label: t('cmd.importSession'), run: () => $('session-file').click() },
    { label: t('cmd.exportSession'), key: k('exportSession'), run: exportSession },
  ]);
}

// ── oturum JSON ──
function exportSession() {
  const data = { ...ws.serialize(), settings: settings() };
  download(`peel-php-session-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(data), 'application/json');
  setStatus('status.sessionExported', {}, 'ok');
}
async function importSession(file) {
  try {
    if (file.size > 200 * 1024 * 1024) throw new Error(t('ws.tooBig', { n: file.name }));
    const raw = JSON.parse(await file.text());
    if (raw?.format !== 'peel-php-session') throw new Error(t('session.badFormat'));
    if (!(await confirmDialog(t('session.importTitle'), t('session.importBody', { n: Array.isArray(raw.docs) ? raw.docs.length : 0 }), { ok: t('session.import') }))) return;
    if (raw.settings) update(sanitizeSettings(raw.settings));
    ws.restore(raw);
    ws.persist();
    setStatus('status.sessionImported', {}, 'ok');
  } catch (e) {
    setStatus('status.error', { m: e.message }, 'err');
  }
}
async function clearSessionCmd() {
  if (await confirmDialog(t('session.clearTitle'), t('session.clearBody'), { ok: t('session.clear'), danger: true })) {
    await ws.clearAll();
    setStatus('status.sessionCleared', {}, 'ok');
  }
}

function loadSample() {
  setInput(SAMPLE);
  edIn.focus();
}

function cycleSetting(key, values) {
  update({ [key]: values[(values.indexOf(settings()[key]) + 1) % values.length] });
  toast(`${t(`settings.${key}`)}: ${t(`settings.${key}.${settings()[key]}`)}`, 'info', 1500);
}

function copyOutput() {
  navigator.clipboard.writeText(edOut.text).then(() => setStatus('status.copied', {}, 'ok'), () => setStatus('status.copyFail', {}, 'err'));
}
function downloadOutput() {
  const d = ws.active;
  const data = d?.outRaw ? toBytes(d.outRaw) : edOut.text;
  download(`${baseName(d)}.peeled.php`, new Blob([data], { type: 'application/x-php' }));
}

function gotoLine(n) {
  const ed = editors[activeSide];
  const pos = ed.posOfLine(n);
  if (activeSide === 'out' && activeTab !== 'code') selectTab('code');
  ed.select(pos, pos, { focus: true });
}

// ── komutlar ──
const G = { file: 'cmd.group.file', run: 'cmd.group.run', nav: 'cmd.group.nav', view: 'cmd.group.view', marks: 'cmd.group.marks' };
const cmd = (id, key, group, runFn, extra = {}) => ({ id, key, group, title: () => t(`cmd.${id}`), run: runFn, ...extra });
const toggleCmd = (id, key) => cmd(id, key, G.view, () => { update({ [id]: !settings()[id] }); toast(`${t(`settings.${id}`)}: ${t(settings()[id] ? 'ui.on' : 'ui.off')}`, 'info', 1400); });
const notRunning = () => !controller;
register(
  cmd('palette', 'Ctrl+Shift+P', null, () => openPalette({ gotoLine })),
  cmd('paletteAlt', 'F1', null, () => openPalette({ gotoLine })),
  cmd('shortcuts', 'Shift+F1', null, openShortcuts),
  cmd('settings', 'Ctrl+,', null, () => openSettings({ onClearSession: clearSessionCmd })),
  cmd('openFile', 'Ctrl+O', G.file, () => $('file').click()),
  cmd('openFolder', null, G.file, () => $('folder').click()),
  cmd('newTab', 'Alt+N', G.file, () => ws.add({})),
  cmd('closeTab', 'Alt+W', G.file, () => ws.close(ws.active.id)),
  cmd('nextTab', 'Alt+PageDown', G.file, () => ws.next(1)),
  cmd('prevTab', 'Alt+PageUp', G.file, () => ws.next(-1)),
  cmd('renameTab', null, G.file, () => ws.rename(ws.active.id)),
  cmd('newGroup', null, G.file, () => ws.newGroupForActive()),
  cmd('saveSession', 'Ctrl+S', G.file, () => { if (!settings().persist) { setStatus('status.persistOff', {}, 'err'); return; } ws.persist(); setStatus('status.sessionSaved', {}, 'ok'); }),
  cmd('exportSession', 'Ctrl+Shift+S', G.file, exportSession),
  cmd('importSession', null, G.file, () => $('session-file').click()),
  cmd('clearSession', null, G.file, clearSessionCmd),
  cmd('sample', null, G.file, loadSample),
  cmd('copyOutput', null, G.file, copyOutput, { when: () => edOut.length > 0 }),
  cmd('downloadOutput', null, G.file, downloadOutput, { when: () => edOut.length > 0 }),
  cmd('run', 'Ctrl+Enter', G.run, () => run(), { when: notRunning }),
  cmd('stop', 'Ctrl+.', G.run, stop),
  cmd('runGroup', null, G.run, () => (ws.active?.group ? runGroup(ws.active.group) : setStatus('status.noGroup', {}, 'err')), { when: notRunning }),
  cmd('gotoLine', 'Ctrl+G', G.nav, async () => {
    const v = await promptText(t('cmd.gotoLine'), { label: t('palette.lineLabel'), validate: (x) => (/^\d+$/.test(x.trim()) ? null : t('palette.lineLabel')) });
    if (v) gotoLine(Number(v));
  }),
  cmd('switchSide', 'F6', G.nav, () => { activeSide = activeSide === 'in' ? 'out' : 'in'; if (activeSide === 'out') selectTab('code'); editors[activeSide].focus(); }),
  cmd('undo', null, G.nav, () => undo(editors[activeSide].view)),
  cmd('redo', null, G.nav, () => redo(editors[activeSide].view)),
  cmd('selectAll', null, G.nav, () => selectAll(editors[activeSide].view)),
  cmd('findInEditor', null, G.nav, () => openSearchPanel(editors[activeSide].view)),
  cmd('findNext', 'F3', G.nav, () => { const v = editors[activeSide].view; if (searchPanelOpen(v.state)) findNext(v); else openSearchPanel(v); }),
  cmd('findPrev', 'Shift+F3', G.nav, () => { const v = editors[activeSide].view; if (searchPanelOpen(v.state)) findPrevious(v); else openSearchPanel(v); }),
  cmd('toggleBookmark', 'Ctrl+B', G.marks, toggleBookmark),
  cmd('nextBookmark', 'F8', G.marks, () => editors[activeSide].nextBookmark(1)),
  cmd('prevBookmark', 'Shift+F8', G.marks, () => editors[activeSide].nextBookmark(-1)),
  cmd('addNote', 'Ctrl+Alt+N', G.marks, () => editNote()),
  cmd('zoomIn', 'Ctrl+=', G.view, () => update({ fontSize: settings().fontSize + 1 })),
  cmd('zoomOut', 'Ctrl+-', G.view, () => update({ fontSize: settings().fontSize - 1 })),
  cmd('zoomReset', 'Ctrl+0', G.view, () => update({ fontSize: 13 })),
  toggleCmd('wrap', 'Alt+Z'),
  toggleCmd('invisibles', null),
  toggleCmd('minimap', null),
  toggleCmd('indentGuides', null),
  toggleCmd('activeLine', null),
  toggleCmd('ligatures', null),
  toggleCmd('syncScroll', null),
  cmd('reading', 'Ctrl+Alt+R', G.view, () => setReading(!settings().reading)),
  cmd('focusMode', 'Ctrl+Alt+F', G.view, () => setFocusMode(!document.body.classList.contains('focus-mode'))),
  cmd('exitModes', 'Escape', G.view, () => { setFocusMode(false); if (settings().reading) setReading(false); }, {
    when: () => (document.body.classList.contains('focus-mode') || settings().reading) && !document.querySelector('.cm-panel.cm-search, .ctx-menu'),
  }),
  cmd('fullscreen', 'Shift+F11', G.view, toggleFullscreen),
  cmd('theme', null, G.view, () => cycleSetting('theme', ['dark', 'light', 'contrast', 'system'])),
  cmd('palette.colors', null, G.view, () => cycleSetting('palette', ['default', 'deutan', 'protan', 'tritan'])),
  cmd('language', null, G.view, () => toggleLang()),
  cmd('toggleLog', 'Ctrl+J', G.view, () => setLog()),
  cmd('tabCode', 'Alt+1', G.view, () => selectTab('code', true)),
  cmd('tabReport', 'Alt+2', G.view, () => selectTab('report', true)),
  cmd('tabTimeline', 'Alt+3', G.view, () => selectTab('timeline', true)),
  cmd('tabDiff', 'Alt+4', G.view, () => selectTab('diff', true)),
);

// ── olay bağlama ──
runBtn.addEventListener('click', () => run());
stopBtn.addEventListener('click', stop);
$('btn-load').addEventListener('click', (e) => openMenu(e.currentTarget));
$('btn-empty-open').addEventListener('click', () => $('file').click());
$('btn-sample').addEventListener('click', loadSample);
$('btn-empty-sample').addEventListener('click', loadSample);
$('btn-palette').addEventListener('click', () => runCommand('palette'));
$('btn-settings').addEventListener('click', () => runCommand('settings'));
$('btn-view-in').addEventListener('click', (e) => viewMenu(e.currentTarget, 'in'));
$('btn-view-out').addEventListener('click', (e) => viewMenu(e.currentTarget, 'out'));
$('btn-reading').addEventListener('click', () => setReading(!settings().reading));
$('btn-clear').addEventListener('click', () => {
  setInput('');
  edOut.setText('');
  Object.assign(ws.active, { report: null, events: [], snapshots: [], lastStats: {}, outRaw: null, verified: null, ms: null });
  resetResultsView();
  clearLog();
  setStatus('status.ready');
  ws.render();
  edIn.focus();
});
$('btn-copy').addEventListener('click', copyOutput);
$('btn-dl').addEventListener('click', downloadOutput);
logBtn.addEventListener('click', () => setLog());
$('btn-lang').addEventListener('click', () => toggleLang());
for (const id of ['file', 'folder']) {
  $(id).addEventListener('change', (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    if (!files.length) return;
    if (id === 'folder') ws.loadFiles(files.filter((f) => /\.(php\d?|phtml|inc)$/i.test(f.name)), { groupName: files[0].webkitRelativePath.split('/')[0] || null });
    else ws.loadFiles(files);
  });
}
$('session-file').addEventListener('change', (e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) importSession(f); });

for (const tab of outTabs) {
  tab.addEventListener('click', () => selectTab(tab.id.slice(4)));
  tab.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft' && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    const rtl = document.documentElement.dir === 'rtl';
    const cur = outTabs.indexOf(tab);
    const i = e.key === 'Home' ? 0 : e.key === 'End' ? outTabs.length - 1 : cur + ((e.key === 'ArrowRight') !== rtl ? 1 : -1);
    selectTab(outTabs[(i + outTabs.length) % outTabs.length].id.slice(4), true);
  });
}
document.addEventListener('fullscreenchange', () => document.body.classList.toggle('fullscreen', Boolean(document.fullscreenElement)));

function relabel() {
  applyI18n();
  const code = getLang();
  const lb = $('btn-lang');
  lb.textContent = code.toUpperCase();
  lb.setAttribute('aria-label', `${t('settings.lang')}: ${LANGS.find(([c]) => c === code)?.[1] ?? code}`);
  $('btn-palette').querySelector('kbd').textContent = displayKey(keyOf('palette'), isMac);
  runBtn.querySelector('kbd').textContent = displayKey(keyOf('run'), isMac);
  for (const [side, ed] of Object.entries(editors)) ed.view.contentDOM.setAttribute('aria-label', t(side === 'in' ? 'panel.input' : 'panel.output'));
  $('cursor').textContent = '';
  if (lastStatus[0]) setStatus(...lastStatus);
  setStats(lastStats);
  if (ws.active?.report) showReport(ws.active);
  else renderReport(views.report, null);
  timeline.render();
  diffDirty = true;
  if (activeTab === 'diff') selectTab('diff');
  updateNetworkBadge();
  ws.render();
}
onLang(relabel);
onSettings((_s, patch) => { if ('keymap' in patch) relabel(); });

// ── başlangıç ──
applyMobile();
relabel();
setStatus('status.ready');
ws.init().then((restored) => {
  syncEmpty();
  if (restored && ws.docs.some((d) => d.input || d.output)) setStatus('status.restored', { n: ws.docs.length }, 'ok');
});
updateNetworkBadge();
registerServiceWorker();
