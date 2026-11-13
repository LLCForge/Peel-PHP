// Benchmark kaynak programları: gizlenmeden önceki özgün kod. Zararsız, gerçekçi PHP (fonksiyonlar, sınıflar,
// döngüler, dizgeler, çıktı). Eski araçlar da işleyebilsin diye PHP 5.6 sözdizimiyle yazılır (tür bildirimi, ?? yok).
// needles: çözülmüş çıktıda bulunması beklenen özgün literaller (tırnaksız; biçimlendirici tırnak türünü değiştirebilir).

export const SOURCES = {
  inventory: {
    code: `<?php
// Küçük envanter raporu
define('TAX_RATE', 0.18);

interface Describable
{
    public function describe();
}

class Product implements Describable
{
    const CURRENCY = 'TRY';
    private $name;
    private $price;
    private $qty;

    public function __construct($name, $price, $qty)
    {
        $this->name = $name;
        $this->price = $price;
        $this->qty = $qty;
    }

    public function total()
    {
        return $this->price * $this->qty;
    }

    private function label()
    {
        return strtoupper(substr($this->name, 0, 3));
    }

    public function describe()
    {
        return sprintf("%-10s %3d x %8.2f = %9.2f %s [%s]", $this->name, $this->qty, $this->price, $this->total(), self::CURRENCY, $this->label());
    }

    public function getQty()
    {
        return $this->qty;
    }
}

function format_money($amount)
{
    return number_format($amount, 2, ',', '.') . ' ' . Product::CURRENCY;
}

function apply_tax($amount, $rate = TAX_RATE)
{
    return round($amount * (1 + $rate), 2);
}

$items = array(
    new Product('Keyboard', 349.90, 3),
    new Product('Mouse', 129.50, 5),
    new Product('Monitor', 2899.00, 2),
    new Product('Cable', 39.99, 12),
);
$sum = 0;
$count = 0;
foreach ($items as $index => $item) {
    echo ($index + 1) . '. ' . $item->describe() . "\\n";
    $sum += $item->total();
    $count += $item->getQty();
}
echo "Items: $count\\n";
echo 'Subtotal: ' . format_money($sum) . "\\n";
echo 'With tax: ' . format_money(apply_tax($sum)) . "\\n";
$low = array_filter($items, function ($p) {
    return $p->getQty() < 4;
});
echo 'Low stock: ' . count($low) . "\\n";
for ($i = 0; $i < 3; $i++) {
    if ($i % 2 == 0) {
        echo "even $i\\n";
    } else {
        echo "odd $i\\n";
    }
}
$n = 5;
$fact = 1;
while ($n > 1) {
    $fact *= $n;
    $n--;
}
echo "5! = $fact\\n";
switch ($count % 3) {
    case 0:
        echo "bucket zero\\n";
        break;
    case 1:
        echo "bucket one\\n";
        break;
    default:
        echo "bucket two\\n";
}
`,
    needles: ['Keyboard', 'Monitor', 'Subtotal: ', 'With tax: ', 'Low stock: ', 'bucket zero', '%-10s %3d x'],
  },

  textutil: {
    code: `<?php
class Slugger
{
    private static $count = 0;

    public static function slug($text)
    {
        self::$count++;
        $t = strtolower(trim($text));
        $t = preg_replace('/[^a-z0-9]+/', '-', $t);
        return trim($t, '-');
    }

    public static function total()
    {
        return self::$count;
    }
}

function fib($n)
{
    return $n < 2 ? $n : fib($n - 1) + fib($n - 2);
}

function word_stats($text)
{
    $words = preg_split('/\\s+/', strtolower($text), -1, PREG_SPLIT_NO_EMPTY);
    $freq = array();
    foreach ($words as $w) {
        $w = trim($w, '.,!?');
        if ($w === '') {
            continue;
        }
        if (!isset($freq[$w])) {
            $freq[$w] = 0;
        }
        $freq[$w]++;
    }
    arsort($freq);
    return array_slice($freq, 0, 3, true);
}

function safe_divide($a, $b)
{
    if ($b == 0) {
        throw new InvalidArgumentException('Division by zero');
    }
    return $a / $b;
}

$titles = array('Hello World!', '  PHP Deobfuscation 101 ', 'Peel the Onion');
foreach ($titles as $t) {
    echo Slugger::slug($t) . "\\n";
}
echo 'slugs: ' . Slugger::total() . "\\n";
$fibs = array();
for ($i = 0; $i < 10; $i++) {
    $fibs[] = fib($i);
}
echo implode(',', $fibs) . "\\n";
$text = 'The quick brown fox jumps over the lazy dog. The dog sleeps, the fox runs!';
foreach (word_stats($text) as $word => $c) {
    echo "$word=$c\\n";
}
try {
    echo safe_divide(10, 4) . "\\n";
    echo safe_divide(1, 0) . "\\n";
} catch (InvalidArgumentException $e) {
    echo 'error: ' . $e->getMessage() . "\\n";
}
$squares = array_map(function ($x) {
    return $x * $x;
}, range(1, 5));
echo 'squares: ' . implode(' ', $squares) . "\\n";
$config = array('host' => 'db.internal.example', 'port' => 5432, 'user' => 'report');
ksort($config);
foreach ($config as $k => $v) {
    printf("%s => %s\\n", $k, $v);
}
echo str_pad('done', 10, '*', STR_PAD_BOTH) . "\\n";
`,
    needles: ['Hello World!', 'Division by zero', 'The quick brown fox', 'db.internal.example', 'squares: ', 'error: '],
  },

  mini: {
    code: `<?php
$greeting = 'Merhaba';
$names = array('Ada', 'Linus', 'Grace');
function shout($s)
{
    return strtoupper($s) . '!';
}
foreach ($names as $i => $name) {
    echo $greeting . ', ' . $name . ' #' . ($i + 1) . "\\n";
}
echo shout('peel') . "\\n";
$total = 0;
for ($k = 1; $k <= 10; $k++) {
    $total += $k;
}
echo 'Toplam: ' . $total . "\\n";
`,
    needles: ['Merhaba', 'Linus', 'Toplam: ', 'peel'],
  },
};
