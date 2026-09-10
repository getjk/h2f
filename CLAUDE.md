# h2f — context for an agent working in this repo

## What this is

HTML → Figma, but graded rather than hoped for. The premise: ask Chrome what each
element alone looks like (hide the page, show one element, screenshot its box on
transparency), and grade everything built later against those tiles, element by
element. Compositing all tiles in paint order reproduces the page — that recomposition
is the self-test, and it is how every bug so far was found.

Read in this order: `docs/BRIEF.md` for why the project is shaped this way (the
editability ladder, the oracle, what was rejected and why), `docs/DECISIONS.md` for the
decisions that supersede parts of it — **D1 moves the ladder's fitting out of the plugin
and is the most important thing in the repo** — `docs/ARCHITECTURE.md` for how the
extension/server/plugin fit together and the revised milestones, `README.md` for what
exists today, `TESTING.md` for how to run it.

## The rule

Every change shows the corpus table before and after:

```
npm run gate -- L,M,S            # whole corpus
npm run gate -- L ikea           # one page
npm run verify -- out/gate/ikea/L   # diagnose + write compare.png
```

Fidelity may not drop on any page. Never "fix" a page by special-casing its URL —
fix the rule and add the case to `packages/harness/fixtures/adversarial.html` or
`hazards.html`. Fixture baselines: basic 0.015, adversarial 0.14, hazards 0.003.

## Where things are

```
packages/schema/ir.ts        StructureIR + Oracle. The only vocabulary between stages.
packages/capture/inpage.js   Runs in the page: geometry, per-line text boxes, cascade
                             variable bindings, layer names, structural hashes, paints().
packages/capture/prepare.js  Runs before collection: dismiss interstitials, lazy load,
                             settle animations, freeze media.
packages/capture/capture.ts  Driver: device presets, oracle capture, batch packing.
packages/harness/metric.ts   CIEDE2000 + SSIM + heat grid.
bin/{capture,verify,gate}.ts CLI.
```

## Knobs

`H2F_BUDGET_MS` scroll pass budget (25s) · `H2F_MAX_HEIGHT` how far down (30000px) ·
`H2F_MAX_TILES` oracle tile cap (2000) · `H2F_TIMEOUT_MS` per-page wall clock (240s) ·
`H2F_TLS12` cap TLS at 1.2, only for proxies that reset TLS 1.3 · `CHROMIUM` override ·
`H2F_PROGRESS` force the tile progress line.

## Hard-won facts — do not rediscover these

1. The root background propagates to the viewport canvas and paints under every tile
   regardless of `visibility`. It is cleared unless it is the target.
2. `captureBeyondViewport` temporarily changes device metrics, re-laying-out the page.
   Screenshots scroll and stitch, clipped to the visible viewport, so metrics never move.
3. `captureScreenshot` without a `clip` ignores the device scale factor.
4. A page with no viewport meta gets Chrome's 980px fallback plus page scale, putting
   layout, scroll and screenshot coordinates in three different spaces. Mobile presets
   lay out at device width and report `injectedViewportMeta`.
5. Sticky/fixed elements ride the viewport and would appear once per stitched strip.
   They are captured in the first strip and hidden after.
6. Chrome expands shorthands in the CSSOM and drops the `var()` from the longhands, so
   variable bindings are parsed from the authored declaration text.
7. Do NOT force every image `loading=eager`: on a big catalogue page that decodes
   hundreds of images at once and kills the renderer. Scrolling loads them naturally.
8. Only elements that actually paint need an oracle tile (`paints()`). Most DOM nodes
   are layout wrappers and are the majority of nodes on a real site.
9. A tile extract must be the *intersection* of the wanted rect and the screenshot, with
   the paste offset shifted by the same delta. Clamping the origin while keeping the full
   width silently corrupts every tile that straddles a strip boundary.
10. Horizontal scroll is never captured: only vertical strips are taken, so anything
   right of the layout viewport has no pixels behind it. Those nodes are counted in
   `oracle.offscreenX`, and the reference is clipped to the layout viewport rather than
   the full `scrollWidth` — otherwise the metric diffs against empty space.
11. A blocker is something that visually covers the page, so `blockers()` tests whether
   it paints, not whether it takes clicks: an invisible `pointer-events:none` wrapper is
   not a blocker, but a translucent scrim with `pointer-events:none` still is.

## Status

M0 is done and validated on fixtures at all three sizes. IKEA now passes on real hardware
(meanΔE 0.948, 0 blockers, 4 consent banners dismissed). **Nike and Airbnb are still
unvalidated** — Nike previously hung in the tile loop, which `paints()`, the tile cap
and the wall clock should have addressed. That is the immediate job:

```
npm run gate -- L nike && npm run gate -- L airbnb
```

IKEA's 0.948 is worth a second look too: it is an order of magnitude worse than the
fixtures, and the horizontal-overflow handling above may account for part of it. Run
`npm run verify -- out/gate/ikea/L` and read the heat map before assuming it is fine.

Then M1: the editability ladder's top rungs (reflowing paragraph text, parametric
boxes) verified per element against the oracle tiles, and the Figma plugin that runs
the verification loop — only the plugin can `exportAsync`.

## House style

The fewest lines that read clearly. No abstraction for a second use that does not
exist yet. Tool UIs use Base UI components. Bulk per-item work (calibration sweeps,
one-property snippets) goes to the cheapest capable model; briefs, plans and QA do not.
