// Fixture kodlaması: XOR (sabit anahtar) + base64. Amaç gizlilik değil; zararlı koda benzeyen test örneklerinin
// diskte antivirüs imzalarına takılmaması. Çözülen içerik yalnızca bellekte kullanılır.
const KEY = Buffer.from('peel-fixture-not-malware');

const xor = (buf) => Buffer.from(buf.map((b, i) => b ^ KEY[i % KEY.length]));

export const encodeFixture = (bytes) => `${xor(bytes).toString('base64')}
`;
export const decodeFixture = (text) => xor(Buffer.from(text.trim(), 'base64'));
