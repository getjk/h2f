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

## Per-node scores are a tail, not a mean

`ownScores` reports the **95th percentile** of per-pixel ΔE over a node's own pixels, not
the mean. Text rendered in the wrong place has the right ink in the wrong pixels: its mean
barely moves while its worst pixels move a lot. Under a mean, the columns card in
`adversarial.html` — visibly reflowed into one wide block instead of two columns — scored
3.6, indistinguishable from correct antialiased text, and was promoted back to vector. On
the tail it scores 21.7 and is demoted correctly.

## Demote only when demoting helps

A node is stepped down only if the raster version actually scores meaningfully better
(`H2F_MIN_GAIN`). A text-dense node sits above a flat one purely from antialiasing, and so
does its tile — demoting it there buys nothing and costs an editable layer.

## Two thresholds, on purpose

`H2F_RUNG_THRESHOLD` (8) demotes a vector node. `H2F_BROKEN_TILE` (30) is the alarm that a
*tile itself* is wrong. They are far apart on purpose: correct antialiased text reaches ~7,
visibly wrong text reflow ~22, and a genuinely blank tile 38+. One threshold for both hides
real breakage behind a crowd of false alarms.

Rung decisions are made on a slightly blurred diff, since glyph antialiasing separates
text-dense regions from flat ones while looking identical. Fidelity — the number we are
judged on — stays the raw diff.

## Known gaps in the fit loop (M1)

- Per-node scores come from the page diff rather than isolated renders, so paint that
  lands outside a node's rect (shadows, transforms) is attributed to whatever it overlaps.
  The symmetric fix is to capture emulated tiles with the same isolation and packing the
  oracle uses, and compare tile to tile.
- Rotation: a rotated element's captured rect is its *transformed* bounding box, so the
  emulator recovers the pre-rotation box (`W = w|cos| + h|sin|`, `H = w|sin| + h|cos|`)
  before rotating. Near 45° that system is singular and the node rasters. A raster tile is
  never rotated — it already contains the rotation.
- Still unexpressed: `clip-path` (Figma has vector paths and could hold it),
  `repeating-*` gradients, colour hints, and CSS columns (line rects are captured but the
  emulator lays them out wrong).
- **Wherever the emulator's vocabulary is narrower than Figma's, we silently lose
  editability we could have had.** Keep the two in step — that is what this branch was.

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
