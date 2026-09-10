# Testing h2f on real sites

## Setup (once, ~2 min)

```
tar xzf h2f.tar.gz && cd h2f
npm install
npm run setup            # downloads the Chromium Playwright drives
```

Needs Node 22+ (`node -v`). Nothing else — no API keys, no Figma yet.

## Sanity check (30 s)

```
npm run gate -- L basic,adversarial,hazards
```

Expect a table with meanΔE around 0.015 / 0.14 / 0.06 and `blockers` at 0.
If those numbers come out, the machine is fine and anything that follows is
about the real sites, not the setup.

## The actual test

```
npm run gate -- L ikea,nike,airbnb
```

Then the same at the other two sizes when you have time:

```
npm run gate -- M,S ikea,nike,airbnb
```

Each run prints one row per page/size:

```
| page | size | nodes | tiles | meanΔE | p95ΔE | SSIM | dismissed | blockers | s |
```

- **meanΔE** under ~0.5 is good, under 1.0 is invisible to the eye, above 2 means
  something is genuinely wrong.
- **dismissed** counts the banners and modals that got clicked away.
- **blockers** must be 0. Anything above 0 means something is still covering the
  page and the capture is of a page you would not recognise.

## What to send me

Paste the table. Then, for any row where meanΔE is above ~1 or blockers is above 0:

```
npm run verify -- out/gate/nike/L
```

That prints the diagnosis and writes `out/gate/nike/L/compare.png` — Chrome on the
left, the rebuild on the right. **That image plus the printed lines is all I need.**
Where the two differ tells me which stage is wrong without you doing any analysis.

If a page fails outright the row shows the error instead of numbers; send that line.

## Likely trouble, so it isn't a surprise

- **Nike** shows a region/country interstitial that may not carry a recognisable
  accept control. If `blockers` is 1 on Nike, that is the expected failure and I
  need the `compare.png` to see what the overlay is.
- **Airbnb** has a map canvas. Canvas is captured as pixels by design, so it should
  score fine but appear in the report as raster — that is correct, not a bug.
- **IKEA** has carousels and video heroes. Carousels are captured at whichever slide
  is showing; if the score is bad there, it is probably the video.
- A page that never stops appending on scroll will stop after 60 passes by design.
  If IKEA takes minutes, tell me and I will cap it by height instead.

Rerunning is free — captures go to `out/gate/<page>/<size>/` and are overwritten.

---

## Why URL loads fail in Claude's sandbox (and not on your Mac)

Not a policy block and not a certificate problem. This session's egress relay resets
Chromium's **TLS 1.3** handshake — curl and Node succeed through the same proxy
because their ClientHello is different. Capping the browser at TLS 1.2 fixes it:

```
H2F_TLS12=1 npm run gate -- L ikea
```

That flag still verifies certificates and does not change how a page renders; it only
negotiates a lower protocol version. **You should never need it on your Mac** — leave
it off unless you are behind a corporate TLS-terminating proxy that does the same
thing. It is opt-in for exactly that reason.

## Diagnosing a slow or hanging capture

Real sites are much bigger than the fixtures, and two knobs control how long a capture
is allowed to take:

```
H2F_BUDGET_MS=20000   # how long the scroll/lazy-load pass may run (default 25s)
H2F_MAX_HEIGHT=20000  # how far down the page to go (default 30000 CSS px)
```

An infinite feed never stops growing, so the pass stops on whichever budget it hits
first and records `prepared.truncated` as `"time"` or `"height"` — a truncated capture
is reported, never silently shortened.

If a capture still takes minutes on a big site, the interesting number is how long
each phase took. Send me the site and roughly where it stalled (page load, the
scroll pass, or collection) and I will instrument that phase.
