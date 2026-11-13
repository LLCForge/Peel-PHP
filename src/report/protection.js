// Ticari şifreleme (ionCube, SourceGuardian, Zend Guard, phpBolt, Swoole Compiler, phpSHIELD, NuCoder) tanıma.
// Bilinçli karar: bu ürünlerin şifreli bölümü ÇÖZÜLMEZ (ticari lisans korumasını aşmak kapsam dışı). Yalnızca
// dosyada açık duran meta veriler okunur: ürün, başlık, gereken loader, loader sarmalayıcısının ne yaptığı.
import { pick, snippet } from './text.js';

const t = (tr, en = tr) => ({ tr, en });

const COMMON = t(
  'Şifreli bölüm bilinçli olarak çözülmez: ticari lisans korumasını aşmak bu aracın kapsamı dışındadır. Kodun içeriği ve olası lisans kısıtları (alan adı, IP, son kullanma) yalnızca şifreli bölümdedir.',
  'The encrypted part is intentionally not decoded: bypassing commercial licence protection is out of scope. The code and any licence restrictions (domain, IP, expiry) live only inside the encrypted part.',
);

// Loader sarmalayıcısının dosyada açıkça yaptıkları
function wrapperNotes(text, lang) {
  const n = [];
  if (/\bdl\s*\(/.test(text)) n.push(t('Sarmalayıcı loader eklentisini dl() ile çalışma anında yüklemeyi dener (enable_dl açıksa).', 'The wrapper tries to load the loader extension at runtime with dl() (when enable_dl is on).'));
  if (/extension_dir/.test(text)) n.push(t('Loader dosyasını extension_dir ve göreli dizinlerde arar.', 'It searches extension_dir and relative directories for the loader file.'));
  if (/php_uname|PHP_INT_SIZE|PHP_ZTS|ZEND_THREAD_SAFE/.test(text)) n.push(t('Doğru loader dosyasını seçmek için PHP sürümü, işletim sistemi, iş parçacığı güvenliği ve bit genişliği okunur.', 'PHP version, OS, thread safety and word size are read to choose the right loader file.'));
  if (/\b(?:die|exit)\s*\(/.test(text)) n.push(t('Loader yoksa kurulum talimatıyla birlikte çalışmayı durdurur (die/exit).', 'Without the loader it stops with installation instructions (die/exit).'));
  return n.map((x) => pick(x, lang));
}

const urlsIn = (s) => [...new Set(s.match(/https?:\/\/[^\s'"<>)]+/g) ?? [])];

const PRODUCTS = [
  {
    product: 'SourceGuardian',
    test: (s) => /\bsg_load\s*\(/.test(s) && (/ixed/.test(s) || /SourceGuardian/i.test(s)),
    info(s, lang) {
      const notes = [];
      const head = s.match(/sg_load\(\s*'([0-9A-F]{16})/);
      if (head) notes.push(pick(t(`sg_load başlık kimliği (şifresiz): ${head[1]}`, `sg_load header id (plain): ${head[1]}`), lang));
      const len = s.match(/sg_load\(\s*'[0-9A-F]{16}([A-Za-z0-9+/=]+)'/)?.[1].length;
      if (len) notes.push(pick(t(`Şifreli yük: ${len} base64 karakter`, `Encrypted payload: ${len} base64 characters`), lang));
      const dl = s.match(/https?:\/\/www\.sourceguardian\.com\/loaders\/[^'"\s?]*/)?.[0];
      if (dl) notes.push(pick(t(`Loader indirme adresi (sürüm/OS bilgisi sorgu dizgesine eklenir): ${dl}`, `Loader download URL (PHP/OS details are appended as query string): ${dl}`), lang));
      const min = s.match(/version_compare\(\$\w+,\s*'([\d.]+)',\s*'<'\)/)?.[1];
      if (min) notes.push(pick(t(`PHP ${min} öncesinde loader'ı göreli ./ixed dizininden dl() ile yüklemeyi dener.`, `Before PHP ${min} it tries dl() from a relative ./ixed directory.`), lang));
      return { version: null, loader: "ixed.<PHP major.minor>[ts].<os: lin|win|dar|fre…> (SourceGuardian loader)", notes };
    },
  },
  {
    product: 'ionCube',
    test: (s) => /^<\?php\s*\/\/(?:ICB0|[0-9a-f]{4,6}\b)/.test(s) || /ioncube_loader_|ionCube Loader|\b_il_exec\s*\(/.test(s),
    info(s, lang) {
      const notes = [];
      const head = s.match(/^<\?php\s*\/\/([^\r\n]{1,80})/)?.[1]?.trim();
      if (head) notes.push(pick(t(`Dosya başlığı (şifresiz): //${head}`, `File header (plain): //${head}`), lang));
      if (head?.startsWith('ICB0')) {
        const targets = [...head.matchAll(/\b(\d)(\d):[0-9a-f]+/g)].map((m) => `${m[1]}.${m[2]}`);
        if (targets.length) notes.push(pick(t(`Başlıktaki PHP hedefleri (yorum): ${targets.join(', ')}`, `PHP targets in header (interpretation): ${targets.join(', ')}`), lang));
      }
      const dl = urlsIn(s).filter((u) => /ioncube/i.test(u));
      if (dl.length) notes.push(pick(t(`Loader bilgisi adresi: ${dl.join(', ')}`, `Loader info URL: ${dl.join(', ')}`), lang));
      return { version: null, loader: 'ioncube_loader_<os>_<PHP major.minor>.so|.dll (ionCube Loader)', notes };
    },
  },
  {
    product: 'Zend Guard',
    test: (s) => /^<\?php\s+@Zend;/.test(s) || /Zend Guard Loader|ZendGuardLoader|Zend Optimizer/.test(s) && /@Zend;|This file was encoded by/.test(s),
    info(s, lang) {
      const id = s.match(/^<\?php\s+@Zend;\s*(\d+);/)?.[1];
      const notes = [pick(t('Zend Guard Loader yalnızca PHP 5.3-5.6 için yayımlandı; PHP 5.2 ve öncesi Zend Optimizer kullanır. PHP 7+ için loader yoktur.', 'Zend Guard Loader was released for PHP 5.3-5.6 only; PHP 5.2 and earlier use Zend Optimizer. There is no loader for PHP 7+.'), lang)];
      if (id) notes.unshift(pick(t(`Başlık sayısı (şifresiz): ${id}`, `Header number (plain): ${id}`), lang));
      return { version: null, loader: 'ZendGuardLoader (PHP 5.3-5.6) / Zend Optimizer (PHP ≤ 5.2)', notes };
    },
  },
  {
    product: 'phpBolt',
    test: (s) => /\bbolt_decrypt\s*\(/.test(s),
    info: (s, lang) => ({ version: null, loader: 'bolt.so / php_bolt.dll (phpBolt eklentisi)', notes: [pick(t('bolt_decrypt(__FILE__, …) çağrısı: yük, dosyanın kendisinden phpBolt eklentisiyle çözülür.', 'bolt_decrypt(__FILE__, …) call: the payload is decrypted from the file itself by the phpBolt extension.'), lang)] }),
  },
  {
    product: 'Swoole Compiler',
    test: (s) => /swoole_loader/i.test(s),
    info: (s, lang) => ({ version: null, loader: snippet(s.match(/swoole_loader[\w.]*/i)?.[0] ?? 'swoole_loader', 60), notes: [pick(t('Swoole Compiler çıktısı: swoole_loader eklentisi gerekir.', 'Swoole Compiler output: requires the swoole_loader extension.'), lang)] }),
  },
  {
    product: 'phpSHIELD',
    test: (s) => /phpshield/i.test(s) && /\bdl\s*\(|extension_loaded|loader/i.test(s),
    info: (s, lang) => ({ version: null, loader: s.match(/phpshield\.[\w.]+/i)?.[0] ?? 'phpshield loader', notes: [] }),
  },
  {
    product: 'NuCoder (NuSphere)',
    test: (s) => /nu-?coder/i.test(s) && /extension_loaded|\bdl\s*\(|NuSphere/i.test(s),
    info: (s, lang) => ({ version: null, loader: 'nu-coder (NuSphere)', notes: [] }),
  },
];

/** @returns {null | { product, version, loader, decodable: false, notes, evidence }} */
export function protection(inputText, lang = 'tr') {
  const head = inputText.slice(0, 64 * 1024);
  for (const p of PRODUCTS) {
    if (!p.test(head)) continue;
    const i = p.info(head, lang);
    return {
      product: p.product,
      version: i.version,
      loader: i.loader,
      decodable: false,
      notes: [...i.notes, ...wrapperNotes(head, lang), pick(COMMON, lang)],
    };
  }
  return null;
}
