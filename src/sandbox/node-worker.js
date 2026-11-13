// worker_threads tarafı: php-wasm Node runtime'ı (dosya sistemi bellekte, ağ php.ini ile kapalı)
import { parentPort, threadId } from 'node:worker_threads';
import { PHP } from '@php-wasm/universal';
import { loadNodeRuntime } from '@php-wasm/node';
import { createEngine } from './engine.js';

const engine = createEngine(async (version) => new PHP(await loadNodeRuntime(version, { emscriptenOptions: { processId: threadId + 1 } })));

parentPort.on('message', async ({ id, ...msg }) => {
  let result;
  try {
    result = await engine.handle(msg);
  } catch (err) {
    result = { ok: false, error: err?.message ?? String(err) };
  }
  parentPort.postMessage({ id, ...result });
});
