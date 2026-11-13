import { toBytes } from '../core/bstr.js';

// Bekçili sandbox'a istemci API'si (Node ve tarayıcı ortak). Her işten önce ilgili PHP sürümü yüklenir:
// yükleme uzun sürebilir (tarayıcıda WASM indirme), kod çalıştırma kısa son tarihle çalışır.
export const VERSIONS = ['8.3', '7.4', '5.2'];
export const LOAD_DEADLINE_MS = 90_000;
export const RUN_TIMEOUT_MS = 8000;

export function sandboxApi(send) {
  const load = async (version) => {
    const r = await send({ type: 'load', version, deadlineMs: LOAD_DEADLINE_MS });
    if (!r.ok) throw new Error(`PHP ${version} yüklenemedi: ${r.error}`);
  };
  return {
    versions: VERSIONS,
    async run({ code, version = '8.3', timeoutMs = RUN_TIMEOUT_MS }) {
      await load(version);
      // kod bstr'dir: PHP'ye baytlar olduğu gibi gider
      return send({ type: 'run', code: typeof code === 'string' ? toBytes(code) : code, version, deadlineMs: timeoutMs });
    },
    async evaluate({ exprs, version = '8.3', timeoutMs = RUN_TIMEOUT_MS }) {
      if (!exprs.length) return [];
      await load(version);
      const r = await send({ type: 'evaluate', exprs, version, deadlineMs: timeoutMs });
      return r.ok ? r.results : null;
    },
  };
}
