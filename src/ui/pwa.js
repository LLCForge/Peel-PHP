// Service worker kaydı: yalnızca derlenmiş (üretim) sürümde ve güvenli bağlamda.
// Geliştirme sunucusunda kaydedilmez; aynı kökende daha önce (ör. `vite preview` ile) kaydolmuş bir worker
// varsa kaldırılır ve önbelleği silinir, yoksa dev modüllerini eski önbellekten sunar.
export function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
  if (!import.meta.env.PROD) {
    navigator.serviceWorker.getRegistrations()
      .then(async (regs) => {
        if (!regs.length) return;
        await Promise.all(regs.map((r) => r.unregister()));
        for (const key of await caches.keys()) await caches.delete(key);
        if (navigator.serviceWorker.controller) location.reload();
      })
      .catch(() => {});
    return;
  }
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(new URL('sw.js', document.baseURI), { scope: './' }).catch(() => {
      // kayıt başarısız olursa uygulama çevrimiçi çalışmaya devam eder
    });
  });
}
