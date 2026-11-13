// goto/etiket karmaşıklaştırmasını (YAK Pro tarzı) düz akışa çevirir. Her deyim listesi (program, fonksiyon gövdesi,
// iç bloklar) temel bloklara ayrılır: blok bir etiketle ya da koşullu atlamadan sonra başlar, sonunda "goto X",
// "if (C) { goto A; } goto B;", çıkış (return/throw/exit/break/continue) ya da düşme vardır.
// 1) Yapılandırma: baskınlık/art-baskınlık ile if/else ve while döngüleri geri kazanılır; tüm etiketler kalkar.
// 2) Olmazsa doğrusallaştırma: tek girişli bloklar atlamanın yerine taşınır, ölü etiketler ve ulaşılamayan
//    atlamalar silinir; çok girişli bloklar etiketiyle kalır.
// Çalışma sırası birebir korunur (yalnızca deyimlerin yeri değişir); fonksiyon/sınıf bildirimi içeren ulaşılamayan
// bloklar silinmez. İç içe listeler aynı çalıştırmada yeniden ayrıştırılarak sırayla işlenir.
import { tryParse, walk, span, applyEdits } from '../core/parse.js';

export const id = 'goto';

const FN = new Set(['function', 'closure', 'arrowfunc', 'method', 'class', 'interface', 'trait', 'enum']);
const LOOPS = new Set(['for', 'foreach', 'while', 'do', 'switch']);
const MAX_ITER = 40;
const END = -1; // listenin sonundan düşme
const EXIT = -2; // return/throw/exit/break/continue
const SINK = -3;

class Fail extends Error {}

const labelName = (n) => n.name?.name ?? n.name;
const gotoName = (n) => n.label?.name ?? n.label;

// "if (C) { goto A; }" (else yok) → A
function ifGoto(s) {
  if (s.kind !== 'if' || s.alternate) return null;
  const b = s.body?.kind === 'block' ? s.body.children : s.body ? [s.body] : [];
  return b.length === 1 && b[0].kind === 'goto' ? gotoName(b[0]) : null;
}

function isExit(s) {
  if (['return', 'throw', 'break', 'continue'].includes(s.kind)) return true;
  return s.kind === 'expressionstatement' && s.expression?.kind === 'exit';
}

// deyim (kendi döngüsü/switch'i dışında) break/continue içeriyor mu? (yeni while içine konursa anlamı değişir)
function looseBreak(s) {
  let found = false;
  const visit = (n, depth) => {
    if (!n || typeof n !== 'object' || found) return;
    if (Array.isArray(n)) { n.forEach((x) => visit(x, depth)); return; }
    if (!n.kind) return;
    if (FN.has(n.kind)) return;
    if ((n.kind === 'break' || n.kind === 'continue')) {
      const lvl = n.level?.value ? Number(n.level.value) : 1;
      if (lvl > depth) found = true;
      return;
    }
    const d = LOOPS.has(n.kind) ? depth + 1 : depth;
    for (const k of Object.keys(n)) if (k !== 'loc' && k !== 'leadingComments' && k !== 'trailingComments') visit(n[k], d);
  };
  visit(s, 0);
  return found;
}

const hasDecl = (s) => {
  let d = false;
  walk(s, (n) => { if (['function', 'class', 'interface', 'trait', 'enum'].includes(n.kind)) d = true; return !d; });
  return d;
};

