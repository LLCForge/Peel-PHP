// Prettier ile PHP biçimlendirme (tarayıcıda ve Node'da aynı: standalone sürüm). Başarısız olursa null.
import * as prettier from 'prettier/standalone';
import * as phpModule from '@prettier/plugin-php/standalone';

// eklenti standalone pakette default dışa aktarımla gelir
const phpPlugin = phpModule.default ?? phpModule;

export async function format(code, options = {}) {
  try {
    return await prettier.format(code, { parser: 'php', plugins: [phpPlugin], phpVersion: '8.3', printWidth: 100, tabWidth: 4, singleQuote: true, ...options });
  } catch {
    return null;
  }
}
