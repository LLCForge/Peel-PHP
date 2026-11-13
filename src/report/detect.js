// Encoder / obfuscator / webshell ailesi tespiti. Her kural, bilinen ve doğrulanabilir işaretlerden oluşur;
// işaret ağırlıkları gürültülü-VEYA ile birleşir: güven = 1 - Π(1 - w). Tek başına zayıf olan genel
// işaretler (kaçışlı dizgeler, goto) düşük ağırlıklıdır; ürün başlığı, alan adı gibi ayırt edici işaretler yüksek.
// Webshell adları kaynakta bölünmüş yazılır (antivirüs imzalarına takılmasın).
import { walk } from '../core/parse.js';
import { pick, snippet, WHERE, nodeText, astOf } from './text.js';

const t = (tr, en = tr) => ({ tr, en });

// kind: encoder | obfuscator | webshell
// marks: [regex, ağırlık, açıklama]; version(text) isteğe bağlı
export const FAMILIES = [
  {
    id: 'phpkoru', name: 'PHPkoru (Aponkral)', kind: 'encoder',
    marks: [
      [/Aponkral PHPkoru|APONKRAL PHPkoru/, 0.9, t('ürün başlığı', 'product header')],
      [/phpkoru\.com/i, 0.6, t('ürün adresi', 'product URL')],
      [/define\(\s*'__(?:FILE|DIR)__[0-9a-f]{16}'/, 0.6, t('rastgele ekli __FILE__/__DIR__ sabitleri', 'randomised __FILE__/__DIR__ constants')],
      [/\$CUCxbeh_z\b/, 0.6, t('rot13 "PHPkoru_m" değişkeni', 'rot13 "PHPkoru_m" variable')],
      [/\[(?:CUCxbeh_Pbqr|PHPkoru_Code)\\?\]/, 0.6, t('gömülü kod işaretleri', 'embedded code markers')],
      [/\$‎[A-Za-z_]/, 0.3, t('görünmez U+200E içeren değişken adları', 'variable names containing invisible U+200E')],
    ],
    version: (s) => s.match(/PHPkoru[\s\S]{0,300}?Version:\s*v?(\d[\w.]*)/)?.[1],
  },
  {
    id: 'php-encoder-free', name: 'PHP Encoder - Free Code Protection Tool', kind: 'encoder',
    marks: [
      [/PHP Encoder - Free Code Protection Tool/, 0.9, t('ürün başlığı', 'product header')],
      [/Encoded and Protected Content/, 0.4, t('başlık metni', 'header text')],
      [/gzuncompress\(\s*base64_decode\(\s*strrev\(/, 0.1, t('strrev + base64 + gzuncompress yükü', 'strrev + base64 + gzuncompress payload')],
      [/chr\(\(ord\(\$\w+\[\$i\]\)\s*[+-]\s*\(\$i\s*%\s*\d+\)\)\s*\^\s*ord\(/, 0.15, t('konuma bağlı XOR çözücü döngüsü', 'position-dependent XOR decoder loop')],
    ],
    version: (s) => s.match(/Free Code Protection Tool[\s\S]{0,200}?Version:\s*v?(\d[\w.]*)/)?.[1],
  },
  {
    id: 'fopo', name: 'FOPO (Free Online PHP Obfuscator)', kind: 'obfuscator',
    marks: [
      [/Obfuscation provided by FOPO/i, 0.9, t('FOPO başlığı', 'FOPO header')],
      [/fopo\.com\.ar/i, 0.8, t('FOPO adresi', 'FOPO URL')],
      [/\$\w+\s*=\s*"(?:\\x[0-9a-f]{2}\\[0-7]{3}){4,}[^"]*"\s*;/i, 0.35, t('hex/sekizli dönüşümlü kaçışlarla yazılmış fonksiyon adı', 'function name in alternating hex/octal escapes')],
    ],
  },
  {
    id: 'yakpro', name: 'YAK Pro - Php Obfuscator', kind: 'obfuscator',
    marks: [
      [/Obfuscated by YAK Pro - Php Obfuscator/, 0.95, t('YAK Pro başlığı', 'YAK Pro header')],
      [/github\.com\/pk-fr\/yakpro-po/, 0.8, t('proje adresi', 'project URL')],
    ],
    version: (s) => s.match(/YAK Pro - Php Obfuscator\s+(\d[\w.]*)/)?.[1],
  },
  {
    id: 'phpjiami', name: 'PHPJiaMi', kind: 'encoder',
    marks: [[/phpjiami\.com/i, 0.85, t('PHPJiaMi adresi', 'PHPJiaMi URL')]],
  },
  {
    id: 'phpjm', name: 'PHPJM (O/0 adlı şifreleyici)', kind: 'encoder',
    marks: [
      [/phpjm\.net/i, 0.8, t('PHPJM adresi', 'PHPJM URL')],
      [/\$OOO0O0O00\s*=\s*__FILE__/, 0.7, t('$OOO0O0O00 = __FILE__ başlangıcı', '$OOO0O0O00 = __FILE__ prologue')],
    ],
  },
  {
    id: 'lockit', name: 'PHP LockIt!', kind: 'encoder',
    marks: [
      [/PHP\s*LockIt/i, 0.8, t('ürün adı', 'product name')],
      [/\$_F\s*=\s*__FILE__\s*;\s*\$_X\s*=/, 0.7, t('$_F=__FILE__; $_X= başlangıcı', '$_F=__FILE__; $_X= prologue')],
    ],
  },
  {
    id: 'byterun', name: 'Byterun Protector', kind: 'encoder',
    marks: [[/byterun\.com/i, 0.8, t('Byterun adresi', 'Byterun URL')], [/\bbyterun\b/i, 0.4, t('Byterun adı', 'Byterun name')]],
  },
  // webshell aileleri
  {
    id: 'wso', name: 'WSO (Web Shell by oRb)', kind: 'webshell',
    marks: [
      [new RegExp(`\\b${'w' + 'so'}(?:Header|Footer|Ex|Perms|PermsColor|ViewSize|Login|Secparam|WhichR|Scandir|RecursiveGlob)\\s*\\(`), 0.8, t('WSO yardımcı fonksiyonları', 'WSO helper functions')],
      [new RegExp(`\\b${'W' + 'SO'}_VERSION\\b`), 0.8, t('WSO_VERSION sabiti', 'WSO_VERSION constant')],
    ],
    version: (s) => s.match(/WSO_VERSION['"]\s*,\s*['"]([\d.]+)/)?.[1],
  },
  {
    id: 'filesman', name: 'FilesMan', kind: 'webshell',
    marks: [
      [/\$default_action\s*=\s*['"]FilesMan['"]/, 0.8, t('varsayılan eylem FilesMan', 'default action FilesMan')],
      [/\baction(?:FilesMan|FilesTools|StringTools|SecInfo|Console|Network|SelfRemove)\s*\(/, 0.7, t('action* eylem fonksiyonları', 'action* handler functions')],
      [/['"]FilesMan['"]/, 0.4, t('FilesMan eylem adı', 'FilesMan action name')],
    ],
  },
  {
    id: 'c99', name: 'c99 shell', kind: 'webshell',
    marks: [[new RegExp(`c99${'sh'}(?:ell|_)`, 'i'), 0.85, t('c99 adı', 'c99 name')], [/\$shver\s*=/, 0.3, t('$shver sürüm değişkeni', '$shver version variable')]],
  },
  {
    id: 'r57', name: 'r57 shell', kind: 'webshell',
    marks: [[new RegExp(`r57${'sh'}(?:ell)?\\b`, 'i'), 0.85, t('r57 adı', 'r57 name')]],
  },
  {
    id: 'b374k', name: 'b374k shell', kind: 'webshell',
    marks: [[new RegExp(`b37${'4k'}`, 'i'), 0.85, t('b374k adı', 'b374k name')]],
  },
  {
    id: 'indoxploit', name: 'IndoXploit shell', kind: 'webshell',
    marks: [[new RegExp(`Indo${'X'}ploit`, 'i'), 0.85, t('IndoXploit adı', 'IndoXploit name')]],
  },
  {
    id: 'alfa', name: 'ALFA TEaM shell', kind: 'webshell',
    marks: [
      [new RegExp(`AL${'FA'}[\\s_~-]{0,3}TEaM`, 'i'), 0.85, t('ALFA TEaM adı', 'ALFA TEaM name')],
      [new RegExp(`al${'fa'}cgiapi|AL${'FA'}_DATA`, 'i'), 0.75, t('ALFA cgi/veri tanımları', 'ALFA cgi/data identifiers')],
    ],
  },
  {
    id: 'weevely', name: 'Weevely (ajan)', kind: 'webshell',
    marks: [
      [/\$kh\s*=\s*["'][0-9a-f]{12}["']/, 0.45, t('$kh başlangıç işareti', '$kh start marker')],
      [/\$kf\s*=\s*["'][0-9a-f]{12}["']/, 0.45, t('$kf bitiş işareti', '$kf end marker')],
      [/php:\/\/input/, 0.15, t('ham istek gövdesi okuma', 'raw request body read')],
      [/gzuncompress\s*\(\s*@?x\s*\(/, 0.4, t('XOR çözücü x() + gzuncompress', 'XOR decoder x() + gzuncompress')],
    ],
  },
  {
    id: 'pas', name: 'P.A.S. shell', kind: 'webshell',
    marks: [[/P\.A\.S\.\s*(?:v\.?\s*)?\d/, 0.5, t('P.A.S. sürüm dizgesi', 'P.A.S. version string')]],
  },
];

const SUPER = new Set(['_GET', '_POST', '_COOKIE', '_REQUEST', '_FILES', '_SERVER']);
const DECODERS = new Set(['base64_decode', 'gzinflate', 'gzuncompress', 'gzdecode', 'str_rot13', 'strrev', 'convert_uudecode', 'hex2bin', 'urldecode', 'rawurldecode', 'pack', 'bzdecompress', 'gzinflate']);

const callName = (n) => (n.kind === 'call' && n.what?.kind === 'name' ? String(n.what.name).replace(/^\\/, '').toLowerCase() : null);

/** Genel gizleme teknikleri (AST): eval zinciri, değişken fonksiyon, $GLOBALS tablosu, goto, görünmez ad, kaçışlı dizgeler */
function techniques(sources, lang) {
  const found = new Map();
  const add = (id, name, conf, ev) => {
    const cur = found.get(id) ?? { name, kind: 'technique', id, confidence: 0, evidence: [] };
    cur.confidence = Math.max(cur.confidence, conf);
    if (cur.evidence.length < 4 && !cur.evidence.includes(ev)) cur.evidence.push(ev);
    found.set(id, cur);
  };
  for (const src of sources) {
    if (src.where === 'output') continue; // çözülmüş çıktıdaki kalıntılar ayrıca raporlanmaz
    const ast = astOf(src);
    if (!ast) continue;
    const where = pick(WHERE[src.where], lang);
    let gotos = 0;
    let varCalls = 0;
    let globalsIdx = 0;
    const chains = new Set();
    walk(ast, (n) => {
      if (n.kind === 'goto') gotos++;
      if (n.kind === 'call' && n.what && n.what.kind !== 'name') varCalls++;
      if (n.kind === 'offsetlookup' && n.what?.kind === 'offsetlookup' && n.what.what?.kind === 'variable' && n.what.what.name === 'GLOBALS') globalsIdx++;
      if (n.kind === 'eval' || (callName(n) === 'assert')) {
        const used = [];
        walk(n, (m) => {
          const c = callName(m);
          if (c && DECODERS.has(c) && !used.includes(c)) used.push(c);
        });
        if (used.length) chains.add(used.join(' → '));
      }
      if (callName(n) === 'preg_replace' && n.arguments?.[0]?.kind === 'string' && /^(.)[\s\S]*\1[a-z]*e[a-z]*$/i.test(n.arguments[0].value)) {
        add('preg-e', pick(t('preg_replace /e kod çalıştırma', 'preg_replace /e code execution'), lang), 0.8, `${where}: ${snippet(n.arguments[0].value, 60)}`);
      }
      if (callName(n) === 'create_function') add('create-function', pick(t('create_function ile kod üretimi', 'create_function code generation'), lang), 0.6, where);
      return true;
    });
    for (const c of chains) add('eval-chain', pick(t('eval/çözücü zinciri', 'eval/decoder chain'), lang), Math.min(0.95, 0.5 + 0.15 * c.split('→').length), `${where}: eval(${c})`);
    if (varCalls >= 3) add('variable-functions', pick(t('değişken üzerinden fonksiyon çağrısı', 'variable function calls'), lang), Math.min(0.9, 0.3 + varCalls * 0.05), `${where}: ${varCalls}×`);
    if (globalsIdx >= 5) add('globals-table', pick(t('$GLOBALS dizge tablosu', '$GLOBALS string table'), lang), Math.min(0.9, 0.4 + globalsIdx * 0.02), `${where}: $GLOBALS[..][..] ×${globalsIdx}`);
    if (gotos >= 5) add('goto', pick(t('goto ile akış karmaşıklaştırma', 'goto control-flow scrambling'), lang), Math.min(0.9, 0.3 + gotos * 0.02), `${where}: goto ×${gotos}`);
    const esc = (src.text.match(/\\x[0-9a-f]{2}|\\[0-7]{3}/gi) ?? []).length;
    if (esc >= 40 && esc * 4 > src.text.length * 0.2) add('escaped-strings', pick(t('hex/sekizli kaçışlı dizgeler', 'hex/octal escaped strings'), lang), 0.6, `${where}: ${esc}×`);
    if (/\$[^\s=;(]*[​-‏⁠﻿]/.test(src.text)) add('invisible-names', pick(t('görünmez Unicode içeren tanımlayıcılar', 'identifiers with invisible Unicode'), lang), 0.7, where);
    if (/\$[O0]{6,}\b/.test(src.text)) add('o0-names', pick(t('O/0 karışık tanımlayıcılar', 'O/0 look-alike identifiers'), lang), 0.6, where);
    if (/extension_loaded\(\s*['"]eval_?hook['"]/i.test(src.text)) add('anti-debug', pick(t('evalhook (hata ayıklayıcı) denetimi', 'evalhook (debugger) check'), lang), 0.8, where);
    if (/file_get_contents\(\s*__FILE__\s*\)/.test(src.text)) add('self-read', pick(t('kendi dosyasını okuma (bütünlük/gömülü veri)', 'reads its own file (integrity/embedded data)'), lang), 0.6, where);
  }
  return [...found.values()];
}

/** Webshell'in tek satırlık China Chopper biçimi: süper globali doğrudan eval/assert'e veren küçük kod */
function chopper(sources, lang) {
  for (const src of sources) {
    if (src.where === 'input' && sources.length > 1) continue;
    const ast = astOf(src);
    if (!ast) continue;
    let hit = null;
    walk(ast, (n) => {
      if (hit) return false;
      const arg = n.kind === 'eval' ? n.source : (callName(n) === 'assert' ? n.arguments?.[0] : null);
      if (!arg) return true;
      const base = arg.kind === 'offsetlookup' ? arg.what : arg;
      if (base?.kind === 'variable' && SUPER.has(base.name)) hit = n;
      return true;
    });
    if (hit) {
      const small = src.code.replace(/\s+/g, '').length < 200;
      return [{
        id: 'china-chopper', name: 'China Chopper', kind: 'webshell', version: null,
        confidence: small ? 0.75 : 0.4,
        evidence: [`${pick(WHERE[src.where], lang)}: ${snippet(nodeText(src, hit), 80)}`,
          pick(small ? t('tek satırlık gövde', 'one-liner body') : t('büyük dosyada aynı kalıp', 'same pattern inside a larger file'), lang)],
      }];
    }
  }
  return [];
}

export function detect(sources, lang = 'tr') {
  const out = [];
  for (const f of FAMILIES) {
    let miss = 1;
    const evidence = [];
    let version = null;
    for (const [re, w, desc] of f.marks) {
      for (const src of sources) {
        const m = src.text.match(re);
        if (!m) continue;
        miss *= 1 - w;
        evidence.push(`${pick(desc, lang)} (${pick(WHERE[src.where], lang)}): ${snippet(m[0], 80)}`);
        break;
      }
    }
    const confidence = Math.round((1 - miss) * 100) / 100;
    if (confidence < 0.3) continue;
    for (const src of sources) version ??= f.version?.(src.text) ?? null;
    out.push({ id: f.id, name: f.name, kind: f.kind, version, confidence, evidence });
  }
  out.push(...chopper(sources, lang), ...techniques(sources, lang));
  for (const d of out) d.confidence = Math.round(d.confidence * 100) / 100;
  const rank = { encoder: 0, obfuscator: 0, webshell: 1, technique: 2 };
  return out.sort((a, b) => rank[a.kind] - rank[b.kind] || b.confidence - a.confidence);
}