// fonksiyon bağlamı başına: goto'lar ve etiketler (iç fonksiyonlara inilmez)
function contexts(ast) {
  const out = [];
  const collect = (root) => {
    const ctx = { root, gotos: [], labels: new Map(), lists: [] };
    out.push(ctx);
    const visit = (n, parent) => {
      if (!n || typeof n !== 'object') return;
      if (Array.isArray(n)) { n.forEach((x) => visit(x, parent)); return; }
      if (!n.kind) return;
      if (n !== root && FN.has(n.kind)) {
        if (n.body && n.kind !== 'class' && n.kind !== 'interface' && n.kind !== 'trait' && n.kind !== 'enum') collect(n);
        else visit(n.body, n);
        return;
      }
      if (n.kind === 'goto') ctx.gotos.push(n);
      if (n.kind === 'label') ctx.labels.set(labelName(n), n);
      if ((n.kind === 'program' || n.kind === 'block' || n.kind === 'declare' || n.kind === 'namespace') && Array.isArray(n.children)) ctx.lists.push(n.children);
      for (const k of Object.keys(n)) if (k !== 'loc' && k !== 'leadingComments' && k !== 'trailingComments') visit(n[k], n);
    };
    visit(root === ast ? ast : root.body, root);
  };
  collect(ast);
  return out;
}

function negate(code, test) {
  if (test.kind === 'unary' && test.type === '!') return code.slice(...span(test.what));
  return `!(${code.slice(...span(test))})`;
}

