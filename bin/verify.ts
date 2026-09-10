/**
 * Self-test for the oracle: re-composite every isolated tile in paint order and
 * compare with the untouched page screenshot. A near-zero score means each tile
 * really is that element alone, in the right place -- which is the whole premise.
 */
import sharp from 'sharp';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { compare } from '../packages/harness/metric.js';
import type { StructureIR, Oracle } from '../packages/schema/ir.js';

const dir = process.argv[2] ?? 'out/L';
const ir: StructureIR = JSON.parse(readFileSync(join(dir, 'structure.json'), 'utf8'));
const oracle: Oracle = JSON.parse(readFileSync(join(dir, 'oracle.json'), 'utf8'));
const dpr = ir.viewport.dpr;

const ref = sharp(oracle.full);
const { width = 0, height = 0 } = await ref.metadata();

const layers = ir.nodes
  .filter(n => oracle.tiles[n.id])
  .sort((a, b) => a.paintOrder - b.paintOrder)
  .map(n => ({ input: oracle.tiles[n.id], left: Math.round(n.rect.x * dpr), top: Math.round(n.rect.y * dpr) }))
  .filter(l => l.left < width && l.top < height && l.left >= 0 && l.top >= 0);

// the root background propagates to the whole canvas -- the emitter paints it on the page frame
const rootBg = ir.nodes.find(n => n.tag === 'body')?.style['background-color'] ?? 'white';
const rebuilt = await sharp({ create: { width, height, channels: 4, background: rootBg } })
  .composite(layers).png().toBuffer();

writeFileSync(join(dir, 'rebuilt.png'), rebuilt);

// side-by-side, downscaled: the one file worth sending when something looks wrong
const w = Math.min(900, width);
const [l, r] = await Promise.all([sharp(oracle.full).resize(w).toBuffer(), sharp(rebuilt).resize(w).toBuffer()]);
const h = (await sharp(l).metadata()).height ?? 0;
await sharp({ create: { width: w * 2 + 12, height: h, channels: 4, background: '#e11d48' } })
  .composite([{ input: l, left: 0, top: 0 }, { input: r, left: w + 12, top: 0 }])
  .png().toFile(join(dir, 'compare.png'));

const m = await compare(oracle.full, rebuilt);
const hot = m.heat.flatMap((row, y) => row.map((v, x) => ({ v, x, y }))).sort((a, b) => b.v - a.v).slice(0, 3);
console.log(`${dir}  ${layers.length} tiles -> ${m.width}x${m.height}`);
console.log(`  meanΔE ${m.meanDeltaE}   p95ΔE ${m.p95DeltaE}   SSIM ${m.ssim}`);
console.log(`  hottest cells: ${hot.map(c => `(${c.x},${c.y})=${c.v}`).join('  ')}`);
console.log(`  left=Chrome right=rebuilt -> ${join(dir, 'compare.png')}`);
if (ir.prepared) {
  const p = ir.prepared;
  if (p.dismissed.length) console.log(`  dismissed: ${p.dismissed.join(' | ')}`);
  if (p.blockers.length) console.log(`  STILL BLOCKING: ${p.blockers.map(b => `${b.tag}.${b.cls} (${b.area}% of viewport)`).join(' | ')}`);
}
