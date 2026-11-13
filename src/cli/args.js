// Küçük, bağımlılıksız argüman ayrıştırıcı. spec: { ad: { alias, type: 'bool'|'string'|'number'|'list' } }
// --no-<ad> bool bayrağı false yapar. Bilinmeyen bayrak kullanım hatasıdır (çıkış kodu 2).

export class UsageError extends Error {}

export function parseArgs(argv, spec) {
  const opts = {};
  const positional = [];
  const byAlias = new Map();
  for (const [name, s] of Object.entries(spec)) {
    if (s.alias) byAlias.set(s.alias, name);
    if (s.type === 'list') opts[name] = [];
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { positional.push(...argv.slice(i + 1)); break; }
    if (a === '-' || !a.startsWith('-')) { positional.push(a); continue; }
    let key;
    let inline = null;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      key = eq > 0 ? a.slice(2, eq) : a.slice(2);
      if (eq > 0) inline = a.slice(eq + 1);
      if (key.startsWith('no-') && spec[key.slice(3)]?.type === 'bool') { opts[key.slice(3)] = false; continue; }
    } else {
      key = byAlias.get(a.slice(1));
      if (!key) throw new UsageError(`Bilinmeyen seçenek: ${a}`);
    }
    const s = spec[key];
    if (!s) throw new UsageError(`Bilinmeyen seçenek: ${a}`);
    if (s.type === 'bool') { opts[key] = true; continue; }
    // isteğe bağlı değerli bayrak: sonraki argüman bayraksa değer verilmemiştir
    let v = inline;
    if (v === null) {
      const next = argv[i + 1];
      if (next === undefined || (next.startsWith('-') && next !== '-')) {
        if (s.optional !== undefined) { opts[key] = s.optional; continue; }
        throw new UsageError(`${a} bir değer bekliyor`);
      }
      v = next;
      i++;
    }
    if (s.type === 'number') {
      const n = Number(v);
      if (!Number.isFinite(n)) throw new UsageError(`${a} sayı bekliyor`);
      opts[key] = n;
    } else if (s.type === 'list') opts[key].push(v);
    else opts[key] = v;
  }
  return { opts, positional };
}
