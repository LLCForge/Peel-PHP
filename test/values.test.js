// Değer okuma/yazma öz-denetimi: node test/values.test.js
import assert from 'node:assert/strict';
import { unserialize, phpLiteral, phpString } from '../src/core/values.js';

assert.equal(phpLiteral(unserialize('s:5:"hello";')), "'hello'");
assert.equal(phpLiteral(unserialize('s:4:"a\'b\\";')), "'a\\'b\\\\'");
assert.equal(phpLiteral(unserialize('i:-5;')), '(-5)');
assert.equal(phpLiteral(unserialize('d:1;')), '1.0');
assert.equal(phpLiteral(unserialize('b:1;')), 'true');
assert.equal(phpLiteral(unserialize('N;')), 'null');
assert.equal(phpLiteral(unserialize('a:2:{i:0;s:1:"a";i:1;i:2;}')), "['a', 2]");
assert.equal(phpLiteral(unserialize('a:1:{s:1:"k";s:1:"v";}')), "['k' => 'v']");
assert.equal(unserialize('O:8:"stdClass":0:{}'), undefined);
// ikili bayt ve kontrol karakteri: çift tırnak + kaçış; $ kaçırılır
assert.equal(phpString('a\x00b$'), '"a\\x00b\\$"');
// geçerli UTF-8 (ş = c5 9f) okunur kalır, geçersiz bayt kaçırılır
assert.equal(phpString('\xc5\x9f'), "'\xc5\x9f'");
assert.equal(phpString('\xff'), '"\\xff"');
console.log('values: ok');
