// PHP sandbox motoru: worker içinde çalışır (Node: worker_threads, tarayıcı: Web Worker).
// Ağ ve komut çalıştırma kapalı; dosya sistemi bellekte (MEMFS); her istek temiz bir PHP isteğidir.
import { setPhpIniEntries } from '@php-wasm/universal';
import { PRELUDE, STUBS_PHP8, STUBBED, RUNNER, TRACE_PATH, RUNNER_PATH, ORIGINAL_PATH } from './prelude.js';
import { toBytes } from '../core/bstr.js';

// Eski sürümlerde kapatılan fonksiyon yeniden tanımlanamaz: yalnızca dış etkisi olanlar kapanır,
// dosya okuma açık kalır (__FILE__ okuyan encoder'lar için), URL'ler allow_url_fopen=0 ile kapalı
const LEGACY_DISABLED = ['exec', 'shell_exec', 'system', 'passthru', 'popen', 'proc_open', 'pcntl_exec',
  'fsockopen', 'pfsockopen', 'stream_socket_client', 'stream_socket_server', 'curl_init', 'curl_exec',
  'curl_multi_exec', 'mail', 'dl', 'putenv', 'socket_create', 'socket_connect', 'set_time_limit'];

export const MAX_OUTPUT = 1_000_000;

const major = (v) => Number(String(v).split('.')[0]);

/**
 * @param {(version: string) => Promise<import('@php-wasm/universal').PHP>} createPhp
 */
export function createEngine(createPhp) {
  const instances = new Map();

  async function instance(version) {
    if (!instances.has(version)) {
      instances.set(version, (async () => {
        const php = await createPhp(version);
        const modern = major(version) >= 8;
        php.mkdir('/peel');
        php.mkdir('/app');
        php.writeFile('/peel/prelude.php', PRELUDE + (modern ? STUBS_PHP8 : ''));
        php.writeFile(RUNNER_PATH, RUNNER);
        await setPhpIniEntries(php, {
          disable_functions: (modern ? STUBBED : LEGACY_DISABLED).join(','),
          allow_url_fopen: '0',
          allow_url_include: '0',
          memory_limit: '256M',
          display_errors: '0',
          log_errors: '0',
          error_reporting: String(32767),
          'session.save_path': '/tmp',
          'date.timezone': 'UTC',
        });
        return php;
      })());
    }
    return instances.get(version);
  }

  /**
   * Kodu araçlanmış hâlde çalıştırır.
   * @returns {Promise<{ok: boolean, stdout: string, stderr: string, exitCode: number, trace: object|null, version: string, ms: number}>}
   */
  async function run({ code, version = '8.3' }) {
    const t0 = Date.now();
    const php = await instance(version);
    php.writeFile(ORIGINAL_PATH, code);
    if (php.fileExists(TRACE_PATH)) php.unlink(TRACE_PATH);
    let res;
    try {
      res = await php.run({ scriptPath: RUNNER_PATH });
    } catch (e) {
      res = e?.response ?? null;
      if (!res) return { ok: false, stdout: '', stderr: String(e?.message ?? e), exitCode: -1, trace: null, version, ms: Date.now() - t0 };
    }
    let trace = null;
    if (php.fileExists(TRACE_PATH)) {
      try { trace = JSON.parse(php.readFileAsText(TRACE_PATH)); } catch { trace = null; }
    }
    const stdout = res.text.length > MAX_OUTPUT ? res.text.slice(0, MAX_OUTPUT) : res.text;
    return { ok: true, stdout, stderr: res.errors ?? '', exitCode: res.exitCode ?? 0, trace, version, ms: Date.now() - t0 };
  }

  /** Saf ifadeleri toplu değerlendirir: her ifadenin sonucu serialize edilmiş olarak döner (hata: null) */
  async function evaluate({ exprs, version = '8.3', defs = '' }) {
    const php = await instance(version);
    // ifadeler bstr'dir: dosya bayt olarak yazılır; uyarılar (ör. bozuk base64) sonucu bozmasın diye susturulur
    const body = exprs.map((e, i) => `try { $__r[${i}] = array(true, serialize(@(${e}))); } catch (Throwable $__e) { $__r[${i}] = array(false, $__e->getMessage()); }`).join('\n');
    // defs: ifadelerin çağırdığı saf kullanıcı fonksiyonlarının tanımları
    php.writeFile('/peel/eval.php', toBytes(`<?php\nmt_srand(1);\n${defs}\n$__r = array();\n${body}\necho json_encode(array_map(function ($x) { return array($x[0], base64_encode($x[1])); }, $__r));`));
    let res;
    try {
      res = await php.run({ scriptPath: '/peel/eval.php' });
    } catch (e) {
      res = e?.response ?? null;
    }
    try {
      return JSON.parse(res?.text ?? 'null');
    } catch {
      return null;
    }
  }

  /** Worker mesajı: { type: 'load' | 'run' | 'evaluate', ... } */
  async function handle(msg) {
    switch (msg.type) {
      case 'load': await instance(msg.version); return { ok: true };
      case 'run': return run(msg);
      case 'evaluate': return { ok: true, results: await evaluate(msg) };
      default: return { ok: false, error: `bilinmeyen mesaj: ${msg.type}` };
    }
  }

  return { run, evaluate, handle };
}
