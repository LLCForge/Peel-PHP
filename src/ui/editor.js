import { EditorState, Compartment, StateEffect, StateField, RangeSet, RangeSetBuilder } from '@codemirror/state';
import {
  EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, highlightSpecialChars, highlightWhitespace,
  drawSelection, dropCursor, rectangularSelection, crosshairCursor, Decoration, ViewPlugin, gutter, GutterMarker,
} from '@codemirror/view';
import { history, defaultKeymap, historyKeymap, indentWithTab } from '@codemirror/commands';
import { foldGutter, foldKeymap, bracketMatching, indentOnInput, syntaxHighlighting, HighlightStyle, indentUnit } from '@codemirror/language';
import { searchKeymap, highlightSelectionMatches, search } from '@codemirror/search';
import { php } from '@codemirror/lang-php';
import { tags } from '@lezer/highlight';

// CodeMirror 6 tabanlı kod editörü (PHP + gömülü HTML). Sözdizimi renkleri ve tüm yüzeyler CSS değişkenlerinden gelir;
// tema/palet değişimi editörü yeniden kurmadan yansır.

const highlight = HighlightStyle.define([
  { tag: [tags.variableName], color: 'var(--syn-var)' },
  { tag: [tags.processingInstruction, tags.meta], color: 'var(--syn-kw)', fontWeight: '600' },
  { tag: [tags.tagName, tags.angleBracket], color: 'var(--syn-def)' },
  { tag: [tags.attributeName], color: 'var(--syn-prop)' },
  { tag: [tags.keyword, tags.controlKeyword, tags.moduleKeyword, tags.operatorKeyword, tags.definitionKeyword], color: 'var(--syn-kw)' },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--syn-str)' },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], color: 'var(--syn-num)' },
  { tag: [tags.lineComment, tags.blockComment, tags.comment], color: 'var(--syn-com)', fontStyle: 'italic' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: 'var(--syn-fn)' },
  { tag: [tags.definition(tags.variableName), tags.definition(tags.function(tags.variableName))], color: 'var(--syn-def)' },
  { tag: [tags.propertyName], color: 'var(--syn-prop)' },
  { tag: [tags.regexp, tags.escape], color: 'var(--syn-re)' },
  { tag: [tags.className, tags.typeName], color: 'var(--syn-fn)' },
  { tag: [tags.operator, tags.punctuation, tags.bracket], color: 'var(--syn-op)' },
  { tag: [tags.self, tags.special(tags.variableName)], color: 'var(--syn-kw)' },
]);

const baseTheme = EditorView.theme({
  '&': { height: '100%', color: 'var(--text)', backgroundColor: 'var(--bg)' },
  '.cm-scroller': { fontFamily: 'var(--mono)', lineHeight: '1.65' },
  '.cm-content': { caretColor: 'var(--accent)', padding: '12px 0' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': { backgroundColor: 'var(--sel) !important' },
  '.cm-gutters': { backgroundColor: 'var(--bg)', color: 'var(--faint)', border: 'none', borderRight: '1px solid var(--line)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--active-line)', color: 'var(--text)' },
  '.cm-activeLine': { backgroundColor: 'var(--active-line)' },
  '.cm-foldPlaceholder': { backgroundColor: 'var(--raised)', border: '1px solid var(--line-strong)', color: 'var(--muted)', padding: '0 6px' },
  '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': { backgroundColor: 'var(--bracket)', outline: '1px solid var(--accent-line)' },
  '.cm-nonmatchingBracket': { color: 'var(--err)' },
  '.cm-searchMatch': { backgroundColor: 'var(--hit)', outline: '1px solid var(--accent-line)' },
  '.cm-searchMatch-selected': { backgroundColor: 'var(--hit-strong)' },
  '.cm-selectionMatch': { backgroundColor: 'var(--hit)' },
  '.cm-tooltip': { backgroundColor: 'var(--raised)', border: '1px solid var(--line-strong)', color: 'var(--text)' },
  '.cm-panels': { backgroundColor: 'var(--surface)', color: 'var(--text)' },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--line)' },
  '.cm-textfield': { backgroundColor: 'var(--bg)', color: 'var(--text)', border: '1px solid var(--line-strong)', borderRadius: '6px' },
  '.cm-button': { backgroundImage: 'none', backgroundColor: 'var(--raised)', color: 'var(--text)', border: '1px solid var(--line-strong)', borderRadius: '6px' },
});

