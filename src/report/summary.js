// Raporun tek paragraflık özeti (tr | en).

const LEVEL = {
  tr: { none: 'yok', low: 'düşük', medium: 'orta', high: 'yüksek', critical: 'kritik' },
  en: { none: 'none', low: 'low', medium: 'medium', high: 'high', critical: 'critical' },
};

const list = (xs, lang) => {
  if (xs.length <= 1) return xs.join('');
  return `${xs.slice(0, -1).join(', ')} ${lang === 'en' ? 'and' : 've'} ${xs.at(-1)}`;
};

export function summarize(r, lang = 'tr') {
  const en = lang === 'en';
  const parts = [];
  const pct = (c) => `%${Math.round(c * 100)}`;
  const pctEn = (c) => `${Math.round(c * 100)}%`;
  const fam = r.detection.filter((d) => d.kind !== 'technique' && d.kind !== 'webshell');
  const shells = r.detection.filter((d) => d.kind === 'webshell');
  const tech = r.detection.filter((d) => d.kind === 'technique');
  const name = (d) => `${d.name}${d.version ? ` ${d.version}` : ''} (${en ? pctEn(d.confidence) : pct(d.confidence)})`;

  if (r.protection) {
    const p = r.protection;
    parts.push(en
      ? `The file is protected with the commercial encoder ${p.product}${p.version ? ` ${p.version}` : ''}; it requires ${p.loader} and its encrypted part is intentionally not decoded (bypassing licence protection is out of scope).`
      : `Dosya ticari ${p.product}${p.version ? ` ${p.version}` : ''} şifrelemesiyle korunuyor; çalışması için ${p.loader} gerekir ve şifreli bölüm bilinçli olarak çözülmez (lisans korumasını aşmak kapsam dışı).`);
  }
  if (fam.length) parts.push(en ? `Identified as ${list(fam.map(name), lang)}.` : `Tespit edilen: ${list(fam.map(name), lang)}.`);
  if (tech.length) parts.push(en ? `Techniques: ${list(tech.map((d) => d.name), lang)}.` : `Kullanılan teknikler: ${list(tech.map((d) => d.name), lang)}.`);
  const m = r.metrics;
  if (m.layers || m.evals) {
    parts.push(en
      ? `${m.evals} eval layer(s) were captured in the sandbox (PHP ${m.version ?? '?'}) and the code was reduced from ${m.inBytes} to ${m.outBytes} bytes.`
      : `Sandbox'ta (PHP ${m.version ?? '?'}) ${m.evals} eval katmanı yakalandı ve kod ${m.inBytes} bayttan ${m.outBytes} bayta indi.`);
  }
  if (shells.length) parts.push(en ? `Webshell family: ${list(shells.map(name), lang)}.` : `Webshell ailesi: ${list(shells.map(name), lang)}.`);
  const th = r.threat;
  const lv = LEVEL[en ? 'en' : 'tr'][th.level];
  if (th.classes.length) {
    const cls = th.classes.slice(0, 5).map((c) => c.title.toLowerCase());
    parts.push(en ? `Threat level ${lv} (${th.score}/100): ${list(cls, lang)}.` : `Tehdit düzeyi ${lv} (${th.score}/100): ${list(cls, lang)}.`);
  } else if (!r.protection) {
    parts.push(en ? 'No dangerous behaviour was found in the decoded code (threat level none).' : 'Çözülmüş kodda tehlikeli bir davranış bulunmadı (tehdit düzeyi yok).');
  } else {
    parts.push(en ? 'Since the code is encrypted, its behaviour could not be assessed.' : 'Kod şifreli olduğundan davranışı değerlendirilemedi.');
  }
  const b = r.behaviour;
  const tried = b.network.length + b.commands.length + b.files.length + b.mail.length;
  if (tried) {
    parts.push(en
      ? `In the sandbox it attempted ${b.network.length} network, ${b.commands.length} command, ${b.files.length} file and ${b.mail.length} mail operation(s); none were performed.`
      : `Sandbox'ta ${b.network.length} ağ, ${b.commands.length} komut, ${b.files.length} dosya ve ${b.mail.length} posta işlemi denedi; hiçbiri gerçekleştirilmedi.`);
  }
  const io = r.iocs;
  const counts = [
    [io.urls.length, 'URL', 'URL'], [io.domains.length, 'alan adı', 'domain(s)'], [io.ips.length, 'IP', 'IP(s)'],
    [io.emails.length, 'e-posta', 'e-mail(s)'], [io.wallets.length, 'cüzdan', 'wallet(s)'],
    [io.telegram.length, 'Telegram', 'Telegram'], [io.discord.length, 'Discord webhook', 'Discord webhook(s)'],
  ].filter(([n]) => n).map(([n, tr, e]) => `${n} ${en ? e : tr}`);
  if (counts.length) parts.push(en ? `IOCs: ${list(counts, lang)}.` : `IOC: ${list(counts, lang)}.`);
  return parts.join(' ');
}
