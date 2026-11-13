// Benchmark örneklerini gerçek açık kaynak PHP obfuscator'larıyla üretir: node scripts/make-bench.js <araç-dizini> [filtre]
// Araçlar depoya konmaz; <araç-dizini> altında şu klasörler beklenir (GitHub tarball'ları, açılmış):
//   pk-fr_yakpro-po (+ PHP-Parser/ = nikic/PHP-Parser 5.x), naneau_php-obfuscator (+ PHP-Parser/ = 1.x),
//   avid0_Alom, Southern_php-obfuscator, krypt0nn_php-obfuscator, lwertugrul_Php-obfuscator, weizenspreu_ob.php,
//   Cvar1984_yapo, GLOBUS-studio_PhpObfuscator, ricardopedias_php-obfuscator
// Her araç php-wasm içinde (bellek dosya sistemi, ağ yok) çalıştırılır; çıktı diske yalnızca fixture kodlamasıyla
// (XOR + base64, test/bench/*.php.x) yazılır: gizlenmiş örnekler antivirüsü tetiklemesin. Manifest: test/bench/manifest.json
import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { PHP, setPhpIniEntries } from '@php-wasm/universal';
import { loadNodeRuntime } from '@php-wasm/node';
import { encodeFixture } from '../test/fixture-codec.js';
import { SOURCES } from '../test/bench/sources.js';

const toolsDir = process.argv[2];
const filter = process.argv[3];
if (!toolsDir || !existsSync(toolsDir)) {
  console.error('kullanım: node scripts/make-bench.js <araç-dizini> [filtre]');
  process.exit(2);
}
const outDir = new URL('../test/bench/', import.meta.url);


// CLI betikleri web SAPI'sinde çalışırken beklenen sabitler
const CLI_SHIM = `if (!defined('STDERR')) define('STDERR', fopen('php://stderr', 'w'));
if (!defined('STDOUT')) define('STDOUT', fopen('php://stdout', 'w'));
if (!defined('STDIN')) define('STDIN', fopen('php://stdin', 'r'));
mt_srand(7); srand(7); unset($_SERVER['SERVER_SOFTWARE']);
`;

