/**
 * CandidateIR -> HTML, restricted to what Figma can express.
 *
 * This is deliberately NOT a CSS renderer. Every node is an absolutely positioned box
 * with fills, a stroke, per-corner radii, effects and opacity; text is one fixed-size
 * line per line box with no wrapping and no inheritance. If the IR is missing something
 * the page had, a renderer that can only speak Figma primitives cannot fake it -- which
 * is the only reason the comparison means anything.
 */
import type { CandidateIR, CandidateNode, Fill, Effect } from '../schema/candidate.js';

const px = (n: number) => `${+n.toFixed(2)}px`;

const stopList = (stops: { pos: number; color: string }[]) =>
  stops.map(s => `${s.color} ${(s.pos * 100).toFixed(2)}%`).join(', ');

function fillCss(f: Fill): string {
  switch (f.type) {
    case 'SOLID': return f.color;
    case 'GRADIENT_LINEAR':
      return `linear-gradient(${f.angle}deg, ${stopList(f.stops)})`;
    case 'GRADIENT_RADIAL':
      // Figma's radial is an ellipse in the node's box; express it the same way.
      return `radial-gradient(ellipse ${(f.rx * 100).toFixed(2)}% ${(f.ry * 100).toFixed(2)}%`
        + ` at ${(f.cx * 100).toFixed(2)}% ${(f.cy * 100).toFixed(2)}%, ${stopList(f.stops)})`;
    case 'GRADIENT_ANGULAR':
      return `conic-gradient(from ${f.from}deg at ${(f.cx * 100).toFixed(2)}% ${(f.cy * 100).toFixed(2)}%, ${stopList(f.stops)})`;
    // single quotes: these land inside a double-quoted style attribute
    case 'IMAGE': return `url('${f.src}')`;
    case 'RASTER': return `url('file://${f.tile}')`;   // f.tile must be absolute
  }
}

const effectCss = (e: Effect) =>
  `${e.type === 'INNER_SHADOW' ? 'inset ' : ''}${px(e.x)} ${px(e.y)} ${px(e.blur)} ${px(e.spread)} ${e.color}`;

function nodeHtml(n: CandidateNode): string {
  // A rotated element's captured rect is its *transformed* bounding box, so sizing a div
  // to it and rotating again would rotate twice. For a pure rotation the pre-rotation box
  // is recoverable: W = w|cos| + h|sin| and H = w|sin| + h|cos| solve for w and h.
  let { x, y, w, h } = n.rect;
  // A raster tile was captured from the transformed bounding box: it already contains the
  // rotation. Applying it again would rotate twice.
  const rotation = n.fills.some(f => f.type === 'RASTER') ? undefined : n.rotation;
  if (rotation) {
    const r = Math.abs(rotation) * Math.PI / 180;
    const c = Math.abs(Math.cos(r)), si = Math.abs(Math.sin(r)), det = c * c - si * si;
    if (Math.abs(det) > 0.02) {                       // near 45 degrees this is singular
      const w0 = (w * c - h * si) / det, h0 = (h * c - w * si) / det;
      if (w0 > 0 && h0 > 0) { x += (w - w0) / 2; y += (h - h0) / 2; w = w0; h = h0 }
    }
  }
  const s: string[] = [
    'position:absolute',
    `left:${px(x)}`, `top:${px(y)}`,
    `width:${px(w)}`, `height:${px(h)}`,
    `border-radius:${n.radii.map(px).join(' ')}`,
    'box-sizing:border-box',
  ];
  if (n.opacity !== 1) s.push(`opacity:${n.opacity}`);
  if (n.clip) s.push('overflow:hidden');
  // Figma holds rotation natively, so the emulator must too -- otherwise a node Figma
  // could place perfectly gets demoted to raster for no reason.
  if (rotation) s.push(`transform:rotate(${rotation}deg)`);

  // Figma paints fills bottom-first; CSS paints background layers top-first. Reverse.
  const layers = [...n.fills].reverse();
  const images = layers.filter(f => f.type !== 'SOLID').map(fillCss).filter(Boolean);
  const solid = layers.find(f => f.type === 'SOLID');
  if (images.length) {
    s.push(`background-image:${images.join(', ')}`);
    const raster = layers.find(f => f.type === 'RASTER');
    const fit = layers.find(f => f.type === 'IMAGE') as Extract<Fill, { type: 'IMAGE' }> | undefined;
    // A raster tile is this element's exact pixels at its exact size -- stretch, never crop.
    s.push(`background-size:${raster ? '100% 100%' : fit?.fit === 'contain' ? 'contain' : fit ? 'cover' : '100% 100%'}`);
    s.push('background-position:center', 'background-repeat:no-repeat');
  }
  if (solid) s.push(`background-color:${fillCss(solid)}`);

  if (n.stroke) {
    const b = n.stroke;
    s.push(`border-style:solid`, `border-color:${b.color}`,
      `border-width:${[b.top, b.right, b.bottom, b.left].map(px).join(' ')}`);
  }
  if (n.effects.length) s.push(`box-shadow:${n.effects.map(effectCss).join(', ')}`);

  // An <svg> is a leaf with its own paint; Figma has createNodeFromSvg, so it stays vector.
  const inner = n.svg ?? '';
  const box = `<div style="${s.join(';')}">${inner}</div>`;
  if (!n.text?.length) return box;

  // One absolutely positioned, non-wrapping line per line box, positioned in page space.
  const lines = n.text.map(t => {
    const ls: string[] = [
      'position:absolute', 'white-space:pre', 'margin:0',
      `left:${px(t.rect.x)}`, `top:${px(t.rect.y)}`,
      `height:${px(t.rect.h)}`, `line-height:${px(t.rect.h)}`,
      `font-family:${t.family}`, `font-size:${px(t.size)}`, `font-weight:${t.weight}`,
      `color:${t.color}`,
    ];
    if (t.italic) ls.push('font-style:italic');
    if (t.letterSpacing) ls.push(`letter-spacing:${px(t.letterSpacing)}`);
    if (t.decoration && t.decoration !== 'none') ls.push(`text-decoration-line:${t.decoration}`);
    return `<span style="${ls.join(';')}">${escape(t.text)}</span>`;
  }).join('');
  return box + lines;
}

const escape = (s: string) => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!));

export function render(ir: CandidateIR): string {
  // Paint order is document order, which is what the capture recorded.
  const body = ir.nodes.map(nodeHtml).join('\n');
  return `<!doctype html><meta charset="utf-8">
<style>
  html,body{margin:0;padding:0}
  body{width:${px(ir.page.w)};height:${px(ir.page.h)};background:${ir.background};position:relative}
  *{box-sizing:border-box}
</style>
${body}`;
}
