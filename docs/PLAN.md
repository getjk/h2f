# Plan

One page. What we are building, in what order, and what each stage has to prove before
the next one starts. `docs/BRIEF.md` has the reasoning; `docs/DECISIONS.md` has the
decisions that supersede parts of it; this file is the schedule.

## The idea in four sentences

Ask Chrome what each element alone looks like — hide the page, show one element,
screenshot its box on transparency — and treat those tiles as ground truth. Propose the
most *editable* Figma construct for every element, then step down a ladder of less
editable options only when the comparison against that element's tile fails. Do the
comparing where compute is cheap (a server with real Chrome), not inside Figma's plugin
sandbox. The result: nothing is emitted that has not been checked against Chrome's own
pixels, with a raster floor underneath so the worst case is accurate-but-less-editable
rather than wrong.

## Success

On a fixed corpus, at each captured size:

- **Fidelity** ≥ html.to.design on every page, measured as ΔE2000 mean + p95 + SSIM
  against Chrome's screenshot. Zero dropped content.
- **Editability**, measured as the share of elements sitting on the top rung of their
  ladder, rises monotonically across stages without fidelity falling.

Both numbers appear in every PR. Fidelity may not drop on any page. Editability may not
drop without a written reason.

---

## Stage 0 — Capture and oracle ✅ done

Chrome via CDP at three sizes (L 1440×900@2, M 834×1194@2, S 393×852@3). Produces
`StructureIR` (geometry, per-line text boxes, cascade-derived variable bindings, layer
names, structural hashes, `paints()`), oracle tiles, and assets. Preparation dismisses
interstitials, drives lazy loading, settles animations, freezes media — and reports what
it clicked and what is still in the way.

*Gate — met on fixtures:* recomposition of the tiles reproduces the page. basic 0.015,
adversarial 0.144, hazards 0.003.

**Open:** Nike and Airbnb unvalidated. IKEA passes at 0.948 — an order of magnitude worse
than the fixtures, so read its heat map before calling it good. This runs on real
hardware, not in a cloud sandbox.

## Stage 1 — The emulator ⬅ current

The offline verification loop, with no Figma involved.

- `packages/plan` — `StructureIR → CandidateIR`. Assign every element the *top* rung of
  its ladder. Pure function, no I/O.
- `packages/emulator` — `CandidateIR → HTML`, constrained to emit **only what Figma can
  express**: solid and gradient fills, per-side strokes, the effect list, per-corner
  radii, absolutely positioned text runs, image fills. Not a CSS passthrough. That
  constraint is what makes the check honest — if the IR is missing something the page
  had, a renderer that can only speak Figma primitives cannot fake it.
- `bin/fit.ts` — capture → plan → emulate → screenshot → diff each element against its
  oracle tile → demote failures a rung → repeat → report.

*Gate:* every corpus page produces a resolved plan where each node has a rung, a score
and a reason; fidelity of the emulated render ≥ the raster floor; the per-rung
distribution is reported.

## Stage 2 — The plugin

A pure applier. It receives a resolved plan and builds it.

- `createNodeFromJSXAsync` for subtrees, benchmarked against an imperative loop — the
  highest-value unknown in the project, since nobody publishes numbers. Measure in a
  **released** build, not dev.
- Distinct `{family, style}` set collected and `Promise.all`-loaded up front.
- Images pre-transcoded and tiled server-side; `fetch().arrayBuffer()` on the main thread.
- Chunk and yield, visible progress, cancellable, append to the page once at the end.
- QA mode: sample N nodes, `exportAsync`, diff, report. Not on every import.
- UI in Base UI components.

*Gate:* all corpus pages import with zero dropped content; QA sample agrees with the
offline prediction within tolerance; import time and node counts recorded per page.

## Stage 3 — Calibration

Fit the Chrome→Figma transfer functions instead of guessing constants. Generated
one-property snippets, rendered by both engines, parameters swept, curves fitted, stored
in `packages/calibration/*.json` with residuals. First targets from `docs/MAPPING.md`:
shadow blur (CSS blur is a Gaussian at half the radius; Figma's kernel is undocumented),
spread on rounded corners, radial `farthest-corner` sizing, letter-spacing and
line-height rounding, stroke alignment.

Snippet generation and sweeps are bulk per-item work — cheapest capable model.

*Gate:* each fitted property's residual under 1% ΔE; the corpus score improves or holds.

## Stage 4 — Server and extension

- Server: `POST /captures`, `POST /captures/:id/plan`, `GET /captures/:id/bundle`,
  `GET /captures/:id/tile/:node`. Image transcoding, font fetching, headless capture.
- Extension: MV3 wrapper running the same `prepare.js` and `inpage.js` via
  `chrome.debugger`, for pages behind a login.

*Gate:* five authenticated corpus pages import at parity with public ones.

## Stage 5 — Editability climb

With the loop proven, raise the ceiling: auto layout inference (only where re-laid-out
rects match to ≤0.5px), components from repeated structural hashes with overrides,
variants across sizes, variable binding, text styles.

*Gate:* editability index rises; fidelity holds; every construct verified, none assumed.

---

## Working agreements

- Every PR shows the corpus table before and after.
- Never special-case a URL. Fix the rule, add the case to `adversarial.html` or
  `hazards.html`.
- The fewest lines that read clearly. No abstraction for a second use that does not exist.
- Bulk per-item work goes to the cheapest capable model; briefs, plans and QA do not.
- Tool UIs use Base UI.
- Boundaries (`packages/schema`), the planner, the metric, and any change to the
  raster-vs-vector decision rule get reviewed properly.

## Corpus

IKEA, Nike, Airbnb first — chosen for consent bars, region interstitials, lazy grids,
carousels, video heroes and map canvases. Plus three local fixtures: `basic` (text
wrapping, tokens, flex), `adversarial` (gradients, clip-path, WebP/AVIF, SVG, transforms,
columns), `hazards` (consent + modal, infinite scroll, reveals, lazy images, video,
sticky header). Extend toward twenty; add every bug as a fixture case.