const q = (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

// ---- araçlar: sürücü PHP kodu /work/in.php'yi okur, sonucu /work/out.php'ye yazar; araç /tool altındadır ----
const yak = (flags) => ({
  tool: 'yakpro-po', dir: 'pk-fr_yakpro-po', version: '8.3',
  driver: `<?php ${CLI_SHIM}
$argv = array('/tool/yakpro-po.php', '--silent', ${flags.map(q).join(', ')}${flags.length ? ', ' : ''}'/work/in.php', '-o', '/work/out.php');
$argc = count($argv); $_SERVER['argv'] = $argv;
chdir('/work');
include '/tool/yakpro-po.php';
`,
});

const naneau = (visitors) => ({
  tool: 'naneau/php-obfuscator', dir: 'naneau_php-obfuscator', version: '7.4',
  driver: `<?php ${CLI_SHIM}
require '/tool/PHP-Parser/lib/bootstrap.php';
spl_autoload_register(function ($c) { $p = '/tool/src/' . str_replace('\\\\', '/', $c) . '.php'; if (is_file($p)) require $p; });
$s = new Naneau\\Obfuscator\\StringScrambler('peel-bench');
$t = new PhpParser\\NodeTraverser();
${visitors.map((v) => `$t->addVisitor(new Naneau\\Obfuscator\\Node\\Visitor\\${v}($s));`).join('\n')}
$p = new PhpParser\\Parser(new PhpParser\\Lexer());
$ast = $t->traverse($p->parse(php_strip_whitespace('/work/in.php')));
$pp = new PhpParser\\PrettyPrinter\\Standard();
file_put_contents('/work/out.php', "<?php\\n" . $pp->prettyPrint($ast));
`,
});

const alom = (settings) => ({
  tool: 'Alom', dir: 'avid0_Alom', version: '7.4',
  driver: `<?php ${CLI_SHIM}
include '/tool/alomencoder.obfs.php';
file_put_contents('/work/out.php', AlomEncoder::obfuscator('/work/in.php', ${settings}));
`,
});

const southern = (props) => ({
  tool: 'Southern/php-obfuscator', dir: 'Southern_php-obfuscator', version: '7.4',
  driver: `<?php ${CLI_SHIM}
include '/tool/obfuscator.php';
$o = new Obfuscator();
${props}
$o->file('/work/in.php');
$o->pack();
file_put_contents('/work/out.php', $o->code());
`,
});

const krypt = (modules) => ({
  tool: 'krypt0nn/php-obfuscator', dir: 'krypt0nn_php-obfuscator', version: '8.3',
  driver: `<?php ${CLI_SHIM}
chdir('/tool');
require 'obfuscator.php';
$code = file_get_contents('/work/in.php');
$out = Obfuscator\\Obfuscator::process($code, array('pipeline' => array(${modules.map((m) => `new Obfuscator\\Modules\\${m}`).join(', ')})));
file_put_contents('/work/out.php', $out);
`,
});

const globus = (opts) => ({
  tool: 'GLOBUS-studio/PhpObfuscator', dir: 'GLOBUS-studio_PhpObfuscator', version: '8.3',
  driver: `<?php ${CLI_SHIM}
spl_autoload_register(function ($c) { $pre = 'GLOBUSstudio\\\\PhpObfuscator\\\\'; if (strncmp($c, $pre, strlen($pre))) return; $p = '/tool/src/' . str_replace('\\\\', '/', substr($c, strlen($pre))) . '.php'; if (is_file($p)) require $p; });
$o = new GLOBUSstudio\\PhpObfuscator\\Obfuscator(new GLOBUSstudio\\PhpObfuscator\\Options(${opts}));
file_put_contents('/work/out.php', $o->obfuscate(file_get_contents('/work/in.php')));
`,
});

const JOBS = {
  // YAK Pro: varsayılan (her şey), tek tek teknikler ve ad karıştırma kipleri
  'yakpro-default': { ...yak([]), sources: ['inventory', 'textutil', 'mini'] },
  'yakpro-strings': { ...yak(['--no-obfuscate-if-statement', '--no-obfuscate-loop-statement', '--no-shuffle-statements', '--no-obfuscate-variable-name', '--no-obfuscate-function-name', '--no-obfuscate-class-name', '--no-obfuscate-method-name', '--no-obfuscate-property-name', '--no-obfuscate-constant-name', '--no-obfuscate-class_constant-name', '--no-obfuscate-interface-name']), sources: ['inventory'] },
  'yakpro-flow': { ...yak(['--no-obfuscate-string-literal', '--no-obfuscate-variable-name', '--no-obfuscate-function-name', '--no-obfuscate-class-name', '--no-obfuscate-method-name', '--no-obfuscate-property-name', '--no-obfuscate-constant-name', '--no-obfuscate-class_constant-name', '--no-obfuscate-interface-name']), sources: ['inventory', 'textutil'] },
  'yakpro-shuffle': { ...yak(['--no-obfuscate-string-literal', '--no-obfuscate-if-statement', '--no-obfuscate-loop-statement', '--no-obfuscate-variable-name', '--no-obfuscate-function-name']), sources: ['textutil'] },
  'yakpro-names': { ...yak(['--no-obfuscate-string-literal', '--no-obfuscate-if-statement', '--no-obfuscate-loop-statement', '--no-shuffle-statements']), sources: ['inventory', 'textutil'] },
  'yakpro-hexa': { ...yak(['--scramble-mode', 'hexa', '--scramble-length', '12']), sources: ['mini', 'textutil'] },
  'yakpro-numeric': { ...yak(['--scramble-mode', 'numeric', '--no-strip-indentation']), sources: ['mini', 'inventory'] },
  // naneau: değişken, özel metot ve özel özellik adları
  'naneau-vars': { ...naneau(['ScrambleVariable']), sources: ['inventory', 'textutil'] },
  'naneau-all': { ...naneau(['ScrambleVariable', 'ScramblePrivateMethod', 'ScramblePrivateProperty']), sources: ['inventory', 'textutil', 'mini'] },
  // Alom: katmanlı encoder (eval zinciri, bütünlük denetimi, lisans yorumu)
  'alom-default': { ...alom('array()'), sources: ['mini', 'inventory'] },
  'alom-depth2': { ...alom("array('rounds' => array('main' => array('depth' => 2)), 'license' => array('title' => 'bench', 'author' => 'peel'))"), sources: ['textutil'] },
  'alom-raw': { ...alom("array('style' => array('separated_loader' => false, 'raw' => true))"), sources: ['mini'] },
  // Southern: değişken adları + base64 eval katmanı
  'southern-default': { ...southern(''), sources: ['mini', 'inventory'] },
  'southern-nob64': { ...southern('$o->b64 = false;'), sources: ['mini'] },
  // krypt0nn: dizge/tamsayı kodlama, sessiz çağrılar
  'krypt0nn-strings': { ...krypt(['WhitespaceStrip', 'StringEncoder']), sources: ['mini', 'textutil'] },
  // IntegerEncoder textutil'de geçersiz kod üretiyor ($n--strrev(...)): yalnızca mini
  'krypt0nn-all': { ...krypt(['WhitespaceStrip', 'StringEncoder', 'IntegerEncoder', 'SilentCalls']), sources: ['mini'] },
  // GLOBUS: belirteç tabanlı yeniden adlandırma + base64 dizgeler + eval sarmalayıcı
  'globus-default': { ...globus('seed: 42'), sources: ['inventory', 'textutil'] },
  'globus-noeval': { ...globus('seed: 7, wrapWithEval: false'), sources: ['mini', 'textutil'] },
  'globus-names': { ...globus('seed: 9, wrapWithEval: false, encodeStrings: false'), sources: ['inventory'] },
  // lwertugrul: gzdeflate/gzcompress/base64/strrev zinciri, dizgede tutulan açıcı
  lwertugrul: {
    tool: 'lwertugrul/Php-obfuscator', dir: 'lwertugrul_Php-obfuscator', version: '8.3', sources: ['mini', 'inventory'],
    driver: `<?php ${CLI_SHIM}
$src = file_get_contents('/tool/obfuscator.php');
$src = str_replace('PD9waHAKZWNobyAiSEVMTE8gV09STEQiOwo/Pg==', base64_encode(file_get_contents('/work/in.php')), $src);
file_put_contents('/work/t.php', $src);
ob_start();
include '/work/t.php';
file_put_contents('/work/out.php', ltrim(ob_get_clean()));
`,
  },
  // weizenspreu/ob.php: XOR'lu içerik geçici dosyaya yazılıp include edilir (eval yok)
  weizenspreu: {
    tool: 'weizenspreu/ob.php', dir: 'weizenspreu_ob.php', version: '8.3', sources: ['mini', 'textutil'],
    driver: `<?php ${CLI_SHIM}
$argv = array('ob.php', '/work/in.php'); $argc = 2;
ob_start();
include '/tool/ob.php';
file_put_contents('/work/out.php', ob_get_clean());
`,
  },
  // yapo: gzdeflate'li veri __halt_compiler sonrasında, geçici dosyaya yazılıp require edilir
  yapo: {
    tool: 'Cvar1984/yapo', dir: 'Cvar1984_yapo', version: '8.3', sources: ['mini', 'inventory'],
    driver: `<?php ${CLI_SHIM}
require '/tool/src/Yapo/Exceptions/NotFoundException.php';
require '/tool/src/Yapo/Exceptions/BadPermissionException.php';
require '/tool/src/Yapo/Yapo.php';
copy('/work/in.php', '/work/out.php');
Cvar1984\\Yapo\\Yapo::make('/work/out.php');
`,
  },
  // ricardopedias/php-obfuscator: karıştırılmış açıcı fonksiyonlar + base64/strrev katmanı
  ricardopedias: {
    tool: 'ricardopedias/php-obfuscator', dir: 'ricardopedias_php-obfuscator', version: '8.3', sources: ['mini', 'textutil'],
    driver: `<?php ${CLI_SHIM}
// league/flysystem 1.x yerine yalnızca kullanılan parçalar (Util::pathinfo, Local + Filesystem read/write)
file_put_contents('/work/shim.php', '<?php namespace League\\\\Flysystem { class Util { public static function pathinfo($p) { $i = pathinfo($p); $i["path"] = $p; if (!isset($i["dirname"]) || $i["dirname"] === ".") $i["dirname"] = ""; return $i; } }
class Filesystem { private $a; public function __construct($a) { $this->a = $a; } public function read($f) { return file_get_contents($this->a->root . "/" . $f); } public function write($f, $c) { return file_put_contents($this->a->root . "/" . $f, $c) !== false; } } }
namespace League\\\\Flysystem\\\\Adapter { class Local { public $root; public function __construct($r) { $this->root = rtrim($r, "/"); } } }');
require '/work/shim.php';
spl_autoload_register(function ($c) { $pre = 'PhpObfuscator\\\\'; if (strncmp($c, $pre, strlen($pre))) return; $p = '/tool/src/' . str_replace('\\\\', '/', substr($c, strlen($pre))) . '.php'; if (is_file($p)) require $p; });
$o = (new PhpObfuscator\\Obfuscate())->from('/work/in.php');
$gen = function () { $r = $this->blindMaker()->getRevertFileContents(); return $this->blindMaker()->addPhpWrapper($this->obfuscateUnpackFunctions($r) . $this->getObfuscated()); };
file_put_contents('/work/out.php', Closure::bind($gen, $o, get_class($o))());
`,
  },
};

function copyTree(php, src, dest) {
  php.mkdir(dest);
  for (const name of readdirSync(src)) {
    if (name === '.git' || name === 'tests' || name === 'test' || name === 'doc' || name === 'docs') continue;
    const p = join(src, name);
    const st = statSync(p);
    if (st.isDirectory()) copyTree(php, p, `${dest}/${name}`);
    else if (st.size < 4_000_000) php.writeFile(`${dest}/${name}`, readFileSync(p));
  }
}

let pid = 100;
async function freshPhp(version, toolPath) {
  const php = new PHP(await loadNodeRuntime(version, { emscriptenOptions: { processId: ++pid } }));
  await setPhpIniEntries(php, { memory_limit: '1024M', display_errors: '1', error_reporting: String(32767), 'date.timezone': 'UTC', max_execution_time: '0' });
  await php.setSapiName('cli');
  php.setSkipShebang(true);
  copyTree(php, toolPath, '/tool');
  php.mkdir('/work');
  return php;
}

mkdirSync(outDir, { recursive: true });
const manifestPath = new URL('manifest.json', outDir);
const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : {};
let made = 0;
for (const [job, spec] of Object.entries(JOBS)) {
  if (filter && !job.includes(filter)) continue;
  const toolPath = join(toolsDir, spec.dir);
  if (!existsSync(toolPath)) { console.log(`atla ${job}: ${spec.dir} yok`); continue; }
  for (const srcName of spec.sources) {
    const name = `${job}--${srcName}`;
    // her örnek taze PHP: araçların global durumu (sınıf tanımları, sayaçlar) birbirine sızmasın
    const php = await freshPhp(spec.version, toolPath);
    php.writeFile('/work/in.php', SOURCES[srcName].code);
    php.writeFile('/work/driver.php', spec.driver);
    let res;
    try {
      res = await php.run({ scriptPath: '/work/driver.php' });
    } catch (e) {
      res = e?.response ?? { text: String(e?.message ?? e), errors: '' };
    }
    const out = php.fileExists('/work/out.php') ? Buffer.from(php.readFileAsBuffer('/work/out.php')) : null;
    php.exit();
    if (!out || !out.length || out.equals(Buffer.from(SOURCES[srcName].code))) {
      console.log(`FAIL ${name}: çıktı yok\n${String(res.text).slice(0, 600)}\n${String(res.errors ?? '').slice(0, 600)}`);
      continue;
    }
    for (const f of readdirSync(outDir)) if (f === `${name}.php.x`) rmSync(new URL(f, outDir));
    writeFileSync(new URL(`${name}.php.x`, outDir), encodeFixture(out));
    manifest[name] = { tool: spec.tool, job, source: srcName, phpVersion: spec.version, bytes: out.length, driver: spec.driver.replace(CLI_SHIM, '').replace(/^<\?php\s*/, '') };
    made++;
    console.log(`ok   ${name} (${out.length} bayt)${/\b(Warning|Fatal|Deprecated)\b/.test(res.text) ? ` uyarı: ${res.text.slice(0, 200).replace(/\s+/g, ' ')}` : ''}`);
  }
}
writeFileSync(manifestPath, `${JSON.stringify(Object.fromEntries(Object.entries(manifest).sort()), null, 2)}\n`);
console.log(`${made} örnek yazıldı`);