// Parantez eşleme: PHP açılış etiketi (<?php) kapanış etiketi olmadan da geçerlidir; eşsiz diye kırmızı işaretlenmez
const matchMark = Decoration.mark({ class: 'cm-matchingBracket' });
const noMatchMark = Decoration.mark({ class: 'cm-nonmatchingBracket' });
const phpBrackets = bracketMatching({
  renderMatch(m, state) {
    if (!m.matched && state.sliceDoc(m.start.from, m.start.to).startsWith('<?')) return [];
    const mark = m.matched ? matchMark : noMatchMark;
    return m.end ? [mark.range(m.start.from, m.start.to), mark.range(m.end.from, m.end.to)] : [mark.range(m.start.from, m.start.to)];
  },
});

// ── katmanlar: arama sonuçları, eşleme, kapsam renkleri, ölü kod, güven ısısı ──
const setLayerEffect = StateEffect.define();
const layerField = StateField.define({
  create: () => ({}),
  update(val, tr) {
    let next = val;
    if (tr.docChanged) {
      next = {};
      for (const [k, set] of Object.entries(val)) next[k] = set.map(tr.changes);
    }
    for (const e of tr.effects) if (e.is(setLayerEffect)) next = { ...next, [e.value.name]: e.value.set };
    return next;
  },
  provide: (f) => EditorView.decorations.compute([f], (s) => RangeSet.join(Object.values(s.field(f)))),
});

function buildLayer(doc, ranges) {
  const len = doc.length;
  const decos = [];
  for (const r of ranges) {
    const from = Math.max(0, Math.min(len, r.from));
    const to = Math.max(from, Math.min(len, r.to ?? from));
    if (r.line) {
      const a = doc.lineAt(from).number;
      const b = doc.lineAt(to).number;
      for (let n = a; n <= b && n - a < 5000; n++) decos.push(Decoration.line({ class: r.cls }).range(doc.line(n).from));
    } else if (to > from) {
      decos.push(Decoration.mark({ class: r.cls, attributes: r.title ? { title: r.title } : undefined }).range(from, to));
    }
  }
  return Decoration.set(decos, true);
}

// ── yer imleri ve satır notları ──
class BookmarkMarker extends GutterMarker {
  toDOM() { const s = document.createElement('span'); s.className = 'cm-bookmark'; s.setAttribute('aria-hidden', 'true'); return s; }
}
class NoteMarker extends GutterMarker {
  constructor(text) { super(); this.text = text; }
  eq(o) { return o.text === this.text; }
  toDOM() { const s = document.createElement('span'); s.className = 'cm-note'; s.title = this.text; s.setAttribute('aria-label', this.text); return s; }
}
const bookmark = new BookmarkMarker();
const marksEffect = StateEffect.define();
const marksField = StateField.define({
  create: () => ({ bookmarks: RangeSet.empty, notes: RangeSet.empty }),
  update(val, tr) {
    let { bookmarks, notes } = val;
    if (tr.docChanged) { bookmarks = bookmarks.map(tr.changes); notes = notes.map(tr.changes); }
    for (const e of tr.effects) {
      if (!e.is(marksEffect)) continue;
      const v = e.value;
      const doc = tr.state.doc;
      const lineStart = (pos) => doc.lineAt(Math.max(0, Math.min(doc.length, pos))).from;
      if (v.type === 'toggle') {
        const at = lineStart(v.pos);
        let has = false;
        bookmarks.between(at, at, () => { has = true; });
        bookmarks = has ? bookmarks.update({ filter: (from) => from !== at }) : bookmarks.update({ add: [bookmark.range(at)] });
      } else if (v.type === 'note') {
        const at = lineStart(v.pos);
        notes = notes.update({ filter: (from) => from !== at, add: v.text ? [new NoteMarker(v.text).range(at)] : [] });
      } else if (v.type === 'reset') {
        const line = (n) => doc.line(Math.max(1, Math.min(doc.lines, n))).from;
        bookmarks = RangeSet.of(v.bookmarks.map((n) => bookmark.range(line(n))), true);
        notes = RangeSet.of(v.notes.map((x) => new NoteMarker(x.text).range(line(x.line))), true);
      }
    }
    return { bookmarks, notes };
  },
});
const marksGutter = gutter({
  class: 'cm-marks-gutter',
  markers: (view) => { const m = view.state.field(marksField); return RangeSet.join([m.bookmarks, m.notes]); },
  initialSpacer: () => bookmark,
  domEventHandlers: {
    mousedown(view, line) { view.dispatch({ effects: marksEffect.of({ type: 'toggle', pos: line.from }) }); return true; },
  },
});

