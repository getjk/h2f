// Runs in the page before collection: dismiss interstitials, force lazy content in,
// settle animations, and freeze media. Everything here is deliberately conservative --
// a wrong click changes the page we are supposed to be copying.
(() => {

// --- consent and popup dismissal -------------------------------------------------
const ACCEPT = /^(accept|accept all|allow all|agree|i agree|got it|ok|okay|continue|understood|allow cookies|accept cookies|yes, i agree)$/i;
const CLOSE = /^(close|dismiss|no thanks|not now|maybe later|skip|×|✕|✖|x)$/i;
const ATTR = '[id*=cookie i],[class*=cookie i],[id*=consent i],[class*=consent i],[id*=gdpr i],[class*=gdpr i],[data-testid*=cookie i],[aria-label*=cookie i]';

const visible = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden' };
const label = el => (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 40);

function clickables(root) {
  return [...root.querySelectorAll('button,[role=button],a[href="#"],input[type=button],input[type=submit]')].filter(visible);
}

/** Click the accept/close control inside consent-ish containers, then anywhere. */
function dismiss() {
  const clicked = [];
  const tryClick = (el, why) => { try { el.click(); clicked.push(why + ': ' + label(el)) } catch {} };

  for (const box of document.querySelectorAll(ATTR)) {
    const btn = clickables(box).find(b => ACCEPT.test(label(b))) ?? clickables(box).find(b => CLOSE.test(label(b)));
    if (btn) tryClick(btn, 'consent');
  }
  // shadow-DOM consent widgets (OneTrust, Usercentrics and friends)
  for (const host of document.querySelectorAll('*')) {
    if (!host.shadowRoot) continue;
    const btn = clickables(host.shadowRoot).find(b => ACCEPT.test(label(b)));
    if (btn) tryClick(btn, 'shadow');
  }
  // a dialog left standing: press its close control, then Escape
  for (const d of document.querySelectorAll('[role=dialog],[aria-modal=true],dialog[open]')) {
    if (!visible(d)) continue;
    const btn = clickables(d).find(b => CLOSE.test(label(b)) || /close/i.test(b.className));
    if (btn) tryClick(btn, 'dialog');
  }
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
  return clicked;
}

/** Anything still covering most of the viewport after dismissal is a blocker we report. */
function blockers() {
  const vw = innerWidth, vh = innerHeight, out = [];
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el);
    if (cs.position !== 'fixed' || cs.visibility === 'hidden' || cs.display === 'none' || +cs.opacity < 0.05) continue;
    const r = el.getBoundingClientRect();
    if (r.width * r.height > vw * vh * 0.45 && r.top < vh * 0.5) out.push({ tag: el.tagName.toLowerCase(), cls: el.className?.toString().slice(0, 60), area: Math.round(r.width * r.height / (vw * vh) * 100) });
  }
  return out;
}

// --- lazy content ----------------------------------------------------------------
async function loadEverything(step = 400, pause = 90) {
  for (const img of document.images) { img.loading = 'eager'; img.decoding = 'sync'; }
  for (const f of document.querySelectorAll('iframe[loading]')) f.loading = 'eager';

  let last = -1, guard = 0;
  while (guard++ < 60) {                                   // pages that grow as you scroll
    const H = document.documentElement.scrollHeight;
    for (let y = Math.max(0, last); y < H; y += step) { scrollTo(0, y); await sleep(pause) }
    if (document.documentElement.scrollHeight === H) break;
    last = H - step;
  }
  scrollTo(0, 0);
  await sleep(200);
  await document.fonts?.ready;
  await Promise.all([...document.images].map(i => i.decode?.().catch(() => {})));
}

// --- animation and media -----------------------------------------------------------
function settleAnimations() {
  for (const a of document.getAnimations?.() ?? []) {
    try {
      const inf = a.effect?.getComputedTiming?.().iterations === Infinity;
      inf ? (a.currentTime = 0, a.pause()) : a.finish();   // reveals land revealed; loops land at frame 0
    } catch {}
  }
}

function freezeMedia() {
  const out = [];
  for (const v of document.querySelectorAll('video')) {
    try {
      v.pause(); v.autoplay = false; v.loop = false;
      if (!v.poster && v.readyState >= 2 && v.currentTime < 0.1) v.currentTime = Math.min(0.1, (v.duration || 1) / 10);
      out.push({ src: v.currentSrc || v.src || '', poster: v.poster || '', w: v.videoWidth, h: v.videoHeight });
    } catch {}
  }
  return out;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Last resort: something is still covering the page, so look for its close control. */
function dismissBlockers() {
  const clicked = [];
  for (const b of blockers()) {
    const el = [...document.querySelectorAll('body *')].find(e => e.tagName.toLowerCase() === b.tag && e.className?.toString().slice(0, 60) === b.cls && getComputedStyle(e).position === 'fixed');
    if (!el) continue;
    const btn = clickables(el).find(x => CLOSE.test(label(x)) || /close|dismiss/i.test(x.className + ' ' + (x.getAttribute('aria-label') || '')));
    if (btn) { try { btn.click(); clicked.push('overlay: ' + (label(btn) || btn.className)) } catch {} }
  }
  return clicked;
}

window.__h2fPrepare = async () => {
  const dismissed = dismiss();
  await sleep(400);
  const again = [...dismiss(), ...dismissBlockers()];      // some banners appear only after the first is gone
  await loadEverything();
  settleAnimations();
  const videos = freezeMedia();
  await sleep(150);
  return { dismissed: [...dismissed, ...again], blockers: blockers(), videos };
};
})();
