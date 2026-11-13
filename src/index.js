// Peel-PHP kütüphane API'si. Tarayıcıda ve Node'da aynı motor; PHP sandbox'ı php-wasm (WebAssembly) içinde çalışır.
//   import { deobfuscate, analyze, peel } from 'peel-php';
// Girdi metin (string) ya da bayt dizisi (Uint8Array) olabilir; ikili veri baytlar olarak korunur.
import { deobfuscate as runPipeline } from './core/pipeline.js';
import { analyze as runAnalyze } from './core/analyze.js';
import { fromBytes, fromText, toText } from './core/bstr.js';
import { PASSES } from './core/registry.js';

let shared = null;

/** Bekçili sandbox: Node'da worker_thread, tarayıcıda Web Worker */
export async function createSandbox() {
  if (typeof process !== 'undefined' && process.versions?.node) {
    const path = './sandbox/node-host.js';
    const { createNodeSandbox } = await import(/* @vite-ignore */ path);
    return createNodeSandbox();
  }
  const { createWebSandbox } = await import('./sandbox/web-host.js');
  return createWebSandbox();
}

const toBstr = (input) => (input instanceof Uint8Array ? fromBytes(input) : fromText(String(input)));

async function sandboxOf(option) {
  if (option === false || option === null) return null;
  if (option && typeof option === 'object') return option;
  shared ??= createSandbox();
  return shared;
}

/** @returns {Promise<{ code: string, text: string, stats, events, version, verified, trace, ms, error? }>} code bstr, text okunur metin */
export async function deobfuscate(input, { sandbox, ...options } = {}) {
  return runPipeline(toBstr(input), { ...options, sandbox: await sandboxOf(sandbox) });
}

/** Çöz + analiz et. Çözme başarısız olsa da (ör. ayrıştırılamayan ticari şifreli dosya) girdi analiz edilir. */
export async function peel(input, { sandbox, lang = 'tr', ...options } = {}) {
  const src = toBstr(input);
  const r = await runPipeline(src, { ...options, sandbox: await sandboxOf(sandbox) }).catch((e) => ({ error: e.message }));
  if (r.error) return { ...r, code: src, report: runAnalyze({ input: src, output: src, lang }) };
  const report = runAnalyze({ input: src, output: r.code, trace: r.trace, events: r.events, stats: r.stats, version: r.version, lang });
  return { ...r, report };
}

export const analyze = runAnalyze;
export const passes = () => PASSES.map(({ id, needsSandbox }) => ({ id, needsSandbox: Boolean(needsSandbox) }));
export { toText, fromText, fromBytes };
