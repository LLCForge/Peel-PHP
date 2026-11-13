// Tarayıcı için bekçili sandbox: PHP bir Web Worker'da çalışır; son tarihi aşan (sonsuz döngü, felaket regex)
// worker sonlandırılır, sıradaki istek yeni bir worker'da başlar. node-host.js'in tarayıcı karşılığı.
import { sandboxApi } from './api.js';
import { createWatchdog } from './watchdog.js';

export function createWebSandbox() {
  const dog = createWatchdog({
    spawn() {
      const w = new Worker(new URL('./web-worker.js', import.meta.url), { type: 'module', name: 'peel-php-sandbox' });
      let onErr = () => {};
      w.addEventListener('error', (e) => { e.preventDefault(); onErr(e.message || 'Sandbox worker yüklenemedi'); });
      w.addEventListener('messageerror', () => onErr('Sandbox mesajı çözülemedi'));
      return {
        post: (m) => w.postMessage(m),
        onMessage: (cb) => w.addEventListener('message', (e) => cb(e.data)),
        onError: (cb) => { onErr = cb; },
        terminate: () => { onErr = () => {}; w.terminate(); },
      };
    },
  });
  // kill: arayüzdeki Durdur; uçuştaki ve kuyruktaki işler hata alır, worker yeniden başlatılır
  return { ...sandboxApi(dog.send), watchdogStats: dog.stats, kill: (reason) => dog.kill(reason), close: () => dog.terminate() };
}
