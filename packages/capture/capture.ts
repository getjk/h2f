import { chromium, type Page, type CDPSession } from 'playwright';
import sharp from 'sharp';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { StructureIR, Oracle, CaptureSize, Rect, ElementNode } from '../schema/ir.js';

export const SIZES = {
  L: { w: 1440, h: 900, dpr: 2, mobile: false, ua: undefined },
  M: { w: 834, h: 1194, dpr: 2, mobile: true, ua: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' },
  S: { w: 393, h: 852, dpr: 3, mobile: true, ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' },
} as const;

const INPAGE = readFileSync(new URL('./inpage.js', import.meta.url), 'utf8');
const PREPARE = readFileSync(new URL('./prepare.js', import.meta.url), 'utf8');
const FREEZE = `*,*::before,*::after{animation-play-state:paused!important;animation-delay:-1ms!important;transition:none!important;caret-color:transparent!important}`;
// Each tile is one element's OWN paint: its box and its own text, without descendants.
// Composing the self-tiles of a subtree gives the subtree; composing all of them in
// paint order gives the page. Order matters -- the last two rules tie on specificity.
// The root background propagates to the viewport canvas and paints under everything
// regardless of visibility, so it has to be cleared unless it is itself the target.
// Sticky/fixed elements ride the viewport, so they would appear once per stitched
// strip. They are captured in the first strip, at their scroll-0 position, and
// hidden after that. visibility keeps their layout space intact.
const PINNED = `html.h2f-nopin [data-h2f-pin]{visibility:hidden!important}`;
const ISOLATE = `*{visibility:hidden!important}`
  + `html:not([data-h2f]),body:not([data-h2f]){background:none!important}`
  + `[data-h2f]{visibility:visible!important}[data-h2f] *{visibility:hidden!important}`
  // an <svg> is a leaf to us, so its internals belong to its own paint
  + `[data-h2f] svg,[data-h2f] svg *{visibility:visible!important}`;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** Greedy pack into batches of mutually non-overlapping rects, so one screenshot yields many tiles. */
function pack(nodes: ElementNode[], vh: number): ElementNode[][] {
  const bands = new Map<number, ElementNode[][]>();
  for (const n of nodes) {
    const band = Math.floor(n.rect.y / vh);
    const list = bands.get(band) ?? (bands.set(band, []), bands.get(band)!);
    const b = list.find(batch => !batch.some(m => overlaps(m.rect, n.rect)));
    if (b) b.push(n); else list.push([n]);
  }
  return [...bands.keys()].sort((a, b) => a - b).flatMap(k => bands.get(k)!);
}

const union = (rs: Rect[]): Rect => {
  const x = Math.min(...rs.map(r => r.x)), y = Math.min(...rs.map(r => r.y));
  return { x, y, w: Math.max(...rs.map(r => r.x + r.w)) - x, h: Math.max(...rs.map(r => r.y + r.h)) - y };
};

/**
 * Screenshot a page-space rect by scrolling and stitching viewport-sized strips.
 * captureBeyondViewport would be shorter, but it temporarily changes device metrics,
 * which re-lays-out the page under mobile emulation -- the geometry we collected
 * would no longer describe the pixels we captured.
 */
async function shotRegion(page: Page, cdp: CDPSession, rect: Rect, dpr: number, vw: number, vh: number): Promise<Buffer> {
  const W = Math.max(1, Math.round(rect.w * dpr)), H = Math.max(1, Math.round(rect.h * dpr));
  const parts: sharp.OverlayOptions[] = [];
  let strip = 0;
  for (let y = rect.y; y < rect.y + rect.h; y += vh, strip++) {
    const at = await page.evaluate(([yy, hide]) => {
      document.documentElement.classList.toggle('h2f-nopin', hide as boolean);
      window.scrollTo(0, yy as number);
      return window.scrollY;
    }, [y, strip > 0] as const);
    // clip to the visible viewport (never beyond it) so device metrics -- and the
    // layout we measured -- stay untouched; scale gives us DPR pixels.
    const { data } = await cdp.send('Page.captureScreenshot', {
      format: 'png', clip: { x: 0, y: at, width: vw, height: vh, scale: dpr },
    });
    const img = Buffer.from(data, 'base64');
    const meta = await sharp(img).metadata();
    const imgW = meta.width ?? 0, imgH = meta.height ?? 0;
    if (imgW === 0 || imgH === 0) continue;
    // page space -> this strip's image space
    const left = Math.round(rect.x * dpr), top = Math.round((y - at) * dpr);
    // skip if the extract region is completely outside the screenshot
    if (left >= imgW || top >= imgH || left + W <= 0 || top + Math.round(Math.min(vh, rect.y + rect.h - y) * dpr) <= 0) continue;
    // compute the intersection between the wanted rect and what the screenshot contains
    const clipLeft = Math.max(0, left), clipTop = Math.max(0, top);
    const clipRight = Math.min(imgW, left + W), clipBottom = Math.min(imgH, top + Math.round(Math.min(vh, rect.y + rect.h - y) * dpr));
    const w = clipRight - clipLeft, h = clipBottom - clipTop;
    if (w <= 0 || h <= 0) continue;
    parts.push({ input: await sharp(img).extract({ left: clipLeft, top: clipTop, width: w, height: h }).png().toBuffer(), left: clipLeft - left, top: Math.round((y - rect.y) * dpr) + (clipTop - top) });
  }
  return sharp({ create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite(parts).png().toBuffer();
}

export async function capture(url: string, size: CaptureSize, outDir: string) {
  const t0 = Date.now(); const phase: Record<string, number> = {};
  const mark = (name: string) => { phase[name] = Math.round((Date.now() - t0) / 100) / 10 };
  const s = SIZES[size];
  mkdirSync(outDir, { recursive: true });
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  const browser = await chromium.launch({
    // CHROMIUM overrides; otherwise Playwright uses the browser it installed
    ...(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {}),
    args: ['--no-sandbox', '--font-render-hinting=none', '--disable-lcd-text',
      // Some corporate TLS-terminating proxies reset Chromium's TLS 1.3 handshake
      // while curl and Node succeed. Capping the version still verifies certificates
      // and does not change how a page renders. Opt-in; never on by default.
      ...(process.env.H2F_TLS12 ? ['--ssl-version-max=tls1.2'] : [])],
    ...(proxy ? { proxy: { server: proxy } } : {}),
  });
  const ctx = await browser.newContext({
    viewport: { width: s.w, height: s.h }, deviceScaleFactor: s.dpr,
    isMobile: s.mobile, hasTouch: s.mobile, userAgent: s.ua, reducedMotion: 'reduce',
  });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);

  // A page with no viewport meta gets Chrome's 980px fallback plus page scale, which
  // puts layout, scroll and screenshot coordinates in three different spaces -- and
  // imports a zoomed-out desktop layout no designer wants. Lay it out at device width
  // instead, and say so in the report.
  let injectedViewportMeta = false;
  if (s.mobile) await page.addInitScript(() => {
    addEventListener('DOMContentLoaded', () => {
      if (document.querySelector('meta[name="viewport"]')) return;
      const m = document.createElement('meta');
      m.name = 'viewport'; m.content = 'width=device-width,initial-scale=1';
      document.head.prepend(m);
      (window as any).__h2fInjectedViewport = true;
    }, { once: true });
  });

  // A hard wall clock: one slow site must not stall a corpus run. Closing the browser
  // rejects whatever CDP call is outstanding, so this escapes hangs anywhere below.
  const wall = +(process.env.H2F_TIMEOUT_MS ?? 240_000);
  const bomb = setTimeout(() => { browser.close().catch(() => {}) }, wall);

  await page.goto(url, { waitUntil: 'load', timeout: 60_000 });
  await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
  mark('load');
  await page.addStyleTag({ content: FREEZE });
  const budget = +(process.env.H2F_BUDGET_MS ?? 25000), maxHeight = +(process.env.H2F_MAX_HEIGHT ?? 30000);
  // If preparation dies (a renderer OOM on a heavy page), capture what the page has
  // rather than losing it entirely -- and say in the report that it was not prepared.
  const blank: StructureIR['prepared'] = { dismissed: [], blockers: [], videos: [], truncated: null };
  const prep = await page.evaluate(PREPARE + `; window.__h2fPrepare({budgetMs:${budget},maxHeight:${maxHeight}})`)
    .then(r => r as StructureIR['prepared'])
    .catch((e: Error) => ({ ...blank, failed: e.message.split('\n')[0] }));
  if (page.isClosed()) throw new Error('renderer died during preparation');
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
  mark('prepare');
  await page.addStyleTag({ content: PINNED });
  await page.evaluate(() => {
    for (const el of document.querySelectorAll('*')) {
      const p = getComputedStyle(el).position;
      if (p === 'fixed' || p === 'sticky') el.setAttribute('data-h2f-pin', p);
    }
  });

  // The layout viewport is what CSS sees -- under mobile emulation (or with a
  // classic scrollbar) it differs from the device size, and every clip depends on it.
  await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1 }).catch(() => {});
  const lay = await page.evaluate(() => ({ w: document.documentElement.clientWidth, h: document.documentElement.clientHeight }));
  injectedViewportMeta = await page.evaluate(() => !!(window as any).__h2fInjectedViewport);

  const raw = await page.evaluate(INPAGE + '; window.__h2f()') as any;
  mark('collect');
  const ir: StructureIR = { ...raw, size, viewport: { w: s.w, h: s.h, dpr: s.dpr }, layout: lay, injectedViewportMeta, prepared: prep };

  // reference: the whole page as Chrome draws it
  const overflowX = Math.max(0, ir.page.w - lay.w);
  const full = { x: 0, y: 0, w: Math.min(ir.page.w, lay.w), h: Math.min(ir.page.h, 30_000) };
  writeFileSync(join(outDir, 'full.png'), await shotRegion(page, cdp, full, s.dpr, lay.w, lay.h));
  mark('reference');

  // oracle: each element alone, transparent, in page coordinates
  await cdp.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
  await page.addStyleTag({ content: ISOLATE });

  const maxTiles = +(process.env.H2F_MAX_TILES ?? 2000);
  // Nodes starting beyond the layout viewport (carousel items scrolled off to the
  // right) can never be photographed, so they are counted, not silently blank.
  const reachable = ir.nodes.filter(n => n.paints && !n.noIsolate && n.rect.w >= 1 && n.rect.h >= 1 && n.rect.w * n.rect.h < 12e6);
  const offscreen = reachable.filter(n => n.rect.x >= lay.w).length;
  const all = reachable.filter(n => n.rect.x < lay.w);
  // Biggest first, so a cap drops the least visible things rather than an arbitrary tail.
  const targets = all.length <= maxTiles ? all
    : [...all].sort((a, b) => b.rect.w * b.rect.h - a.rect.w * a.rect.h).slice(0, maxTiles);
  const tiles: Record<number, string> = {};
  const batches = pack(targets, lay.h);
  mkdirSync(join(outDir, 'tiles'), { recursive: true });

  let done = 0;
  for (const batch of batches) {
    if (process.stderr.isTTY || process.env.H2F_PROGRESS) process.stderr.write(`\r  tiles ${done}/${targets.length} (batch ${++done && batches.indexOf(batch) + 1}/${batches.length})   `);
    await page.evaluate(ids => {
      document.querySelectorAll('[data-h2f]').forEach(e => e.removeAttribute('data-h2f'));
      const all = (window as any).__h2fEls as Element[];
      ids.forEach(i => all[i]?.setAttribute('data-h2f', ''));
    }, batch.map(n => n.id));

    const clip = union(batch.map(n => n.rect));
    const png = await shotRegion(page, cdp, clip, s.dpr, lay.w, lay.h);
    const img = sharp(png);
    const { width: IW = 0, height: IH = 0 } = await img.metadata();
    await Promise.all(batch.map(async n => {
      // clip the crop to the screenshot -- rounding and page growth can push a rect over the edge
      const left = clamp(Math.round((n.rect.x - clip.x) * s.dpr), 0, IW - 1);
      const top = clamp(Math.round((n.rect.y - clip.y) * s.dpr), 0, IH - 1);
      const width = clamp(Math.round(n.rect.w * s.dpr), 1, IW - left);
      const height = clamp(Math.round(n.rect.h * s.dpr), 1, IH - top);
      const p = join(outDir, 'tiles', `${n.id}.png`);
      await img.clone().extract({ left, top, width, height }).toFile(p);
      tiles[n.id] = p;
    }));
    done += batch.length - 1;
  }

  mark('oracle');
  clearTimeout(bomb);
  const oracle: Oracle = { size, full: join(outDir, 'full.png'), tiles, skipped: all.length - targets.length, offscreenX: offscreen, overflowX };
  writeFileSync(join(outDir, 'structure.json'), JSON.stringify(ir));
  writeFileSync(join(outDir, 'oracle.json'), JSON.stringify(oracle));
  await browser.close();
  return { ir, oracle, batches: batches.length, phase };
}
