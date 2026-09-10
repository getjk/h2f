/**
 * The offline fitting loop: capture -> plan -> emulate -> screenshot -> diff -> demote.
 * No Figma anywhere. This is where the ladder actually descends.
 */
import { chromium } from 'playwright';
import sharp from 'sharp';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { plan } from '../packages/plan/plan.js';
import { render } from '../packages/emulator/render.js';
import { compare } from '../packages/harness/metric.js';
import type { StructureIR, Oracle } from '../packages/schema/ir.js';
import type { CandidateIR } from '../packages/schema/candidate.js';

const dir = process.argv[2] ?? 'out/L';
const threshold = +(process.env.H2F_RUNG_THRESHOLD ?? 2.0);   // demote a vector node above this
// A tile that is actually broken scores an order of magnitude worse than one that merely
// carries antialiased text: the SVG-isolation bug scored 38, a correct text tile ~3. So
// the "this tile is wrong" alarm sits well above the demotion threshold on purpose.
const brokenTile = +(process.env.H2F_BROKEN_TILE ?? 12);

const ir: StructureIR = JSON.parse(readFileSync(join(dir, 'structure.json'), 'utf8'));
const oracle: Oracle = JSON.parse(readFileSync(join(dir, 'oracle.json'), 'utf8'));
const dpr = ir.viewport.dpr;

async function shoot(cand: CandidateIR, out: string) {
  const html = render(cand);
  const file = join(dir, 'emulated.html');
  writeFileSync(file, html);
  const browser = await chromium.launch({
    ...(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {}),
    // The emulated page is a local file referencing local tiles and images; Chromium
    // blocks file:// subresources from a file:// document without this.
    args: ['--no-sandbox', '--font-render-hinting=none', '--disable-lcd-text', '--allow-file-access-from-files'],
  });
  const page = await browser.newPage({ viewport: { width: Math.round(cand.page.w), height: 900 }, deviceScaleFactor: dpr });
  const cdp = await page.context().newCDPSession(page);
  await page.goto('file://' + resolve(file), { waitUntil: 'load' });
  await page.evaluate(() => document.fonts?.ready);
  // Static, absolutely positioned, no vh and nothing sticky, so capturing beyond the
  // viewport cannot reflow anything here.
  const { data } = await cdp.send('Page.captureScreenshot', {
    format: 'png', captureBeyondViewport: true,
    clip: { x: 0, y: 0, width: cand.page.w, height: cand.page.h, scale: dpr },
  });
  await browser.close();
  const buf = Buffer.from(data, 'base64');
  writeFileSync(out, buf);
  return buf;
}

/**
 * Score each node over its OWN pixels: its rect minus every descendant's rect. Oracle
 * tiles are self-only, so a parent scored over its whole box would just be reporting
 * its children's errors back as its own.
 */
function ownScores(cand: CandidateIR, field: Float32Array, W: number, H: number, scale: number) {
  const kids = new Map<number, typeof cand.nodes>();
  for (const n of cand.nodes) if (n.parent !== null) (kids.get(n.parent) ?? kids.set(n.parent, []).get(n.parent)!).push(n);
  const out: Record<number, number> = {};
  const box = (r: { x: number; y: number; w: number; h: number }) => [
    Math.max(0, Math.round(r.x * scale)), Math.max(0, Math.round(r.y * scale)),
    Math.min(W, Math.round((r.x + r.w) * scale)), Math.min(H, Math.round((r.y + r.h) * scale)),
  ] as const;

  for (const n of cand.nodes) {
    const [x0, y0, x1, y1] = box(n.rect);
    const holes = (kids.get(n.id) ?? []).map(k => box(k.rect));
    let sum = 0, count = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      if (holes.some(([hx0, hy0, hx1, hy1]) => x >= hx0 && x < hx1 && y >= hy0 && y < hy1)) continue;
      sum += field[y * W + x]; count++;
    }
    out[n.id] = count ? +(sum / count).toFixed(3) : 0;
  }
  return out;
}

// Tile paths in oracle.json are relative to the repo root; the emulated HTML is loaded
// from a file:// URL, so they have to be absolute before they become url(...).
const tiles = Object.fromEntries(Object.entries(oracle.tiles).map(([k, v]) => [k, resolve(v)]));
/**
 * Two measurements, deliberately different.
 *
 * Fidelity is the raw diff -- that is the number we are judged on.
 *
 * The rung decision uses a slightly blurred diff, because glyph antialiasing puts a
 * text-dense region several deltaE above a flat one while looking identical to the eye.
 * Judging both with one threshold demotes perfectly good text to raster.
 */
const soften = (b: Buffer | string) => sharp(b).blur(1).png().toBuffer();

let cand = plan(ir, tiles);
async function measure(png: Buffer) {
  const fidelity = await compare(oracle.full, png);
  const soft = await compare(await soften(oracle.full), await soften(png));
  return { fidelity, scores: ownScores(cand, soft.field, soft.width, soft.height, dpr) };
}

let { fidelity: m, scores } = await measure(await shoot(cand, join(dir, 'emulated.png')));

// Demote whatever missed, then re-render once. Most nodes never move.
const missed = cand.nodes.filter(n => n.rung === 'vector' && (scores[n.id] ?? 0) > threshold && tiles[n.id]);
for (const n of missed) { n.rung = 'raster'; n.reason = `deltaE ${scores[n.id]}`; n.fills = [{ type: 'RASTER', tile: tiles[n.id] }]; n.text = undefined }
if (missed.length) ({ fidelity: m, scores } = await measure(await shoot(cand, join(dir, 'emulated.png'))));

for (const n of cand.nodes) n.score = scores[n.id];
writeFileSync(join(dir, 'candidate.json'), JSON.stringify(cand));

const by = (r: string) => cand.nodes.filter(n => n.rung === r).length;
console.log(`${dir}  ${cand.nodes.length} nodes`);
console.log(`  page   meanΔE ${m.meanDeltaE}   p95ΔE ${m.p95DeltaE}   SSIM ${m.ssim}`);
console.log(`  rungs  vector ${by('vector')}  raster ${by('raster')}   (demoted ${missed.length} this pass)`);
// Worst nodes at ANY rung. A raster node scoring badly means its tile is wrong, which
// is the loudest signal there is -- and it was invisible while this only listed vectors.
const worst = [...cand.nodes].sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, 5);
if (worst[0]?.score) console.log('  worst nodes: ' + worst.map(n => `${n.name}[${n.rung}]=${n.score}`).join('  '));
const badRaster = cand.nodes.filter(n => n.rung === 'raster' && (n.score ?? 0) > brokenTile);
if (badRaster.length) console.log(`  ${badRaster.length} BROKEN TILES -- capture is wrong for: ${badRaster.map(n => n.name).join(', ')}`);
