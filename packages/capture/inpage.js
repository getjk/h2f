// Runs inside the page. Returns StructureIR minus the bits only the driver knows.
// Everything here reads what Chrome already resolved -- no CSS reimplementation.
(() => {
const BOX = ['background-color','background-image','background-size','background-position','background-repeat','border-top-width','border-right-width','border-bottom-width','border-left-width','border-top-style','border-right-style','border-bottom-style','border-left-style','border-top-color','border-right-color','border-bottom-color','border-left-color','border-top-left-radius','border-top-right-radius','border-bottom-right-radius','border-bottom-left-radius','box-shadow','opacity','mix-blend-mode','filter','backdrop-filter','overflow-x','overflow-y','clip-path','transform','position','display','z-index'];
const TEXT = ['color','font-family','font-size','font-weight','font-style','line-height','letter-spacing','text-align','text-decoration-line','text-decoration-color','text-transform','white-space','text-shadow','-webkit-background-clip'];
const LAYOUT = ['flex-direction','flex-wrap','justify-content','align-items','gap','row-gap','column-gap','padding-top','padding-right','padding-bottom','padding-left','grid-template-columns','grid-template-rows'];
const PROPS = [...BOX, ...TEXT, ...LAYOUT];

const sx = () => window.scrollX, sy = () => window.scrollY;
const toPage = r => ({ x: +(r.left + sx()).toFixed(2), y: +(r.top + sy()).toFixed(2), w: +r.width.toFixed(2), h: +r.height.toFixed(2) });

// --- design tokens: every custom property declared anywhere, resolved on :root ---
function tokens() {
  const names = new Set(), out = {};
  for (const sheet of document.styleSheets) {
    let rules; try { rules = sheet.cssRules } catch { continue }          // cross-origin
    const walk = rs => { for (const r of rs) { if (r.style) for (const p of r.style) p.startsWith('--') && names.add(p); if (r.cssRules) walk(r.cssRules) } };
    walk(rules || []);
  }
  const root = getComputedStyle(document.documentElement);
  for (const n of names) { const v = root.getPropertyValue(n).trim(); if (v) out[n] = v }
  return out;
}

// --- cascade: which declarations actually used a var(), per element ---
// One querySelectorAll per rule, not one rule-scan per element, so this stays cheap.
function varBindings() {
  // Chrome expands shorthands in the CSSOM and drops the var() from the longhands,
  // so read the authored declaration text instead.
  const DECL = /([-\w]+)\s*:\s*([^;{}]*var\(\s*(--[\w-]+)[^;{}]*)/g;
  const parse = text => { const out = {}; let m; DECL.lastIndex = 0; while ((m = DECL.exec(text))) out[m[1]] = m[3]; return out };

  const map = new Map();
  const rules = [];
  for (const sheet of document.styleSheets) {
    let rs; try { rs = sheet.cssRules } catch { continue }
    (function walk(list) { for (const r of list) { if (r.selectorText && r.style) rules.push(r); if (r.cssRules) walk(r.cssRules) } })(rs || []);
  }
  const add = (el, uses) => { if (Object.keys(uses).length) map.set(el, Object.assign(map.get(el) || {}, uses)) };
  for (const r of rules) {                                        // source order approximates the cascade
    const uses = parse(r.cssText.slice(r.cssText.indexOf('{')));
    if (!Object.keys(uses).length) continue;
    let els; try { els = document.querySelectorAll(r.selectorText) } catch { continue }
    for (const el of els) add(el, uses);
  }
  for (const el of document.querySelectorAll('[style]')) add(el, parse(el.getAttribute('style')));
  return map;
}

// shorthands expand: `border-radius: var(--radius)` should bind all four corners
const EXPAND = {
  'border-radius': ['border-top-left-radius','border-top-right-radius','border-bottom-right-radius','border-bottom-left-radius'],
  'padding': ['padding-top','padding-right','padding-bottom','padding-left'],
  'background': ['background-color','background-image'],
  'border-color': ['border-top-color','border-right-color','border-bottom-color','border-left-color'],
  'border-width': ['border-top-width','border-right-width','border-bottom-width','border-left-width'],
  'gap': ['row-gap','column-gap'],
  'font': ['font-size','font-family','font-weight','line-height'],
};

// --- text: one entry per rendered line box, with the exact substring ---
function lines(el) {
  const out = [];
  for (const node of el.childNodes) {
    if (node.nodeType !== 3 || !node.data.trim()) continue;
    const r = document.createRange(); r.selectNodeContents(node);
    const boxes = [...r.getClientRects()].filter(b => b.width > 0 && b.height > 0);
    if (!boxes.length) continue;
    const n = node.data.length;
    const topOf = o => { const q = document.createRange(); q.setStart(node, o); q.setEnd(node, Math.min(o + 1, n)); const b = q.getClientRects()[0]; return b ? b.top : Infinity };
    // line tops are monotonic, so each line's start offset is a binary search
    let start = 0;
    boxes.forEach((b, i) => {
      let end = n;
      const next = boxes[i + 1];
      if (next) { let lo = start, hi = n; while (lo < hi) { const m = (lo + hi) >> 1; topOf(m) >= next.top - 0.5 ? hi = m : lo = m + 1 } end = lo }
      const text = node.data.slice(start, end);
      if (text.trim()) out.push({ text, rect: toPage(b), baseline: +(b.bottom + sy()).toFixed(2) });
      start = end;
    });
  }
  return out;
}

// --- naming: what a designer would call this layer ---
const SEMANTIC = { header:'Header', nav:'Nav', main:'Main', footer:'Footer', aside:'Aside', section:'Section', article:'Article', form:'Form', button:'Button', a:'Link', ul:'List', ol:'List', li:'Item', table:'Table', img:'Image', svg:'Icon', input:'Input', label:'Label' };
function nameOf(el, cs) {
  const t = el.tagName.toLowerCase();
  if (/^h[1-6]$/.test(t)) return (el.textContent || '').trim().slice(0, 40) || t.toUpperCase();
  const cls = [...el.classList].find(c => /^[a-z][a-z0-9_-]{1,30}$/i.test(c) && !/^(is|has|js)-/.test(c));
  const aria = el.getAttribute('aria-label');
  return aria?.slice(0, 40) || SEMANTIC[t] || cls || (cs.display?.startsWith('flex') ? 'Row' : 'Frame');
}

// structural fingerprint -- same shape = candidate component
const hashOf = el => el.tagName.toLowerCase() + '.' + [...el.classList].slice(0, 4).sort().join('.') + '>' + [...el.children].map(c => c.tagName.toLowerCase()).join(',');

// can this element be pixel-isolated by hiding everything else?
function isolationBlocker(el, cs) {
  if (cs['mix-blend-mode'] !== 'normal') return 'mix-blend-mode';
  if (cs['backdrop-filter'] !== 'none') return 'backdrop-filter';
  for (let p = el.parentElement; p; p = p.parentElement) {
    const pc = getComputedStyle(p);
    if (pc['mix-blend-mode'] !== 'normal') return 'ancestor blend';
    if (pc.opacity !== '1') return 'ancestor opacity';
  }
  return null;
}

const SKIP = new Set(['SCRIPT','STYLE','META','LINK','TITLE','HEAD','NOSCRIPT','TEMPLATE','BR']);

window.__h2f = () => {
  const toks = tokens(), bindings = varBindings();
  const nodes = [], fonts = [], els = [];
  let paint = 0;

  (function walk(el, parent) {
    if (SKIP.has(el.tagName)) return;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return;
    const rect = toPage(el.getBoundingClientRect());
    const id = nodes.length;

    const style = {}; for (const p of PROPS) style[p] = cs.getPropertyValue(p);
    const vars = {}; const bound = bindings.get(el);
    if (bound) for (const [p, t] of Object.entries(bound)) for (const q of (EXPAND[p] || [p])) if (style[q] && !/^(none|rgba\(0, 0, 0, 0\)|0px)$/.test(style[q])) vars[q] = t;

    const n = { id, parent, tag: el.tagName.toLowerCase(), name: nameOf(el, cs), rect, style, vars, paintOrder: paint++, hash: hashOf(el) };
    const blocker = isolationBlocker(el, cs); if (blocker) n.noIsolate = blocker;

    const ls = lines(el);
    if (ls.length) n.text = { content: ls.map(l => l.text).join(''), lines: ls };

    if (el.tagName === 'IMG' || el.tagName === 'VIDEO') {
      // a video with no decoded frames has nothing to show but its poster
      const src = (el.tagName === 'VIDEO' && !el.videoWidth ? el.poster : '') || el.currentSrc || el.src || el.poster || '';
      if (src) n.image = { src, natural: { w: el.naturalWidth || el.videoWidth || 0, h: el.naturalHeight || el.videoHeight || 0 }, fit: cs['object-fit'], position: cs['object-position'] };
    }
    if (el.tagName === 'CANVAS') { try { n.image = { src: el.toDataURL(), natural: { w: el.width, h: el.height }, fit: 'fill', position: '50% 50%' } } catch {} }
    if (el.tagName === 'SVG' || el.tagName.toLowerCase() === 'svg') { n.svg = el.outerHTML; nodes.push(n); els[id] = el; return }  // don't descend into svg internals

    nodes.push(n); els[id] = el;
    for (const c of el.children) walk(c, id);
  })(document.documentElement, null);

  window.__h2fEls = els;
  for (const f of document.fonts) fonts.push({ family: f.family, weight: f.weight, style: f.style, src: null });

  return {
    url: location.href, title: document.title,
    page: { w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight },
    nodes, fonts, tokens: toks,
  };
};
})();
