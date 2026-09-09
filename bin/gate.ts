/** Runs the corpus at every size and prints the score table a PR has to show. */
import { capture } from '../packages/capture/capture.js';
import { compare } from '../packages/harness/metric.js';
import sharp from 'sharp';
import { readFileSync } from 'node:fs';
import type { CaptureSize } from '../packages/schema/ir.js';

type Page = { id: string; url?: string; file?: string; why: string };
const corpus = JSON.parse(readFileSync('packages/harness/corpus.json', 'utf8')) as { sizes: CaptureSize[]; pages: Page[] };
const sizes = (process.argv[2]?.split(',') as CaptureSize[]) ?? corpus.sizes;
const only = process.argv[3]?.split(',');
const pages = corpus.pages.filter(p => !only || only.includes(p.id));

console.log('| page | size | nodes | tiles | meanΔE | p95ΔE | SSIM | dismissed | blockers | s |');
console.log('|---|---|---|---|---|---|---|---|---|---|');
for (const p of pages) for (const size of sizes) {
  const t = Date.now();
  const out = `out/gate/${p.id}/${size}`;
  const target = p.url ?? `file://${process.cwd()}/${p.file}`;
  let ir, oracle;
  try { ({ ir, oracle } = await capture(target, size, out)) }
  catch (e) { console.log(`| ${p.id} | ${size} | — | — | — | — | — | — | — | **${(e as Error).message.split('\n')[0].slice(0, 40)}** |`); continue }
  const dpr = ir.viewport.dpr;
  const { width = 0, height = 0 } = await sharp(oracle.full).metadata();
  const layers = ir.nodes.filter(n => oracle.tiles[n.id]).sort((a, b) => a.paintOrder - b.paintOrder)
    .map(n => ({ input: oracle.tiles[n.id], left: Math.round(n.rect.x * dpr), top: Math.round(n.rect.y * dpr) }))
    .filter(l => l.left >= 0 && l.top >= 0 && l.left < width && l.top < height);
  const bg = ir.nodes.find(n => n.tag === 'body')?.style['background-color'] ?? 'white';
  const rebuilt = await sharp({ create: { width, height, channels: 4, background: bg } }).composite(layers).png().toBuffer();
  const m = await compare(oracle.full, rebuilt);
  console.log(`| ${p.id} | ${size} | ${ir.nodes.length} | ${layers.length} | ${m.meanDeltaE} | ${m.p95DeltaE} | ${m.ssim} | ${ir.prepared.dismissed.length} | ${ir.prepared.blockers.length} | ${((Date.now() - t) / 1000).toFixed(1)} |`);
}
