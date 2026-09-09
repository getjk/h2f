import { capture, SIZES } from '../packages/capture/capture.js';
import type { CaptureSize } from '../packages/schema/ir.js';

const [url, sizesArg = 'L', out = 'out'] = process.argv.slice(2);
if (!url) { console.error('usage: npm run capture -- <url> [L,M,S] [outdir]'); process.exit(1) }

for (const size of sizesArg.split(',') as CaptureSize[]) {
  const t = Date.now();
  const dir = `${out}/${new URL(url).hostname}/${size}`;
  const { ir, oracle, batches } = await capture(url, size, dir);
  console.log(`${size} ${SIZES[size].w}x${SIZES[size].h}@${SIZES[size].dpr}  ${ir.nodes.length} nodes  ${Object.keys(oracle.tiles).length} tiles  ${batches} batches  ${Object.keys(ir.tokens).length} tokens  ${((Date.now() - t) / 1000).toFixed(1)}s  -> ${dir}`);
}
