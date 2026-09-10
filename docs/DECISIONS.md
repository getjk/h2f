# Decisions

## D1 — The fitting happens outside Figma. The plugin applies.

**Decided.** Researched Sep 2026.

The v4 brief put the editability ladder's descent inside the plugin: build a node the
most editable way, `exportAsync` it, diff against the oracle tile, step down on a miss.
That is the right *idea* and the wrong *venue*, for a reason that is a property of the
runtime rather than a matter of taste.

Plugin code runs on the main thread in a QuickJS-derived sandbox compiled to WASM inside
V8 — not a worker, not native JS. One measured community report puts pure computation in
the sandbox at **~150x slower** than the same code in dev tooling (16ms → 2,463ms for a
byte-array hash loop). Every property setter is a bridge crossing, not an assignment.
There is no watchdog: a plugin that blocks simply freezes the editor.

So a per-node diff loop inside the plugin has only two implementations, and both are bad.
Compute the diff in the sandbox and pay 150x on exactly the pixel math that is the
heaviest part of the job. Or ship pixels to the UI iframe to diff in real V8 — and large
payloads across that boundary are the *documented* cause of plugin freezes, with Figma's
own support advice being to batch smaller rather than send at once.

**Therefore:**

- **Offline (server, real V8, real Chrome): all fitting.** Capture → IR → rung decisions.
  Verification is the round-trip check: render the CandidateIR back to HTML constrained to
  *only what Figma can express*, screenshot it in Chrome, diff against the oracle tiles.
  This catches "did we read the page correctly", which is the overwhelming majority of
  error, and it runs at corpus scale in CI with no Figma involved.
- **Calibration covers the rest.** The Chrome-to-Figma delta per property (shadow blur vs
  effect radius, letter-spacing rounding, gradient handle geometry, stroke alignment) is
  fitted once, offline, and consumed by the planner. Bulk snippet generation and sweeps
  are cheap-agent work.
- **The plugin becomes an applier.** No diffing on a normal import.
- **Verification becomes a QA mode, not a runtime loop.** A "verify this import" command
  exports a *sample*, diffs it, and reports — used to build calibration tables and catch
  regressions in CI, not run on every user's import.

This is the compiler relationship: you validate the optimizer once, you do not re-verify
every user's build.

**Known weak point.** A browser emulator predicts Figma's *text* worst of anything —
shaping, kerning and substituted-font metrics genuinely differ. So the scoping rule is:
boxes, fills, strokes, effects and images verify in the emulator; **text keeps real Figma
verification**. That is also where the editability payoff is highest, so it is where the
extra certainty is worth paying for.

**The trap this avoids.** Diffing our IR against our own renderer would verify nothing —
that is v1's failure moved to a new address. The emulator is only honest because it is
constrained to Figma's vocabulary: if the IR is missing something the page had, a renderer
that can only emit Figma primitives physically cannot reproduce it, and the diff shows it.
If that constraint ever loosens into "render the CSS again", this decision is void.

## D2 — Plugin API is the emitter. Clipboard/Kiwi is a performance escape hatch, not the plan.

**Decided.** Researched Sep 2026.

Ways to get nodes into Figma, and why we chose as we did:

| Route | Verdict |
|---|---|
| **Plugin API** | **Primary.** Complete, supported, boring. Everything below is measured against it. |
| **Clipboard (Kiwi)** | Escape hatch. Real — html.to.design's no-plugin "Copy to Figma" is almost certainly this, and OpenPencil (6.6k stars, active) synthesizes payloads. Figma's *native* paste does the node creation at C++ speed, bypassing the sandbox entirely, which is a genuine performance argument for very large pages. But: the clipboard payload **omits the Kiwi schema** that `.fig` files embed, so there is no version handshake and we would own the drift risk with no maintained OSS library to lean on. Figma has never blessed it. |
| **Write `.fig` directly** | No. Feasible — the schema is self-describing inside each file and OpenPencil reads and writes it — but it produces a *file*, not an import into the document the designer is working in. Wrong shape for this product. |
| **REST API** | Not possible. Still no endpoint that creates, modifies or deletes file content in 2026. Comments, dev resources, webhooks and (Enterprise-only) variables are writable; layers are not. |
| **Figma MCP `use_figma`** | Not possible at this scale. Officially writes to files, but is catalog-gated and metered per seat — roughly 20 calls/month on Starter to 600/day on Enterprise. An importer emits thousands of operations per page. |

Both viable routes sit behind the same `FigmaIR`, so choosing between them stays a
deployment decision rather than an architectural one.

## D3 — Plugin implementation constraints (facts, not preferences)

These are documented Figma behaviours that shape the emitter. Do not rediscover them.

- **`createNodeFromJSXAsync` is the only documented bulk-create path** — one call builds a
  nested subtree instead of N creates plus N appendChilds. It cannot set style ids or
  render instances, so variables/styles/components need a second imperative pass. Nobody
  publishes a benchmark for it; measuring it against an imperative loop is the highest-value
  unknown in M2.
- **Nothing computational runs in the sandbox.** See D1. Transcoding, tiling, diffing and
  any byte-munging happen server-side or in the UI iframe, which is real V8.
- **The main thread now has `fetch` with `arrayBuffer()`** — binary can be pulled directly,
  no iframe round-trip needed for images or oracle tiles. Manifest needs
  `networkAccess.allowedDomains`, and those domains are published on the Community page.
- **Images: PNG, JPEG, GIF only; 4096px maximum; no built-in tiling.** Every modern site
  serves WebP/AVIF, so server-side transcode is mandatory, not an optimisation. Tiling is
  ours to implement and multiplies node count.
- **`createNodeFromSvg` is synchronous and is not the editor's parser.** SVGs with
  gradients in `<defs>` are a known live failure that the editor itself imports fine. Wrap
  every call; rasterise gradient-bearing or complex SVGs by policy. One SVG expands to a
  whole subtree, so a page of 200 inline icons is a node-count and memory event.
- **Fonts gate almost every text operation.** Collect the distinct `{family, style}` set
  across the page and `Promise.all` load once up front. Fills and strokes are the exception
  — they do not require a loaded font. `variationSettings` (2026) allows variable-font
  weights, so `font-weight: 350` can be matched exactly instead of snapped to a named style.
  That is a fidelity win available over the incumbent.
- **Memory is 2GB per browser tab**, and Figma names text, images and complex vectors as
  the contributors — precisely this workload. Warn at 90%; the file locks at 100%.
- **Manifest `documentAccess: "dynamic-page"`; never call `loadAllPagesAsync`.** An importer
  only touches `figma.currentPage`.
- **Chunk and yield** every N nodes, append the built tree to the page once at the end, and
  make the import cancellable with visible progress.
- **Measure in a released build, not in dev** — the 150x discrepancy above was invisible in
  development.

## D4 — Where we can beat html.to.design

Not by mapping CSS better; they have had years to do that. By the things the architecture
above makes available and a hand-written mapper does not:

1. **Per-element ground truth.** Nothing gets emitted that has not been compared against
   Chrome's own pixels for that element. Their fidelity is asserted; ours is measured.
2. **A guaranteed floor.** The bottom rung of every ladder is the oracle tile, so the worst
   case is accurate-but-less-editable, never wrong.
3. **Calibrated conversions instead of guessed ones.** The CSS→Figma transfer functions are
   fitted from data and re-fittable when Figma's renderer changes.
4. **Variable fonts.** Exact weight matching rather than nearest named style.
5. **Cascade-derived variables.** Bindings come from authored `var()` declarations, so a
   token means the author really wrote it — not a value that happened to match.