/** Tek deyim listesinin yeniden yazımı; değişiklik yoksa null */
function rewriteList(code, list, ctx, labelSeq) {
  if (list.some((s) => s.kind === 'inline' || s.kind === 'halt' || s.kind === 'namespace' || s.kind === 'declare')) return null;
  const hasLabels = list.some((s) => s.kind === 'label');
  const hasGotoTerm = list.some((s) => s.kind === 'goto' || ifGoto(s));
  if (!hasLabels && !hasGotoTerm) return null;
  const text = (s) => code.slice(...span(s));

  // --- temel bloklar
  const blocks = [];
  let cur = null;
  const open = (labels) => { cur = { labels, stmts: [], term: null, dead: [] }; blocks.push(cur); };
  open([]);
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    if (s.kind === 'label') {
      if (cur.term || cur.stmts.length) open([labelName(s)]);
      else cur.labels.push(labelName(s));
      continue;
    }
    if (cur.term) { cur.dead.push(s); continue; } // ulaşılamaz (sonraki etikete kadar)
    if (s.kind === 'goto') { cur.term = { type: 'jump', to: gotoName(s), node: s }; continue; }
    const a = ifGoto(s);
    if (a !== null) {
      const next = list[i + 1];
      if (next?.kind === 'goto') { cur.term = { type: 'cond', test: s.test, t: a, f: gotoName(next), node: s, fnode: next }; i++; continue; }
      cur.term = { type: 'cond', test: s.test, t: a, f: null, node: s };
      open([]);
      continue;
    }
    if (isExit(s)) { cur.term = { type: 'exit', node: s }; continue; }
    cur.stmts.push(s);
  }
  // ulaşılamaz deyimlerde bildirim varsa dokunulmaz
  if (blocks.some((b) => b.dead.some((s) => s.kind !== 'goto' && hasDecl(s)))) return null;

  const byLabel = new Map();
  blocks.forEach((b, i) => b.labels.forEach((l) => byLabel.set(l, i)));
  // listedeki etiketlere listenin terimleri dışından (iç deyimlerden ya da başka listelerden) gelen atlamalar
  const termGotos = new Set();
  blocks.forEach((b) => {
    if (b.term?.type === 'jump') termGotos.add(b.term.node);
    if (b.term?.type === 'cond') { termGotos.add(b.term.node.body?.kind === 'block' ? b.term.node.body.children[0] : b.term.node.body); if (b.term.fnode) termGotos.add(b.term.fnode); }
  });
  const external = new Map();
  for (const g of ctx.gotos) {
    if (termGotos.has(g)) continue;
    const bi = byLabel.get(gotoName(g));
    if (bi !== undefined) external.set(bi, (external.get(bi) ?? 0) + 1);
  }
  // terim hedefi: blok dizini, END ya da dış etiket (string)
  const target = (name) => (byLabel.has(name) ? byLabel.get(name) : `ext:${name}`);
  const fall = (i) => (i + 1 < blocks.length ? i + 1 : END);
  // boş yönlendirici blokları (yalnızca atlama/düşme) çöz
  const resolve = (t, seen = new Set(), keepExternal = true) => {
    while (typeof t === 'number' && t >= 0 && !seen.has(t)) {
      const b = blocks[t];
      if (b.stmts.length || (keepExternal && external.has(t))) return t;
      seen.add(t);
      if (!b.term) t = fall(t);
      else if (b.term.type === 'jump') t = target(b.term.to);
      else return t;
    }
    return t;
  };
  // dışarıdan atlanan ama listenin sonuna düşen boş bloklar (break/continue yerine geçen atlamalar): etiketleri
  // listenin sonuna yazılır, akışta END sayılır
  const endLabels = [];
  for (const [i] of [...external]) {
    if (!blocks[i].stmts.length && resolve(i, new Set(), false) === END) {
      endLabels.push(...blocks[i].labels);
      external.delete(i);
    }
  }
  const succ = (i) => {
    const b = blocks[i];
    if (!b.term) return [resolve(fall(i))];
    if (b.term.type === 'exit') return [EXIT];
    if (b.term.type === 'jump') return [resolve(target(b.term.to))];
    return [resolve(target(b.term.t)), resolve(b.term.f === null ? fall(i) : target(b.term.f))];
  };
  const entry = resolve(0);
  // canlı bloklar: girişten ulaşılabilen ya da dışarıdan atlanan
  const live = new Set();
  const stack = [entry, ...external.keys()].filter((x) => typeof x === 'number' && x >= 0);
  while (stack.length) {
    const i = stack.pop();
    if (live.has(i)) continue;
    live.add(i);
    for (const s of succ(i)) if (typeof s === 'number' && s >= 0) stack.push(s);
  }
  for (let i = 0; i < blocks.length; i++) {
    if (!live.has(i) && blocks[i].stmts.some(hasDecl)) return null; // bildirim içeren ölü blok: dokunma
  }
  const preds = new Map();
  const addPred = (t) => { if (typeof t === 'number' && t >= 0) preds.set(t, (preds.get(t) ?? 0) + 1); };
  addPred(entry);
  for (const i of live) succ(i).forEach(addPred);
  for (const [i, n] of external) preds.set(i, (preds.get(i) ?? 0) + n);

  const termText = (b) => text(b.term.node);
  const out = structured() ?? linear();
  const extNamesAll = new Set(ctx.gotos.filter((g) => !termGotos.has(g)).map(gotoName));
  for (const l of endLabels) if (extNamesAll.has(l) && !out.includes(`${l}:`)) out.push(`${l}:`);
  const result = out.join('\n');
  const [s0] = span(list[0]);
  const [, e0] = span(list[list.length - 1]);
  return result === code.slice(s0, e0) ? null : { start: s0, end: e0, text: result };

  // ---------- 1) yapılandırma
  function structured() {
    if (external.size) return null;
    if (typeof entry !== 'number') return null;
    if (entry < 0) return live.size ? null : [];
    const nodes = [...live];
    if ([...live].some((i) => succ(i).some((s) => typeof s === 'string'))) return null; // liste dışına atlama
    const succOf = (i) => succ(i).map((s) => (s === EXIT ? SINK : s));
    // baskınlar (girişten)
    const dom = new Map(nodes.map((n) => [n, new Set(nodes)]));
    dom.set(entry, new Set([entry]));
    const predList = new Map(nodes.map((n) => [n, []]));
    for (const n of nodes) for (const s of succOf(n)) if (s >= 0) predList.get(s).push(n);
    for (let changed = true; changed;) {
      changed = false;
      for (const n of nodes) {
        if (n === entry) continue;
        const ps = predList.get(n);
        let next = null;
        for (const p of ps) next = next === null ? new Set(dom.get(p)) : new Set([...next].filter((x) => dom.get(p).has(x)));
        next = next ?? new Set();
        next.add(n);
        if (next.size !== dom.get(n).size) { dom.set(n, next); changed = true; }
      }
    }
    // art-baskınlar (SINK'e)
    const all = [...nodes, END, SINK];
    const pdom = new Map(all.map((n) => [n, new Set(all)]));
    pdom.set(SINK, new Set([SINK]));
    pdom.set(END, new Set([END, SINK]));
    for (let changed = true; changed;) {
      changed = false;
      for (const n of nodes) {
        let next = null;
        for (const s of succOf(n)) next = next === null ? new Set(pdom.get(s)) : new Set([...next].filter((x) => pdom.get(s).has(x)));
        next = next ?? new Set();
        next.add(n);
        if (next.size !== pdom.get(n).size) { pdom.set(n, next); changed = true; }
      }
    }
    // SINK'e ulaşamayan (sonsuz döngü) varsa vazgeç
    if (nodes.some((n) => !pdom.get(n).has(SINK))) return null;
    const ipdom = (n) => {
      const cands = [...pdom.get(n)].filter((x) => x !== n);
      // en yakın: diğer tüm adayların art-baskını olan
      return cands.find((c) => cands.every((o) => o === c || pdom.get(c).has(o))) ?? SINK;
    };
    const headers = new Set();
    for (const n of nodes) for (const s of succOf(n)) if (s >= 0 && dom.get(n).has(s)) headers.add(s);

    let emitted = new Set();
    const emitStmts = (b, out, inLoop) => {
      for (const s of b.stmts) {
        if (inLoop && looseBreak(s)) throw new Fail();
        out.push(text(s));
      }
    };
    // stop: bölgenin bittiği düğüm; null: bölge yalnızca çıkış terimleriyle bitmeli
    const emit = (start, stop, loop) => {
      const out = [];
      let b = start;
      for (;;) {
        if (b === stop) return out;
        if (b === END || b === SINK) { if (stop === END || stop === SINK) return out; throw new Fail(); }
        if (b === EXIT) return out;
        if (emitted.has(b) || (loop && (b === loop.header || b === loop.exit))) throw new Fail();
        emitted.add(b);
        const blk = blocks[b];
        if (headers.has(b)) {
          if (blk.stmts.length || blk.term?.type !== 'cond') throw new Fail();
          const [t, f] = succ(b);
          const inT = t >= 0 && dom.get(t)?.has(b) && reaches(t, b);
          const inF = f >= 0 && dom.get(f)?.has(b) && reaches(f, b);
          if (inT === inF) throw new Fail();
          const body = inT ? t : f;
          const exit = inT ? f : t;
          const cond = inT ? code.slice(...span(blk.term.test)) : negate(code, blk.term.test);
          const inner = emit(body, b, { header: b, exit });
          out.push(`while (${cond}) {`, ...inner, '}');
          b = exit === EXIT ? SINK : exit;
          if (b === SINK) return out;
          continue;
        }
        emitStmts(blk, out, Boolean(loop));
        const t = blk.term;
        if (t?.type === 'exit') {
          if (loop && looseBreak(t.node)) throw new Fail();
          if (loop && (t.node.kind === 'break' || t.node.kind === 'continue')) throw new Fail();
          out.push(termText(blk));
          return out;
        }
        if (t?.type !== 'cond') { b = succ(b)[0]; continue; }
        const [tt, ff] = succ(b);
        const j = ipdom(b);
        const testT = code.slice(...span(t.test));
        if (j !== SINK) {
          const thenL = emit(tt, j, loop);
          const elseL = emit(ff, j, loop);
          pushIf(out, testT, negate(code, t.test), thenL, elseL);
          b = j;
          continue;
        }
        // bir dal yalnızca çıkışla bitiyor (return/throw): if (C) { dal } ve diğer dalla devam
        const saved = new Set(emitted);
        let done = false;
        for (const [first, rest, cond] of [[tt, ff, testT], [ff, tt, negate(code, t.test)]]) {
          try {
            const branch = emit(first, null, loop);
            out.push(`if (${cond}) {`, ...branch, '}');
            b = rest;
            done = true;
            break;
          } catch (e) {
            if (!(e instanceof Fail)) throw e;
            emitted = new Set(saved);
          }
        }
        if (!done) throw new Fail();
      }
    };
    const reaches = (from, to) => {
      const seen = new Set();
      const st = [from];
      while (st.length) {
        const n = st.pop();
        if (n === to) return true;
        if (n < 0 || seen.has(n)) continue;
        seen.add(n);
        st.push(...succOf(n));
      }
      return false;
    };
    try {
      const out = emit(entry, END, null);
      if ([...live].some((i) => !emitted.has(i))) return null;
      return out;
    } catch (e) {
      if (e instanceof Fail) return null;
      throw e;
    }
  }

  function pushIf(out, test, neg, thenL, elseL) {
    if (!thenL.length && !elseL.length) { out.push(`if (${test}) {`, '}'); return; }
    if (!thenL.length) { out.push(`if (${neg}) {`, ...elseL, '}'); return; }
    out.push(`if (${test}) {`, ...thenL, ...(elseL.length ? ['} else {', ...elseL] : []), '}');
  }

  // ---------- 2) doğrusallaştırma (etiketli bloklar korunur)
  function linear() {
    const out = [];
    const emitted = new Set();
    const wanted = new Set(); // etiketi gereken bloklar
    const labelOf = new Map();
    const nameOf = (i) => {
      if (!labelOf.has(i)) labelOf.set(i, blocks[i].labels[0] ?? `peel_L${labelSeq.next()}`);
      return labelOf.get(i);
    };
    let endLabel = null;
    const jumpText = (t) => {
      if (typeof t === 'string') return `goto ${t.slice(4)};`;
      if (t === END) { endLabel ??= `peel_end${labelSeq.next()}`; return `goto ${endLabel};`; }
      wanted.add(t);
      return `goto ${nameOf(t)};`;
    };
    for (const i of external.keys()) wanted.add(i);
    const order = [entry, ...[...live].filter((i) => i !== entry).sort((a, b) => a - b)];
    const lines = []; // { block } yer tutucu ya da metin
    if (typeof entry === 'string') lines.push(jumpText(entry));
    for (const start of order) {
      if (emitted.has(start) || typeof start !== 'number' || start < 0) continue;
      let b = start;
      while (typeof b === 'number' && b >= 0 && !emitted.has(b)) {
        emitted.add(b);
        lines.push({ block: b });
        const blk = blocks[b];
        blk.stmts.forEach((s) => lines.push(text(s)));
        const t = blk.term;
        if (t?.type === 'exit') { lines.push(termText(blk)); b = null; break; }
        let next;
        if (t?.type === 'cond') {
          const [tt, ff] = succ(b);
          lines.push(`if (${code.slice(...span(t.test))}) {`, jumpText(tt), '}');
          next = ff;
        } else next = succ(b)[0];
        if (typeof next === 'number' && next >= 0 && !emitted.has(next) && preds.get(next) === 1 && !external.has(next)) { b = next; continue; }
        if (next === END && order.every((o) => emitted.has(o) || o === b)) { b = null; break; }
        lines.push(jumpText(next));
        b = null;
      }
    }
    // dışarıdan atlanan etiketler (iç deyimlerden ya da başka listelerden) adlarıyla korunur
    const extNames = new Set(ctx.gotos.filter((g) => !termGotos.has(g)).map(gotoName));
    for (const l of lines) {
      if (typeof l === 'string') { out.push(l); continue; }
      const names = new Set(blocks[l.block].labels.filter((n) => extNames.has(n)));
      if (wanted.has(l.block)) names.add(nameOf(l.block));
      for (const n of names) out.push(`${n}:`);
    }
    if (endLabel) out.push(`${endLabel}:`);
    // "goto X; X:" → atlama gereksiz
    const GOTO = /^goto ([A-Za-z_\x80-\xff][\w\x80-\xff]*);$/;
    for (let i = out.length - 2; i >= 0; i--) {
      const m = GOTO.exec(out[i]);
      if (m && out[i + 1] === `${m[1]}:`) out.splice(i, 1);
    }
    // başvurusu kalmayan etiketler silinir
    const refs = new Set([...out.join('\n').matchAll(/\bgoto\s+([A-Za-z_\x80-\xff][\w\x80-\xff]*)\s*;/g)].map((m) => m[1]));
    extNames.forEach((n) => refs.add(n));
    return out.filter((l) => !(/^[A-Za-z_\x80-\xff][\w\x80-\xff]*:$/.test(l) && !refs.has(l.slice(0, -1))));
  }
}

