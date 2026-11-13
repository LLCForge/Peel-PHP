// Analiz raporu. Arayüz, CLI ve kütüphane bu biçimi kullanır; alanlar eklenebilir, var olanlar değişmez.
//
// Report = {
//   detection:  [{ name, confidence (0-1), evidence: string[] }]        hangi encoder/obfuscator/webshell ailesi
//   protection: null | { product, version, loader, decodable: false, notes: string[] }   ticari şifreleme (ionCube vb.)
//   threat:     { score (0-100), level: 'none'|'low'|'medium'|'high'|'critical', classes: [{ id, title, evidence: string[] }] }
//   behaviour:  { network: [{ api, target }], commands: [{ api, command }], files: [{ api, path }], mail: [{ to, subject }],
//                 headers: string[], other: [{ api, args }] }            sandbox'ta denenen yan etkiler (yapılmadı)
//   iocs:       { urls, domains, ips, emails, wallets: string[] }
//   metrics:    { inBytes, outBytes, layers, rounds, rollbacks, version }
//   summary:    string                                                   tek paragraf özet
// }
import { toText } from './bstr.js';

const NET = new Set(['fsockopen', 'pfsockopen', 'stream_socket_client', 'curl_init', 'curl_setopt', 'curl_exec', 'file_get_contents', 'socket_connect', 'gethostbyname', 'dns_get_record', 'getmxrr']);
const CMD = new Set(['exec', 'shell_exec', 'system', 'passthru', 'popen', 'proc_open', 'pcntl_exec']);
const FILES = new Set(['file_put_contents', 'unlink', 'rename', 'chmod', 'mkdir', 'rmdir', 'copy', 'move_uploaded_file']);

/**
 * @param {{ input: string, output: string, trace?: { first?: object, final?: object }, events?: object[], stats?: object, version?: string }} o
 *   input/output bstr; trace: pipeline'ın döndürdüğü çözülmüş sandbox izleri
 */
export function analyze({ input, output, trace = {}, events = [], stats = {}, version = null }) {
  const fx = trace.first?.fx ?? [];
  const behaviour = { network: [], commands: [], files: [], mail: [], headers: [], other: [] };
  for (const [api, args] of fx) {
    const a = args.map((x) => (typeof x === 'string' ? toText(x) : x));
    if (NET.has(api)) behaviour.network.push({ api, target: String(a[0] ?? '') });
    else if (CMD.has(api)) behaviour.commands.push({ api, command: String(a[0] ?? '') });
    else if (FILES.has(api)) behaviour.files.push({ api, path: String(a[0] ?? '') });
    else if (api === 'mail') behaviour.mail.push({ to: String(a[0] ?? ''), subject: String(a[1] ?? '') });
    else if (api === 'header') behaviour.headers.push(String(a[0] ?? ''));
    else behaviour.other.push({ api, args: a });
  }
  return {
    detection: [],
    protection: null,
    threat: { score: 0, level: 'none', classes: [] },
    behaviour,
    iocs: { urls: [], domains: [], ips: [], emails: [], wallets: [] },
    metrics: {
      inBytes: input.length,
      outBytes: output.length,
      layers: stats.layers ?? 0,
      rounds: Math.max(0, ...events.map((e) => e.round ?? 0)),
      rollbacks: events.filter((e) => e.state === 'fail').length,
      version,
    },
    summary: '',
  };
}
