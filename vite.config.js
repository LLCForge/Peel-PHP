import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const ROOT = fileURLToPath(new URL('.', import.meta.url));

// @php-wasm/web tüm PHP sürümlerini (8.5 … 5.2, her biri JSPI + asyncify) ve intl eklentisini (icu.dat 30 MB)
// dinamik import ile bağlar. Peel yalnızca sandbox/api.js'teki sürümleri kullanır ve intl yüklemez; geri kalanlar
// boş modüle çözülür ki derleme çıktısı yüzlerce MB'a çıkmasın ve 25 MiB'lık tek dosya sınırını aşan icu.dat girmesin.
const USED = new Set(['8-3', '7-4', '5-2']);
const STUB = '\0peel-php-stub';

function trimPhpWasm() {
  return {
    name: 'peel-trim-php-wasm',
    enforce: 'pre',
    resolveId(id) {
      const m = /^@php-wasm\/web-(\d-\d)$/.exec(id);
      if (m && !USED.has(m[1])) return STUB;
      if (/(^|\/)shared\/icu\.dat$/.test(id) || /extensions\/intl\/intl\.so\?url$/.test(id)) return STUB;
      return null;
    },
    load(id) {
      if (id !== STUB) return null;
      return 'const fail = async () => { throw new Error("Bu PHP sürümü/eklentisi Peel derlemesinde yok"); };\n'
        + 'export const getPHPLoaderModule = fail;\nexport const getIntlExtensionPath = fail;\nexport default "";\n';
    },
  };
}

export default defineConfig({
  plugins: [trimPhpWasm()],
  // php-parser tamsayı sınırını process.arch'tan okur; Node'daki (testler, CLI) 64 bit davranışla aynı olsun
  define: { 'process.arch': '"x64"' },
  // php-wasm yükleyicisi .wasm dosyasını new URL(..., import.meta.url) ile bulur: ön paketleme yolu bozar
  optimizeDeps: { exclude: ['@php-wasm/web', '@php-wasm/web-8-3', '@php-wasm/web-7-4', '@php-wasm/web-5-2'] },
  assetsInclude: [/\.dat$/, /\.so$/, /\.la$/],
  worker: { format: 'es', plugins: () => [trimPhpWasm()] },
  build: { target: 'es2022', chunkSizeWarningLimit: 4096 },
  // node_modules bir bağlantı (junction/symlink) olabilir: gerçek yolu da dev sunucusunun izin listesine girer
  server: { fs: { allow: [ROOT, realpathSync(new URL('./node_modules', import.meta.url))] } },
});