// ── girinti rehberleri ──
const guideMark = Decoration.mark({ class: 'cm-indent-guide' });
const indentGuides = ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = this.build(view); }
  update(u) { if (u.docChanged || u.viewportChanged) this.decorations = this.build(u.view); }
  build(view) {
    const b = new RangeSetBuilder();
    const unit = Math.max(1, view.state.facet(indentUnit).length);
    for (const { from, to } of view.visibleRanges) {
      for (let pos = from; pos <= to;) {
        const line = view.state.doc.lineAt(pos);
        const text = line.text;
        let ws = 0;
        while (ws < text.length && text[ws] === ' ') ws++;
        if (ws < text.length) for (let c = 0; c + unit <= ws; c += unit) b.add(line.from + c, line.from + c + 1, guideMark);
        pos = line.to + 1;
      }
    }
    return b.finish();
  }
}, { decorations: (v) => v.decorations });

// ── mini harita: tüm belge kanvasa sıkıştırılır, görünür bölge kutu olarak çizilir ──
const minimap = ViewPlugin.fromClass(class {
  constructor(view) {
    this.view = view;
    this.wrap = document.createElement('div');
    this.wrap.className = 'cm-minimap';
    this.wrap.setAttribute('aria-hidden', 'true');
    this.canvas = document.createElement('canvas');
    this.wrap.appendChild(this.canvas);
    view.dom.appendChild(this.wrap);
    view.dom.classList.add('has-minimap');
    this.base = document.createElement('canvas');
    this.onScroll = () => this.overlay();
    view.scrollDOM.addEventListener('scroll', this.onScroll, { passive: true });
    let dragging = false;
    const jump = (e) => {
      const r = this.canvas.getBoundingClientRect();
      const frac = Math.max(0, Math.min(1, (e.clientY - r.top) / (this.contentH || 1)));
      const s = view.scrollDOM;
      s.scrollTop = frac * s.scrollHeight - s.clientHeight / 2;
    };
    this.wrap.addEventListener('pointerdown', (e) => { dragging = true; this.wrap.setPointerCapture(e.pointerId); jump(e); });
    this.wrap.addEventListener('pointermove', (e) => { if (dragging) jump(e); });
    this.wrap.addEventListener('pointerup', () => { dragging = false; });
    this.ro = new ResizeObserver(() => this.schedule());
    this.ro.observe(this.wrap);
    this.schedule();
  }
  update(u) {
    if (u.docChanged || u.geometryChanged || u.transactions.some((tr) => tr.effects.some((e) => e.is(setLayerEffect)))) this.schedule();
    else if (u.viewportChanged) this.overlay();
  }
  schedule() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.draw(), 120);
  }
  draw() {
    const view = this.view;
    const dpr = window.devicePixelRatio || 1;
    const W = this.wrap.clientWidth;
    const H = this.wrap.clientHeight;
    if (!W || !H) return;
    const doc = view.state.doc;
    const L = doc.lines;
    const lh = Math.min(2.5, H / L);
    this.contentH = Math.min(H, L * lh);
    for (const c of [this.canvas, this.base]) { c.width = W * dpr; c.height = H * dpr; }
    this.canvas.style.height = `${H}px`;
    const ctx = this.base.getContext('2d');
    ctx.scale(dpr, dpr);
    const css = getComputedStyle(view.dom);
    const text = css.getPropertyValue('--muted').trim() || '#999';
    const accent = css.getPropertyValue('--accent').trim() || '#777bb4';
    const err = css.getPropertyValue('--err').trim() || '#f66';
    const cw = W / 120;
    ctx.fillStyle = text;
    ctx.globalAlpha = 0.55;
    // satır başına lh piksel; belge sığmıyorsa her piksel satırına bir örnek satır
    const rows = lh >= 1 ? L : Math.floor(this.contentH);
    const rowH = lh >= 1 ? lh : 1;
    for (let k = 0; k < rows; k++) {
      const n = lh >= 1 ? k + 1 : 1 + Math.floor((k / this.contentH) * L);
      const line = doc.line(Math.min(L, n)).text;
      let ws = 0;
      while (ws < line.length && (line[ws] === ' ' || line[ws] === '	')) ws++;
      const len = line.length - ws;
      if (!len) continue;
      ctx.fillRect(Math.min(W - 2, ws * cw), k * rowH, Math.max(1, Math.min(W - ws * cw, len * cw)), Math.max(1, rowH * 0.7));
    }
    // katman işaretleri: arama sonuçları vurgu renginde, ölü kod ve düşük güven hata renginde
    ctx.globalAlpha = 0.9;
    const layers = view.state.field(layerField);
    const mark = (name, color) => {
      const set = layers[name];
      if (!set) return;
      ctx.fillStyle = color;
      let last = -1;
      set.between(0, doc.length, (from) => {
        const y = Math.floor(((doc.lineAt(from).number - 1) / L) * this.contentH);
        if (y !== last) { ctx.fillRect(W - 6, y, 6, Math.max(2, lh)); last = y; }
      });
    };
    mark('dead', err);
    mark('trust', err);
    mark('search', accent);
    mark('map', accent);
    const m = view.state.field(marksField);
    ctx.fillStyle = accent;
    m.bookmarks.between(0, doc.length, (from) => { ctx.fillRect(0, Math.floor(((doc.lineAt(from).number - 1) / L) * this.contentH), W, 2); });
    this.overlay();
  }
  overlay() {
    const ctx = this.canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.drawImage(this.base, 0, 0);
    const s = this.view.scrollDOM;
    if (!s.scrollHeight) return;
    ctx.scale(dpr, dpr);
    const y = (s.scrollTop / s.scrollHeight) * this.contentH;
    const h = Math.max(8, (s.clientHeight / s.scrollHeight) * this.contentH);
    const css = getComputedStyle(this.view.dom);
    ctx.fillStyle = css.getPropertyValue('--minimap-view').trim() || 'rgba(255,255,255,.08)';
    ctx.fillRect(0, y, this.wrap.clientWidth, h);
  }
  destroy() {
    clearTimeout(this.timer);
    this.ro.disconnect();
    this.view.scrollDOM.removeEventListener('scroll', this.onScroll);
    this.wrap.remove();
    this.view.dom.classList.remove('has-minimap');
  }
});

