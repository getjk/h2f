/**
 * StructureIR -> CandidateIR: propose the most editable Figma construct for every
 * element. Pure. No I/O, no browser, no Figma. Everything here is a guess that the
 * emulator is about to grade.
 */
import type { StructureIR, ElementNode, Style } from '../schema/ir.js';
import type { CandidateIR, CandidateNode, Fill, Effect, Stroke, TextRun } from '../schema/candidate.js';

const num = (v: string) => parseFloat(v) || 0;
const transparent = (c: string) => !c || /^rgba\(0, 0, 0, 0\)$|^transparent$/.test(c);

/** `rgba(r, g, b, a) 0px 1px 3px 0px` and friends, outermost-first as CSS paints them. */
export function parseShadows(css: string): Effect[] {
  if (!css || css === 'none') return [];
  const out: Effect[] = [];
  // split on commas that are not inside rgb()/rgba()
  for (const part of css.split(/,(?![^(]*\))/)) {
    const s = part.trim();
    if (!s) continue;
    const color = /(rgba?\([^)]+\)|#[0-9a-f]{3,8})/i.exec(s)?.[1] ?? 'rgba(0,0,0,1)';
    const nums = (s.replace(color, '').match(/-?[\d.]+px/g) ?? []).map(num);
    const [x = 0, y = 0, blur = 0, spread = 0] = nums;
    out.push({ type: /inset/.test(s) ? 'INNER_SHADOW' : 'DROP_SHADOW', x, y, blur, spread, color });
  }
  return out;
}

/**
 * A stop that is literally `transparent` must keep its neighbour's hue, or the ramp runs
 * through transparent black and leaves a grey band. See docs/MAPPING.md.
 */
function parseStops(parts: string[]) {
  const stops = parts.map((p, i) => {
    const pos = /([\d.]+)%\s*$/.exec(p);
    const color = p.replace(/\s*[\d.]+%\s*$/, '').trim();
    return { pos: pos ? +pos[1] / 100 : i / Math.max(1, parts.length - 1), color };
  });
  stops.forEach((st, i) => {
    if (!/^transparent$/i.test(st.color)) return;
    const hue = stops[i - 1]?.color ?? stops[i + 1]?.color ?? 'rgb(0,0,0)';
    const rgb = /rgba?\(([^)]+)\)/.exec(hue);
    st.color = rgb ? `rgba(${rgb[1].split(',').slice(0, 3).join(',')}, 0)` : 'rgba(0,0,0,0)';
  });
  return stops;
}

/** `radial-gradient(circle at 30% 30%, #a, #b 70%)`. CSS defaults to farthest-corner. */
export function parseRadialGradient(css: string, w: number, h: number): Fill | null {
  const m = /^radial-gradient\((.*)\)$/s.exec(css.trim());
  if (!m) return null;
  const parts = m[1].split(/,(?![^(]*\))/).map(s => s.trim());
  let cx = 0.5, cy = 0.5, circle = false, size = 'farthest-corner';
  if (/^(circle|ellipse|closest|farthest|at |[\d.]+(px|%))/.test(parts[0])) {
    const head = parts.shift()!;
    circle = /\bcircle\b/.test(head);
    const sz = /(closest|farthest)-(side|corner)/.exec(head);
    if (sz) size = sz[0];
    const at = /at\s+([^,]+)$/.exec(head);
    if (at) {
      const [px_, py_] = at[1].trim().split(/\s+/);
      const rel = (v: string, ext: number) => /%$/.test(v) ? parseFloat(v) / 100
        : /^(left|top)$/.test(v) ? 0 : /^(right|bottom)$/.test(v) ? 1 : /^center$/.test(v) ? 0.5
        : parseFloat(v) / ext;
      cx = rel(px_, w); cy = rel(py_ ?? px_, h);
    }
  }
  // farthest-corner: the radius reaches the corner furthest from the centre
  const dx = Math.max(cx, 1 - cx) * w, dy = Math.max(cy, 1 - cy) * h;
  const near = /closest/.test(size);
  const [ex, ey] = near ? [Math.min(cx, 1 - cx) * w, Math.min(cy, 1 - cy) * h] : [dx, dy];
  const r = /corner/.test(size) ? Math.hypot(ex, ey) : Math.min(ex, ey);
  const rx = circle ? r / w : ex / w, ry = circle ? r / h : ey / h;
  return { type: 'GRADIENT_RADIAL', cx, cy, rx, ry, stops: parseStops(parts) };
}

