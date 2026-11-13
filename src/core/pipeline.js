// Çözme hattı: sürüm seçimi → davranış temeli → değişiklik durana kadar pass turları → biçimlendirme.
// Her pass'ten sonra kod yeniden ayrıştırılır ve (sandbox varsa) çalıştırılıp çıktısı ile yan etkileri temelle
// karşılaştırılır; fark varsa o pass geri alınır.
import { PASSES } from './registry.js';
import { tryParse } from './parse.js';
import { decodeTrace } from './layers.js';
import { format } from './format.js';
import { toText } from './bstr.js';

const MAX_ROUNDS = 16;
const FATAL = new Set([1, 4, 16, 64]); // E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR

const LEGACY = /\/e modifier is no longer supported|Unknown modifier 'e'/;

const fatalOf = (trace) => (trace?.errors ?? []).filter((e) => FATAL.has(e.type));

/** Kod hangi PHP sürümünde çalışıyor? Önce 8.3; sözdizimi/fatal hatada eski sürümler. */
async function pickVersion(sandbox, code, log) {
  let best = null;
  for (const version of sandbox.versions) {
    const r = await sandbox.run({ code, version });
    const trace = decodeTrace(r.trace);
    const fatal = r.ok ? fatalOf(trace).length : 99;
    // eski PHP'ye özgü özellik uyarısı (preg_replace /e): kod yeni sürümde sessizce hiçbir şey yapmıyor olabilir
    const legacy = (trace?.errors ?? []).some((e) => LEGACY.test(e.message)) ? 1 : 0;
    const score = fatal * 1000 + legacy * 500 - (trace?.evals.length ?? 0);
    if (!best || score < best.score) best = { version, score, run: r, trace };
    if (r.ok && fatal === 0 && !legacy) break;
    log(`PHP ${version}: ${r.ok ? (fatal ? `${fatal} fatal hata (${fatalOf(trace)[0]?.message ?? ''})` : 'eski sürüm özelliği (preg_replace /e)') : r.error}`, 'info');
  }
  return best;
}

function snapshotOf(r) {
  const t = decodeTrace(r.trace);
  return {
    ok: r.ok,
    out: r.stdout ?? '',
    fx: JSON.stringify((t?.fx ?? []).map(([k, a]) => [k, a])),
    fatal: fatalOf(t).length > 0,
  };
}

const same = (a, b) => a.ok === b.ok && a.out === b.out && a.fx === b.fx && a.fatal === b.fatal;

/**
 * @param {string} input kaynak (bstr)
 * @param {object} o
 * @param {ReturnType<import('../sandbox/api.js').sandboxApi>|null} o.sandbox
 */
export async function deobfuscate(input, { sandbox = null, only = null, onLog = () => {}, onPass = () => {}, onSnapshot = () => {}, signal = null, formatOutput = true } = {}) {
  const t0 = Date.now();
  const stats = {};
  const events = [];
  const log = (m, level = 'info') => onLog(m, level);
  const checkAbort = () => { if (signal?.aborted) throw new Error('Durduruldu'); };
  let code = input.replace(/^\xEF\xBB\xBF/, '');

  if (!tryParse(code)) return { error: 'Kod ayrıştırılamadı (PHP sözdizimi hatası)', code: input, events, stats };

  let version = '8.3';
  let baseline = null;
  let firstTrace = null;
  if (sandbox) {
    const picked = await pickVersion(sandbox, code, log);
    version = picked.version;
    firstTrace = picked.trace;
    baseline = picked.run.ok ? snapshotOf(picked.run) : null;
    log(`çalışma sürümü: PHP ${version}${baseline ? '' : ' (çalıştırılamadı, yalnızca statik dönüşümler)'}`, 'info');
  }

  // aynı kod için sandbox çalıştırması önbelleklenir (layers pass'i ve doğrulama aynı çalıştırmayı kullanır)
  const runs = new Map();
  const runCode = async (c) => {
    if (!runs.has(c)) {
      if (runs.size > 64) runs.delete(runs.keys().next().value);
      runs.set(c, await sandbox.run({ code: c, version }));
    }
    return runs.get(c);
  };

  const ctx = {
    sandbox,
    version,
    log,
    bump: (k, n = 1) => { if (n) stats[k] = (stats[k] ?? 0) + n; },
    trace: async (c) => decodeTrace((await runCode(c)).trace),
    evaluate: (exprs, defs = '') => sandbox.evaluate({ exprs, defs, version }),
  };

  const passes = PASSES.filter((p) => (!only || only.includes(p.id)) && (!p.needsSandbox || sandbox));
  const seen = new Set([code]);
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    let changed = false;
    for (const p of passes) {
      checkAbort();
      const t = Date.now();
      onPass(p.id, 'run');
      let next;
      try {
        next = await p.run(code, ctx);
      } catch (e) {
        log(`${p.id}: ${e.message}, geri alındı`, 'warn');
        events.push({ id: p.id, round, state: 'fail', reason: e.message, ms: Date.now() - t });
        onPass(p.id, 'fail');
        continue;
      }
      checkAbort();
      if (next === code || next == null) {
        events.push({ id: p.id, round, state: 'skip', ms: Date.now() - t });
        onPass(p.id, 'skip');
        continue;
      }
      if (!tryParse(next)) {
        log(`${p.id}: çıktı ayrıştırılamadı, geri alındı`, 'warn');
        events.push({ id: p.id, round, state: 'fail', reason: 'parse', ms: Date.now() - t });
        onPass(p.id, 'fail');
        continue;
      }
      if (baseline) {
        const snap = snapshotOf(await runCode(next));
        if (!same(baseline, snap)) {
          log(`${p.id}: davranış değişti, geri alındı`, 'warn');
          events.push({ id: p.id, round, state: 'fail', reason: 'davranış', ms: Date.now() - t });
          onPass(p.id, 'fail');
          continue;
        }
      }
      code = next;
      changed = true;
      events.push({ id: p.id, round, state: 'ok', ms: Date.now() - t });
      onPass(p.id, 'ok');
      onSnapshot({ id: p.id, round, code });
    }
    if (!changed || seen.has(code)) break;
    seen.add(code);
  }

  let out = code;
  if (formatOutput) {
    const formatted = await format(code);
    if (formatted && formatted !== code && tryParse(formatted)) {
      if (!baseline || same(baseline, snapshotOf(await runCode(formatted)))) out = formatted;
      else log('biçimlendirme davranışı değiştirdi, biçimsiz çıktı verildi', 'warn');
    }
  }

  const finalTrace = sandbox && baseline ? decodeTrace((await runCode(out)).trace) : null;
  return {
    code: out,
    text: toText(out),
    stats,
    events,
    version,
    verified: Boolean(baseline),
    trace: { first: firstTrace, final: finalTrace },
    ms: Date.now() - t0,
  };
}