// Görünmez/kontrol karakterleri: sıfır genişlikli ve yön değiştirici (bidi) karakterler her zaman işaretlenir
// kaynakta satır sonu karakteri bulunmasın diye aralıklar sayı olarak verilir
const SPECIAL_RANGES = [[0xad], [0x61c], [0x180e], [0x200b, 0x200f], [0x2028, 0x2029], [0x202a, 0x202e], [0x2060, 0x2064], [0x2066, 0x2069], [0xfeff], [0xfff9, 0xfffb]];
const SPECIAL = new RegExp(`[${SPECIAL_RANGES.map(([a, b]) => (b ? `${String.fromCharCode(a)}-${String.fromCharCode(b)}` : String.fromCharCode(a))).join('')}]`);
const specialChars = highlightSpecialChars({
  addSpecialChars: SPECIAL,
  render(code, description, placeholder) {
    const s = document.createElement('span');
    s.className = 'cm-specialChar cm-ctrl';
    s.textContent = placeholder === '•' ? `\\u${code.toString(16).padStart(4, '0')}` : placeholder;
    s.title = description ?? `\\u${code.toString(16).padStart(4, '0')}`;
    return s;
  },
});

export const DEFAULT_VIEW = {
  fontSize: 13, wrap: false, invisibles: false, hexLines: false, ligatures: false,
  minimap: true, indentGuides: true, activeLine: true, tabWidth: 4,
};

