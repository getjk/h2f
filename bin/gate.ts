/** Runs the corpus at every size and prints the score table a PR has to show. */
import { capture } from '../packages/capture/capture.js';
import { compare } from '../packages/harness/metric.js';
import sharp from 'sharp';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/** Name the failure mode: a dead renderer and a dead network need different fixes. */
function classify(msg: string) {
  if (/Target page, context or browser has been closed|Target crashed/i.test(msg)) return '**renderer died or timed out**';
  if (/net::ERR_|ERR_CONNECTION|ERR_NAME_NOT_RESOLVED/i.test(msg)) return '**network**';
  if (/Timeout.*exceeded|timeout/i.test(msg)) return '**timeout**';
  return '**' + msg.split('\n')[0].slice(0, 44) + '**';
}
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
  let ir, oracle, phase;
  try { ({ ir, oracle, phase } = await capture(target, size, out)) }
  catch (e) {
    // The full text goes to a file: the one-line cell always cuts off the evidence.
    const msg = (e as Error).message ?? String(e);
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'error.txt'), `${target}\n${size}\n\n${msg}\n\n${(e as Error).stack ?? ''}`);
    console.log(`| ${p.id} | ${size} | — | — | — | — | — | — | — | ${classify(msg)} → ${join(out, 'error.txt')} |`);
    continue;
  }
  const dpr = ir.viewport.dpr;
  const { width = 0, height = 0 } = await sharp(oracle.full).metadata();
  const layers = ir.nodes.filter(n => oracle.tiles[n.id]).sort((a, b) => a.paintOrder - b.paintOrder)
    .map(n => ({ input: oracle.tiles[n.id], left: Math.round(n.rect.x * dpr), top: Math.round(n.rect.y * dpr) }))
    .filter(l => l.left >= 0 && l.top >= 0 && l.left < width && l.top < height);
  const bg = ir.nodes.find(n => n.tag === 'body')?.style['background-color'] ?? 'white';
  const rebuilt = await sharp({ create: { width, height, channels: 4, background: bg } }).composite(layers).png().toBuffer();
  const m = await compare(oracle.full, rebuilt);
  console.log(`| ${p.id} | ${size} | ${ir.nodes.length} | ${layers.length} | ${m.meanDeltaE} | ${m.p95DeltaE} | ${m.ssim} | ${ir.prepared.dismissed.length} | ${ir.prepared.blockers.length} | ${((Date.now() - t) / 1000).toFixed(1)} |`);
  const notes = [
    `phases ${Object.entries(phase!).map(([k, v]) => `${k} ${v}s`).join('  ')}`,
    oracle.skipped ? `${oracle.skipped} painting nodes over the tile cap` : '',
    oracle.overflowX ? `page overflows ${oracle.overflowX}px to the right; ${oracle.offscreenX} nodes unreachable (horizontal scroll is not captured)` : '',
    ir.prepared.truncated ? `scroll truncated on ${ir.prepared.truncated}` : '',
    ir.prepared.failed ? `PREPARATION FAILED: ${ir.prepared.failed}` : '',
    ir.prepared.blockers.length ? `BLOCKING: ${JSON.stringify(ir.prepared.blockers)}` : '',
    ir.prepared.dismissed.length ? `clicked: ${ir.prepared.dismissed.join(' | ')}` : '',
  ].filter(Boolean);
  for (const n of notes) console.error(`    ${n}`);
}
