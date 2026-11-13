// PHP ayrıştırma (php-parser). Girdi bstr'dir: konumlar bayt konumudur ve PHP'nin bayt tabanlı tanımlayıcı
// kuralları (\x80-\xff ad karakteri) korunur. Önce yeni sürüm sözdizimi denenir, olmazsa eski sürümler.
import { Engine } from 'php-parser';

const VERSIONS = ['8.3', '7.4', '5.6'];
const engines = new Map();

function engine(version) {
  if (!engines.has(version)) {
    engines.set(version, new Engine({
      parser: { version, extractDoc: true, suppressErrors: false },
      ast: { withPositions: true, withSource: false },
      lexer: { short_tags: true, all_tokens: true },
    }));
  }
  return engines.get(version);
}

// Deyim düğümleri: konumlarına sondaki ; dahildir. Diğer (ifade) düğümlerinde php-parser deyim olarak kullanılan
// ifadenin konumuna da ;'yi katar (call_user_func(...);) — ifadeyi değiştiren dönüşüm ;'yi yutmasın diye kırpılır.
const STATEMENTS = new Set(['program', 'expressionstatement', 'echo', 'return', 'unset', 'global', 'static', 'if', 'while',
  'do', 'for', 'foreach', 'switch', 'case', 'break', 'continue', 'block', 'function', 'class', 'interface', 'trait',
  'enum', 'try', 'catch', 'throw', 'inline', 'halt', 'declare', 'namespace', 'usegroup', 'constantstatement',
  'propertystatement', 'classconstant', 'method', 'label', 'goto', 'traituse', 'noop']);

function trimExpressions(ast, code) {
  walk(ast, (n) => {
    if (STATEMENTS.has(n.kind) || !n.loc) return true;
    let e = n.loc.end.offset;
    const s = n.loc.start.offset;
    while (e > s && (code[e - 1] === ';' || code[e - 1] === ' ' || code[e - 1] === '\t' || code[e - 1] === '\n' || code[e - 1] === '\r')) e--;
    n.loc.end.offset = e;
    return true;
  });
  return ast;
}

/** @returns {{ ast: object, version: string }} parse edilemezse hata fırlatır (ilk sürümün hatası) */
export function parse(code, versions = VERSIONS) {
  let first = null;
  for (const v of versions) {
    try {
      return { ast: trimExpressions(engine(v).parseCode(code, 'input.php'), code), version: v };
    } catch (e) {
      first ??= e;
    }
  }
  throw first;
}

export function tryParse(code, versions) {
  try {
    return parse(code, versions);
  } catch {
    return null;
  }
}

/** Eval kodu PHP modunda başlar: başına açılış etiketi eklenerek ayrıştırılır, konumlar etiket kadar kayar */
export const EVAL_PREFIX = '<?php ';

export function tokens(code, version = '8.3') {
  return engine(version).tokenGetAll(code);
}

/** Kod parçasının sonunda PHP modunda mı kalınıyor? (eval kodu ?> ile HTML'e geçip dönmeyebilir) */
export function endsInPhpMode(evalCode) {
  let toks;
  try {
    toks = tokens(EVAL_PREFIX + evalCode);
  } catch {
    return true;
  }
  for (let i = toks.length - 1; i >= 0; i--) {
    const t = toks[i];
    const name = Array.isArray(t) ? t[0] : null;
    if (name === 'T_WHITESPACE' || name === 'T_COMMENT' || name === 'T_DOC_COMMENT') continue;
    return name !== 'T_INLINE_HTML' && name !== 'T_CLOSE_TAG';
  }
  return true;
}

/** Düğümleri ebeveyniyle gezer. visit(node, parent, key) false dönerse alt düğümlere inilmez. */
export function walk(root, visit) {
  const stack = [[root, null, null]];
  while (stack.length) {
    const [node, parent, key] = stack.pop();
    if (!node || typeof node !== 'object') continue;
    if (node.kind && visit(node, parent, key) === false) continue;
    const keys = Object.keys(node);
    for (let k = keys.length - 1; k >= 0; k--) {
      const name = keys[k];
      if (name === 'loc' || name === 'leadingComments' || name === 'trailingComments') continue;
      const v = node[name];
      if (Array.isArray(v)) {
        for (let i = v.length - 1; i >= 0; i--) if (v[i] && typeof v[i] === 'object') stack.push([v[i], node, name]);
      } else if (v && typeof v === 'object' && v.kind) {
        stack.push([v, node, name]);
      }
    }
  }
}

export const span = (node) => [node.loc.start.offset, node.loc.end.offset];

/** Konum aralığı düzenlemelerini sondan başa uygular: [{ start, end, text }] (çakışanlar atlanır) */
export function applyEdits(code, edits) {
  const sorted = [...edits].sort((a, b) => b.start - a.start || b.end - a.end);
  let out = code;
  let floor = Infinity;
  let applied = 0;
  for (const e of sorted) {
    if (e.end > floor) continue;
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
    floor = e.start;
    applied++;
  }
  return { code: out, applied };
}

/** Bloğun süslü parantezler arasındaki kaynağı (HTML parçaları ve etiketler dahil); blok değilse deyimin kendisi */
export function innerText(code, node) {
  if (!node) return '';
  const [s, e] = span(node);
  if (node.kind === 'block' && code[s] === '{' && code[e - 1] === '}') return code.slice(s + 1, e - 1);
  return code.slice(s, e);
}
