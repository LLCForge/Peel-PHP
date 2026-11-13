// Çalışma anı katmanları: sandbox'ta yakalanan eval / assert / create_function kodları yerine yazılır.
import { expandLayers } from '../core/layers.js';

export const id = 'layers';
export const needsSandbox = true;

export async function run(code, ctx) {
  const trace = await ctx.trace(code);
  if (!trace?.evals.length) return code;
  const r = expandLayers(code, trace);
  if (r.opened) ctx.log(`layers: ${r.opened} katman açıldı${r.kept.length ? `, ${r.kept.length} site açılamadı (${r.kept[0].reason})` : ''}`, 'info');
  ctx.bump('layers', r.opened);
  return r.code;
}