/** `linear-gradient(135deg, #a 0%, #b 100%)` -> Figma-shaped stops. Anything else: null. */
export function parseLinearGradient(css: string): Fill | null {
  const m = /^linear-gradient\((.*)\)$/s.exec(css.trim());
  if (!m) return null;
  const parts = m[1].split(/,(?![^(]*\))/).map(s => s.trim());
  let angle = 180;                                    // CSS default is `to bottom`
  if (/^-?[\d.]+deg$/.test(parts[0])) angle = num(parts.shift()!);
  else if (/^to /.test(parts[0])) {
    const to = parts.shift()!;
    angle = /top/.test(to) ? (/left/.test(to) ? 315 : /right/.test(to) ? 45 : 0)
      : /bottom/.test(to) ? (/left/.test(to) ? 225 : /right/.test(to) ? 135 : 180)
      : /left/.test(to) ? 270 : 90;
  }
  return { type: 'GRADIENT_LINEAR', angle, stops: parseStops(parts) };
}

function fillsOf(n: ElementNode): Fill[] {
  const st = n.style, out: Fill[] = [];
  if (!transparent(st['background-color'])) out.push({ type: 'SOLID', color: st['background-color'] });
  const bg = st['background-image'];
  if (bg && bg !== 'none') {
    const g = parseLinearGradient(bg) ?? parseRadialGradient(bg, n.rect.w, n.rect.h);
    if (g) out.push(g);
    else if (/^url\(/.test(bg)) out.push({ type: 'IMAGE', src: bg.slice(5, -2), fit: 'cover' });
  }
  if (n.image) out.push({ type: 'IMAGE', src: n.image.src, fit: n.image.fit });
  return out;
}

function strokeOf(st: Style): Stroke | undefined {
  const w = (s: string) => (/^(none|hidden)$/.test(st[`border-${s}-style`]) ? 0 : num(st[`border-${s}-width`]));
  const [top, right, bottom, left] = ['top', 'right', 'bottom', 'left'].map(w);
  if (!(top || right || bottom || left)) return;
  return { top, right, bottom, left, color: st['border-top-color'] };
}

/**
 * Figma holds rotation on every node, so a pure rotate (optionally uniform-scaled) can
 * stay vector. A matrix that skews or scales non-uniformly cannot, and rasters.
 */
export function pureRotation(t: string): number | undefined {
  if (!t || t === 'none') return;
  const m = /^matrix\(([^)]+)\)$/.exec(t);
  if (!m) return;
  const [a, b, c, d] = m[1].split(',').map(Number);
  const sx = Math.hypot(a, b), sy = Math.hypot(c, d);
  if (Math.abs(sx - sy) > 1e-3) return;                      // non-uniform scale
  if (Math.abs(a / sx - d / sy) > 1e-3) return;              // skew
  return Math.atan2(b, a) * 180 / Math.PI;
}

function textOf(n: ElementNode): TextRun[] | undefined {
  if (!n.text) return;
  const st = n.style;
  return n.text.lines.map(l => ({
    ...l,
    family: st['font-family'], size: num(st['font-size']), weight: st['font-weight'],
    italic: st['font-style'] === 'italic', color: st.color,
    letterSpacing: st['letter-spacing'] === 'normal' ? 0 : num(st['letter-spacing']),
    decoration: st['text-decoration-line'],
  }));
}

export function plan(ir: StructureIR, tiles: Record<number, string>): CandidateIR {
  const nodes: CandidateNode[] = ir.nodes.filter(n => n.paints).map(n => {
    const st = n.style;
    const c: CandidateNode = {
      id: n.id, parent: n.parent, name: n.name, rect: n.rect,
      fills: fillsOf(n),
      stroke: strokeOf(st),
      radii: ['top-left', 'top-right', 'bottom-right', 'bottom-left']
        .map(k => num(st[`border-${k}-radius`])) as [number, number, number, number],
      effects: parseShadows(st['box-shadow']),
      opacity: num(st.opacity) || 1,
      clip: st['overflow-x'] !== 'visible' || st['overflow-y'] !== 'visible',
      text: textOf(n),
      rotation: pureRotation(st.transform),
      svg: n.svg,
      rung: 'vector',
    };
    // Things we know we cannot express, before the emulator even looks.
    const unsupported = st['background-image'] !== 'none' && !c.fills.some(f => f.type !== 'SOLID') ? 'background-image'
      : st.filter !== 'none' ? 'filter'
      : st['clip-path'] !== 'none' ? 'clip-path'
      : st.transform !== 'none' && c.rotation === undefined ? 'transform'
      : null;
    if (unsupported && tiles[n.id]) {
      // The tile already contains this element's own text -- leaving c.text set draws it
      // twice, which reads as a uniform few-ΔE haze rather than an obvious failure.
      c.rung = 'raster'; c.reason = unsupported; c.text = undefined;
      c.fills = [{ type: 'RASTER', tile: tiles[n.id] }];
    }
    return c;
  });
  const body = ir.nodes.find(n => n.tag === 'body');
  return { url: ir.url, size: ir.size, page: ir.page, background: body?.style['background-color'] ?? '#fff', nodes };
}