// döngü/switch içinden hemen arkasındaki etikete atlama → break; döngü gövdesinin sonundaki etikete → continue
// (yalnızca araya başka döngü/switch girmeyen doğrudan atlamalar)
function loopJumps(ctxs) {
  const edits = [];
  for (const c of ctxs) {
    for (const list of c.lists) {
      list.forEach((s, k) => {
        if (!LOOPS.has(s.kind) || !s.body) return;
        const after = new Set();
        for (let j = k + 1; j < list.length && list[j].kind === 'label'; j++) after.add(labelName(list[j]));
        const cont = new Set();
        const bodyList = s.kind !== 'switch' && s.body.kind === 'block' ? s.body.children : [];
        for (let j = bodyList.length - 1; j >= 0 && bodyList[j].kind === 'label'; j--) cont.add(labelName(bodyList[j]));
        if (!after.size && !cont.size) return;
        const visit = (n) => {
          if (!n || typeof n !== 'object') return;
          if (Array.isArray(n)) { n.forEach(visit); return; }
          if (!n.kind || FN.has(n.kind) || LOOPS.has(n.kind)) return;
          if (n.kind === 'goto') {
            const name = gotoName(n);
            if (after.has(name)) edits.push({ start: n.loc.start.offset, end: n.loc.end.offset, text: 'break;' });
            else if (cont.has(name)) edits.push({ start: n.loc.start.offset, end: n.loc.end.offset, text: 'continue;' });
            return;
          }
          for (const key of Object.keys(n)) if (key !== 'loc' && key !== 'leadingComments' && key !== 'trailingComments') visit(n[key]);
        };
        if (s.kind === 'switch') visit(s.body.children ?? s.body);
        else visit(s.body);
      });
    }
  }
  return edits;
}

