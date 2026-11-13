// Oturum kaydı: IndexedDB (cihazda kalır) ve JSON dışa/içe aktarma.
// İçe aktarılan JSON güvenilmezdir: her alan türü ve boyutu doğrulanır, bilinmeyen alanlar atılır.

const DB = 'peel-php';
const STORE = 'session';
const MAX_TEXT = 25 * 1024 * 1024;

// Veritabanının tüm depoları aynı sürüm yükseltmesinde oluşturulur: yeni depo eklenirse buraya yazılır ve
// sürüm artırılır (Peel-JS'te yalnızca ilk açan modülün deposu oluşuyordu)
const STORES = ['session'];
const DB_VERSION = 1;

export function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, DB_VERSION);
    req.onupgradeneeded = () => {
      for (const name of STORES) if (!req.result.objectStoreNames.contains(name)) req.result.createObjectStore(name);
    };
    req.onsuccess = () => {
      // başka sekme daha yeni sürüme yükseltirken açık bağlantı onu kilitlemesin
      req.result.onversionchange = () => req.result.close();
      resolve(req.result);
    };
    req.onerror = () => reject(req.error ?? new Error('IndexedDB açılamadı'));
  });
}

async function tx(mode, fn) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const req = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(req?.result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error ?? new Error('İşlem iptal edildi'));
    });
  } finally {
    db.close();
  }
}

// JSON gidiş-dönüşü: fonksiyon ya da sınıf örneği içeren nesneler yapılandırılmış klonlanamaz (DataCloneError)
export const saveSession = (data) => tx('readwrite', (s) => s.put(JSON.parse(JSON.stringify(data)), 'current'));
export const loadSession = () => tx('readonly', (s) => s.get('current'));
export const clearSession = () => tx('readwrite', (s) => s.delete('current'));

const str = (v, max = 300) => (typeof v === 'string' ? v.slice(0, max) : '');
const text = (v) => (typeof v === 'string' && v.length <= MAX_TEXT ? v : '');
// bayt dizgesi: her karakter 0-255 aralığında olmalı
const bstr = (v) => (typeof v === 'string' && v.length <= MAX_TEXT && !/[^\x00-\xff]/.test(v) ? v : null);
const int = (v, lo, hi) => (Number.isInteger(v) && v >= lo && v <= hi ? v : null);

function marks(m) {
  const o = m && typeof m === 'object' ? m : {};
  return {
    bookmarks: (Array.isArray(o.bookmarks) ? o.bookmarks : []).map((n) => int(n, 1, 1e8)).filter((n) => n !== null).slice(0, 5000),
    notes: (Array.isArray(o.notes) ? o.notes : []).filter((x) => x && int(x.line, 1, 1e8) !== null && typeof x.text === 'string')
      .slice(0, 5000).map((x) => ({ line: x.line, text: x.text.slice(0, 4000) })),
  };
}

/** Güvenilmez oturum nesnesini doğrular; geçersizse hata fırlatır */
export function sanitizeSession(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.docs)) throw new Error('session: docs yok');
  const groups = (Array.isArray(raw.groups) ? raw.groups : []).slice(0, 200).map((g) => ({
    id: str(g?.id, 40), name: str(g?.name, 120), color: /^#[0-9a-f]{6}$/i.test(g?.color) ? g.color : '#777bb4', collapsed: g?.collapsed === true,
  })).filter((g) => g.id);
  const gids = new Set(groups.map((g) => g.id));
  const docs = raw.docs.slice(0, 500).map((d) => ({
    id: str(d?.id, 40),
    name: str(d?.name, 200) || 'untitled.php',
    path: str(d?.path, 500),
    group: gids.has(d?.group) ? d.group : null,
    input: text(d?.input),
    output: text(d?.output),
    // dosyadan gelen baytlar (bstr): CRLF ve geçersiz UTF-8 editörde korunamadığı için ayrıca saklanır
    raw: bstr(d?.raw),
    outRaw: bstr(d?.outRaw),
    marks: { in: marks(d?.marks?.in), out: marks(d?.marks?.out) },
    // rapor ve olaylar yalnızca veri olarak saklanır; arayüzde her zaman textContent ile basılır
    report: d?.report && typeof d.report === 'object' ? d.report : null,
    events: Array.isArray(d?.events) ? d.events.slice(0, 5000).filter((e) => e && typeof e.id === 'string') : [],
    runs: Array.isArray(d?.runs) ? d.runs.slice(-20).filter((r) => r && typeof r === 'object') : [],
  })).filter((d) => d.id);
  if (!docs.length) throw new Error('session: boş');
  return {
    docs,
    groups,
    active: docs.some((d) => d.id === raw.active) ? raw.active : docs[0].id,
  };
}
