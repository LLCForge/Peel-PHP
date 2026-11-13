// Web Worker tarafı: php-wasm web runtime'ı (dosya sistemi bellekte, ağ php.ini ile kapalı; tcpOverFetch verilmez,
// yani PHP'nin soket katmanı tarayıcıda hiçbir yere bağlanamaz). Ana thread'i kilitlememek için ayrı worker'da çalışır.
import { PHP } from '@php-wasm/universal';
import { loadWebRuntime } from '@php-wasm/web';
import { createEngine } from './engine.js';

const engine = createEngine(async (version) => new PHP(await loadWebRuntime(version)));

self.addEventListener('message', async ({ data }) => {
  const { id, ...msg } = data ?? {};
  let result;
  try {
    result = await engine.handle(msg);
  } catch (err) {
    result = { ok: false, error: err?.message ?? String(err) };
  }
  self.postMessage({ id, ...result });
});