/**
 * @param {HTMLElement} parent
 * @param {{readOnly?: boolean, label: string, onChange?: Function, onCursor?: Function, onContext?: Function, onScroll?: Function}} opts
 */
export function createEditor(parent, opts) {
  const comp = {
    lines: new Compartment(), wrap: new Compartment(), invis: new Compartment(), font: new Compartment(), lig: new Compartment(),
    minimap: new Compartment(), guides: new Compartment(), active: new Compartment(), unit: new Compartment(),
  };
  let cfg = { ...DEFAULT_VIEW };
  const compExt = (c) => ({
    lines: lineNumbers({ formatNumber: (n) => (c.hexLines ? n.toString(16).toUpperCase() : String(n)) }),
    wrap: c.wrap ? EditorView.lineWrapping : [],
    invis: c.invisibles ? highlightWhitespace() : [],
    font: EditorView.theme({ '&': { fontSize: `${c.fontSize}px` } }),
    lig: EditorView.editorAttributes.of({ class: c.ligatures ? 'cm-lig' : 'cm-nolig' }),
    minimap: c.minimap ? minimap : [],
    guides: c.indentGuides ? indentGuides : [],
    active: c.activeLine ? [highlightActiveLine(), highlightActiveLineGutter()] : [],
    unit: [indentUnit.of(' '.repeat(Math.max(1, Math.min(8, c.tabWidth)))), EditorState.tabSize.of(c.tabWidth)],
  });

  const extensions = () => {
    const ce = compExt(cfg);
    return [
      comp.lines.of(ce.lines), marksGutter, foldGutter({ openText: '▾', closedText: '▸' }),
      history({ minDepth: Number.MAX_SAFE_INTEGER, newGroupDelay: 600 }),
      drawSelection(), dropCursor(), rectangularSelection(), crosshairCursor(), indentOnInput(), phpBrackets,
      syntaxHighlighting(highlight), specialChars, highlightSelectionMatches(), search({ top: true }),
      php(), layerField, marksField, baseTheme,
      comp.wrap.of(ce.wrap), comp.invis.of(ce.invis), comp.font.of(ce.font), comp.lig.of(ce.lig),
      comp.minimap.of(ce.minimap), comp.guides.of(ce.guides), comp.active.of(ce.active), comp.unit.of(ce.unit),
      opts.readOnly ? EditorState.readOnly.of(true) : [],
      keymap.of([...defaultKeymap.filter((k) => k.key !== 'Mod-Enter'), ...historyKeymap, ...foldKeymap, ...searchKeymap, indentWithTab]),
      EditorView.contentAttributes.of({ 'aria-label': opts.label, 'aria-multiline': 'true' }),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) opts.onChange?.(u);
        if (u.docChanged || u.selectionSet) opts.onCursor?.(u.state);
      }),
      EditorView.domEventHandlers({
        contextmenu(e, view) {
          if (!opts.onContext) return false;
          const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
          if (pos == null) return false;
          e.preventDefault();
          const sel = view.state.selection.main;
          if (sel.empty || pos < sel.from || pos > sel.to) view.dispatch({ selection: { anchor: pos } });
          opts.onContext({ x: e.clientX, y: e.clientY }, pos);
          return true;
        },
      }),
    ];
  };

  const view = new EditorView({ parent, state: EditorState.create({ doc: '', extensions: extensions() }) });
  view.scrollDOM.addEventListener('scroll', () => opts.onScroll?.(), { passive: true });

  const reconfigure = () => {
    const ce = compExt(cfg);
    view.dispatch({ effects: Object.keys(comp).map((k) => comp[k].reconfigure(ce[k])) });
  };

  return {
    view,
    get text() { return view.state.doc.toString(); },
    get length() { return view.state.doc.length; },
    /** Sekme başına ayrı durum (geri alma geçmişi dahil) */
    createState(text) { return EditorState.create({ doc: text, extensions: extensions() }); },
    setState(state) { view.setState(state); reconfigure(); },
    get state() { return view.state; },
    /** Belgeyi değiştirir; geçmişe girer (geri alınabilir) */
    setText(text) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
    },
    applyEdits(edits) { view.dispatch({ changes: edits.map((e) => ({ from: e.from, to: e.to, insert: e.insert })) }); },
    select(from, to = from, { scroll = true, focus = false } = {}) {
      const len = view.state.doc.length;
      const a = Math.max(0, Math.min(len, from));
      const b = Math.max(0, Math.min(len, to));
      view.dispatch({ selection: { anchor: a, head: b }, effects: scroll ? EditorView.scrollIntoView(a, { y: 'center' }) : [] });
      if (focus) view.focus();
    },
    scrollTo(pos) { view.dispatch({ effects: EditorView.scrollIntoView(Math.max(0, Math.min(view.state.doc.length, pos)), { y: 'start' }) }); },
    setLayer(name, ranges) { view.dispatch({ effects: setLayerEffect.of({ name, set: buildLayer(view.state.doc, ranges) }) }); },
    hasLayer(name) { return Boolean(view.state.field(layerField)[name]?.size); },
    configure(next) { cfg = { ...cfg, ...next }; reconfigure(); },
    get cursor() { return view.state.selection.main.head; },
    get selection() { const s = view.state.selection.main; return { from: s.from, to: s.to, text: view.state.sliceDoc(s.from, s.to) }; },
    lineAt(pos) { return view.state.doc.lineAt(Math.max(0, Math.min(view.state.doc.length, pos))); },
    posOfLine(n) { const d = view.state.doc; return d.line(Math.max(1, Math.min(d.lines, n))).from; },
    toggleBookmark(pos = view.state.selection.main.head) { view.dispatch({ effects: marksEffect.of({ type: 'toggle', pos }) }); },
    setNote(pos, text) { view.dispatch({ effects: marksEffect.of({ type: 'note', pos, text }) }); },
    noteAt(pos) {
      const at = view.state.doc.lineAt(pos).from;
      let text = '';
      view.state.field(marksField).notes.between(at, at, (_f, _t, m) => { text = m.text; });
      return text;
    },
    resetMarks(m) { view.dispatch({ effects: marksEffect.of({ type: 'reset', bookmarks: m?.bookmarks ?? [], notes: m?.notes ?? [] }) }); },
    marks() {
      const m = view.state.field(marksField);
      const doc = view.state.doc;
      const bookmarks = [];
      const notes = [];
      m.bookmarks.between(0, doc.length, (from) => { bookmarks.push(doc.lineAt(from).number); });
      m.notes.between(0, doc.length, (from, _to, mk) => { notes.push({ line: doc.lineAt(from).number, text: mk.text }); });
      return { bookmarks, notes };
    },
    /** Sonraki/önceki yer imine git */
    nextBookmark(dir = 1) {
      const { bookmarks } = this.marks();
      if (!bookmarks.length) return false;
      const cur = view.state.doc.lineAt(view.state.selection.main.head).number;
      const target = dir > 0 ? bookmarks.find((n) => n > cur) ?? bookmarks[0] : [...bookmarks].reverse().find((n) => n < cur) ?? bookmarks[bookmarks.length - 1];
      const pos = view.state.doc.line(target).from;
      this.select(pos, pos, { focus: true });
      return true;
    },
    focus() { view.focus(); },
    get scrollDOM() { return view.scrollDOM; },
    /** Ekranın üstündeki satırın belge konumu (senkron kaydırma için) */
    topPos() { return view.lineBlockAtHeight(view.scrollDOM.scrollTop).from; },
    scrollToPos(pos) {
      const block = view.lineBlockAt(Math.max(0, Math.min(view.state.doc.length, pos)));
      view.scrollDOM.scrollTop = block.top;
    },
  };
}