export async function run(code, ctx) {
  let cur = code;
  let total = 0;
  let seq = 0;
  const labelSeq = { next: () => ++seq };
  for (let iter = 0; iter < MAX_ITER; iter++) {
    const parsed = tryParse(cur);
    if (!parsed) break;
    const ctxs = contexts(parsed.ast);
    const jumps = loopJumps(ctxs);
    if (jumps.length) {
      const next = applyEdits(cur, jumps).code;
      if (tryParse(next)) { cur = next; total += jumps.length; continue; }
    }
    const edits = [];
    for (const c of ctxs) {
      for (const list of c.lists) {
        if (!list.length) continue;
        const [s] = span(list[0]);
        const [, e] = span(list[list.length - 1]);
        // daha dıştaki bir liste bu turda değişiyorsa içtekine sonraki turda bakılır
        if (edits.some((x) => x.start <= s && x.end >= e)) continue;
        const r = rewriteList(cur, list, c, labelSeq);
        if (r) {
          for (let k = edits.length - 1; k >= 0; k--) if (edits[k].start >= r.start && edits[k].end <= r.end) edits.splice(k, 1);
          edits.push(r);
        }
      }
    }
    if (!edits.length) break;
    const next = applyEdits(cur, edits).code;
    if (!tryParse(next) || next === cur) break;
    cur = next;
    total += edits.length;
  }
  if (cur === code) return code;
  ctx.log(`goto: ${total} etiketli liste düz akışa çevrildi`, 'info');
  ctx.bump('goto', total);
  return cur;
}
