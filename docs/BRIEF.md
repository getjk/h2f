# HTML → Figma v4 — Project Brief (everything editable, verified per element)

**Owner:** Joseph Krilanovich · **Audience:** implementing agents (Cursor / Sonnet / Haiku) and architecture review (Opus) · **Date:** 2026-09-09 · **Status:** Draft for review · **Supersedes:** v3 (same day)

---

## 0. What changed from v3

v3's insight was right: fidelity must come from what Chrome *rendered*, not from a hand-written CSS→Figma table. But v3 leaned on `printToPDF` as the primary vector source, and PDF is the wrong tool for a **design** tool. A PDF is a flattened drawing: glyph runs instead of paragraphs, rasterized shadows, no notion of a component, a token, or a layout rule. It makes the picture right and the file dead. The goal is the opposite — every text block reflows, every card is an instance, every color is a variable, every row is auto layout — *and* the picture is right.

So v4 separates two questions that v3 conflated:

- **What should each thing look like?** — answered by Chrome, per element, as pixels (the *oracle*).
- **What should each thing be made of?** — answered by the DOM and the CSS cascade, translated into the most editable Figma construct available (the *candidate*).

The system's job is to propose the most editable candidate for every element, render it in Figma, compare with the oracle, and step down one rung of editability only when the comparison fails. This **editability ladder** is the core mechanism. PDF is demoted to an optional path oracle for a few exotic shapes, and may not be needed at all.

Also new: **multi-size capture** (L / M / S presets: small MacBook, iPad portrait, iPhone) with cross-size correlation so the same DOM element becomes the same component across breakpoints.

## 1. Goal and success criterion

Unchanged in spirit, sharpened in wording. On the 20-page corpus at each captured size:

- **Fidelity:** perceptual pixel score (ΔE2000 mean, SSIM, heat map) ≥ html.to.design's on every page; zero dropped content.
- **Editability:** a measured *editability index* — the share of elements sitting on the top rung of their ladder (reflowing paragraph, parametric box, real gradient, auto layout, component instance, variable-bound color). Reported per page and per rung. There is no fixed target in v4; the index must rise monotonically across milestones without the fidelity score falling. Both numbers appear in every PR.

## 2. The oracle — per-element truth from Chrome, no Skia, no PDF

For any element we want to verify, we need "what does *this element alone* look like," with alpha, in page coordinates. Chrome gives us that with two CDP calls and no experimental APIs:

1. `Emulation.setDefaultBackgroundColorOverride({ r:0, g:0, b:0, a:0 })` — transparent page.
2. Inject `* { visibility: hidden !important }` then `#target, #target * { visibility: visible !important }` — `visibility` preserves layout and lets descendants override ancestors, so the target subtree paints exactly as it does in context (its own backgrounds, its own text) while everything around it, including ancestor backgrounds, disappears.
3. `Page.captureScreenshot({ clip: bbox, captureBeyondViewport: true })` at DPR 2.

Batch it: many non-overlapping targets per screenshot (bin-pack by bbox), so a 1 000-node page needs tens of screenshots, not thousands. The Figma side of the same comparison is `node.exportAsync({ format: 'PNG', constraint: { type:'SCALE', value:2 }, contentsOnly: true })`. Both are transparent PNGs of one thing in isolation, so the diff is precise and attributable. The full-page screenshot (also captured) remains the final composite check, because compositing effects (blend modes, backdrop blur, ancestor opacity) only show up there.

This is the whole verification engine. It also doubles as the **raster fallback** — the bottom rung of every ladder is "place the oracle PNG."

## 3. The candidate — the most editable construct the DOM supports

Source of truth for *structure and semantics*: `DOMSnapshot.captureSnapshot` (tree, layout boxes, text boxes, paint order) plus `CSS.getMatchedStylesForNode` for the elements that matter. The second call is what makes the design-tool goals reachable: it returns the *cascade*, not just computed values — the original declarations with their `var(--brand-500)` references, the matched selectors (`.btn-primary`, `card__title`, Tailwind classes), and `@media` conditions. From this we get:

- **Variables:** every color/spacing/radius value that traces to a custom property becomes a Figma variable (`--brand-500` → `brand/500`), bound on the node. Values that don't trace stay literal.
- **Layer names and hierarchy:** from semantic tags, class names, ARIA roles, and headings. `nav`, `article`, `.card` — not `Frame 4127`.
- **Text styles:** the (family, size, weight, line-height, letter-spacing) tuples that recur become local text styles.
- **Components:** subtrees with identical structural hash (tag + class skeleton, ignoring text and image src) that occur ≥ 2 times become a component with instances; text and image differences become overrides. Across sizes (§6) the same hash becomes a variant set.
- **Layout:** `display: flex` / `grid` parents with their gap, padding, alignment, and child sizing rules become Figma auto layout (grid layout mode where the Figma version supports it — verify at M0 and gate).

## 4. The editability ladder

Each element type has an ordered list of candidates. The emitter tries the top rung, runs the oracle comparison, and steps down until one passes. The passing rung, the score, and the reason for any demotion are written to the node's plugin data and the report.

**Text**
1. One paragraph node, fixed width, auto height, with Figma's own wrapping — passes only if Figma's line breaks match Chrome's text boxes exactly. Fully editable and reflowing.
2. One paragraph node with forced line breaks at Chrome's break points. Editable, no reflow.
3. One node per line box, fixed size. Editable per line.
4. Outlined glyphs (vector) — only if a font truly can't be loaded or substituted.
5. Oracle raster.

**Box (any element with visible background/border/shadow)**
1. FRAME/RECTANGLE with solid or gradient fills, per-side stroke weights (Figma supports individual side weights), per-corner radii, drop/inner shadows, layer blur, opacity, blend mode, clipsContent from `overflow`.
2. Same, with the hard part (e.g., a `backdrop-filter`, a multi-stop conic gradient, an inset shadow with spread) replaced by an oracle raster of just that effect layered beneath the editable parts.
3. Oracle raster.

**Gradient fill** — Figma gradient with handles solved from CSS angle/position and the box's aspect ratio → image fill of the oracle.
**Image** — image fill with `object-fit` crop and `currentSrc` at that size → oracle raster.
**Inline SVG** — `createNodeFromSvg` with CSS variables resolved → oracle raster.
**Layout** — auto layout (flex or grid) whose re-laid-out child rects match Chrome to ≤ 0.5 px → absolute positioning.
**Repetition** — component + instances with overrides → plain frames.
**Color** — variable-bound → literal.

The ladder is data, not code: a list per type in `packages/ladder`, so adding a rung or reordering one is a one-line change reviewed by Opus.

## 5. Calibration — learn the CSS→Figma transfer functions instead of guessing them

Even with the ladder, the top rungs need parameter conversions that are not 1:1: CSS `box-shadow` blur vs. Figma effect radius, `letter-spacing` and `line-height` rounding, stroke alignment, gradient handle geometry, `filter: blur()` vs. layer blur. v1 and html.to.design hard-code these. We fit them.

Method: Haiku-class agents generate a few thousand one-property HTML snippets (`box-shadow: 0 4px 12px rgba(0,0,0,.25)` on a 200×100 box, varying every argument; same for each property on the calibration list). Each snippet is rendered by Chrome (oracle) and by Figma with the candidate parameters swept over a small grid (via a headless plugin run that exports PNGs). The parameter set with the minimum diff per snippet gives the transfer function; fit a simple curve; store it in `packages/calibration/*.json` with the residual error. Re-run when Figma's renderer changes. This is a one-time, fully automatable, cheap-agent job — exactly the grunt work to hand to the smallest model — and it turns the "we're not sure how Figma's blur relates to CSS blur" class of bug into a measured number.

## 6. Multi-size capture

A capture job takes `sizes: ('L' | 'M' | 'S')[]`, default `['L']`. Presets (overridable per job):

- **L** — small MacBook: 1440 × 900 logical, DPR 2, desktop UA, mouse.
- **M** — iPad portrait: 834 × 1194 logical, DPR 2, iPad UA, touch.
- **S** — iPhone: 393 × 852 logical, DPR 3, iPhone UA, touch.

Each size is a separate Chromium context with `Emulation.setDeviceMetricsOverride` + UA + touch emulation, so responsive sites serve the layout and the `srcset` image they'd serve a real device; full-page height is measured after load and idle. (Rendering is Chromium's, not Safari's — noted, accepted.)

Output: one Figma section per capture, one top-level frame per size, laid side by side, named `<title> / L`, `/ M`, `/ S`. Cross-size correlation uses a stable element key (DOM path + structural hash + text content) computed in each context, so the same card at three widths becomes **one component with a `size` variant**, the same heading becomes the same text style, and the same `--brand-500` becomes the same variable. Elements present at one size only (hamburger menus, desktop-only sidebars) are simply that size's own nodes. Fidelity and editability are reported per size; the corpus gate applies to every size captured.

## 7. Where PDF and Skia land now

`printToPDF` (Route P) and `LayerTree.snapshotCommandLog` (Route S) from v3 are no longer on the critical path. The oracle (§2) gives per-element pixel truth without them, and the DOM gives editable structure that they can't. They remain a **2-day spike** for a narrow question: is there a cheap way to get exact vector paths for `clip-path`, elliptical corner radii, `text-decoration: wavy`, and CSS-shape `border-image` — things the DOM describes only in CSS and the raster fallback describes only in pixels. If the spike says yes, the paths feed a "vector from paint" rung between "parametric" and "raster" on the Box ladder. If not, those cases sit on the raster rung and nobody notices.

## 8. Architecture

```
 Chrome (Playwright/CDP for public pages + harness; MV3 extension via chrome.debugger for authenticated pages)
 ├─ per size: DOMSnapshot + CSS.getMatchedStylesForNode ─▶ StructureIR   (tree, boxes, text boxes, cascade w/ var refs, classes)
 ├─ per size: full-page + isolated-element screenshots ─▶ Oracle tiles   (transparent PNGs, DPR 2/3, batched)
 └─ fonts (@font-face src) + image bytes (currentSrc)   ─▶ Assets

 Server (Fastify, sharp):   plan(StructureIR) ─▶ CandidateIR  (ladder rung 1 for every element, variables, styles, components, layouts)
 Plugin (Figma):            emit(CandidateIR) with ladder descent against Oracle tiles ─▶ canvas + provenance + report
 Calibration (offline):     snippets ─▶ Chrome + Figma renders ─▶ transfer-function JSON consumed by plan()
```

Boundaries: `StructureIR`, `CandidateIR`, `Oracle` manifest — JSON schemas with golden fixtures. `plan()` is pure. The ladder descent runs in the plugin because only the plugin can `exportAsync`; it is the only place where verification and emission are the same loop.

## 9. Milestones

**M0 — Harness, oracle, calibration rig (1.5 weeks).** Corpus captured at L (M and S for five pages); metric with golden test; html.to.design reference scored; isolated-element screenshot batching working; headless Figma export runner; calibration rig produces its first transfer function (box-shadow). *Gate:* html.to.design score table; oracle tiles for all corpus pages; one calibrated property with residual < 1 % ΔE.

**M1 — Ladder with bottom two rungs (1.5 weeks).** Every element: oracle raster, plus text rungs 3 → 1 and image rung 1. Plugin, report, provenance. *Gate:* fidelity ≥ html.to.design on ≥ 18/20 at L; every text element on a text rung (none on raster) unless flagged `background-clip:text` / blend context.

**M2 — Parametric boxes, gradients, SVG, calibration list complete (3 weeks).** Box rung 1–2, gradient, SVG; all calibration properties fit. *Gate:* fidelity unchanged or better; editability index ≥ 70 % top-rung on median page.

**M3 — Variables, styles, components, auto layout (3 weeks).** Cascade-derived variables and text styles; repetition → components; flex/grid → auto layout with the ≤ 0.5 px check. *Gate:* fidelity unchanged; editability index reported for all four constructs; corpus median ≥ 50 % of flex parents on auto layout.

**M4 — Multi-size + extension (2 weeks).** L/M/S presets, cross-size components/variants, MV3 front for authenticated pages, five authenticated corpus pages. *Gate:* all gates hold at every captured size.

**M5 — Spikes (2 days each, anytime after M1).** Vector-path oracle (PDF/Skia); html.to.design `.h2d` as a `StructureIR`-only source.

## 10. Working agreements

- Fewest lines that read clearly; ladders and calibration tables are data, not code.
- Haiku/Sonnet-class agents: one rung, one calibration property, one emitter rule per task from `TODO.md` checklists; snippet generation and calibration sweeps are entirely theirs.
- Opus reviews: schemas, `plan()`, the ladder definitions, the metric.
- Every PR shows fidelity and editability before/after per corpus page and size. Fidelity may not drop; editability may not drop without a stated reason.
- No URL special-casing; add the case to the adversarial corpus.

## 11. Risks

- **`visibility`-isolation edge cases** — elements relying on ancestor `overflow` clipping, `mix-blend-mode`, or `backdrop-filter` don't isolate cleanly. Detected from computed style; those elements are verified only against the composite and start one rung lower.
- **Figma wrapping ≠ Chrome wrapping** even with the same font (kerning, hyphenation, justification). Expected; that is why rungs 2–3 exist. Track how often rung 1 passes — it's the headline editability number for text.
- **Cascade access cost** — `CSS.getMatchedStylesForNode` per element is slow on big pages. Call it only for elements that carry visible style (boxes, text), batch, cache by matched-rule signature.
- **Figma grid auto layout availability / API surface** — verify at M0; fall back to flex-only inference.
- **Component detection false positives** — two visually different cards with the same skeleton. The oracle catches it: if instances' overrides can't reproduce the pixels, the repetition rung demotes to plain frames.
- **`exportAsync` time during import** — batched per bin-packed oracle tile, not per element; "fast import" toggle reuses the last provenance.

## 12. Open questions for Joseph

1. Presets: 1440 × 900 for L (or 1470 × 956, the current 13″ Air default)? 834 × 1194 for M (11″ iPad) or 820 × 1180? 393 × 852 for S?
2. Should M and S be captured by default when the site serves a different layout, or only when asked?
3. Variables: one collection per capture, or merge into a named collection the user picks (so repeated captures of the same product reuse `brand/500`)?
4. Components across sizes as variants (one component, `size` property) or as three sibling components? Variants are the better design-tool answer but make instance overrides heavier.
5. Corpus: which 20 pages?

## 13. Definition of done

All corpus pages import at every captured size with zero dropped content; fidelity ≥ the html.to.design reference on every page and size; every element's rung, score, and demotion reason visible in the plugin; variables, text styles, components, and auto layout produced wherever the ladder verified them; calibration tables regenerable by one command; harness runnable by any agent in one command.

---

*Sources for html.to.design behaviour referenced above: [Open an .h2d file](https://html.to.design/docs/open-h2d-file/), [Import directly from your browser with the browser extension](https://html.to.design/docs/extension-tab/).*

---

## Addendum — what has happened since this brief was written

**M0 is built and validated.** The oracle, the metric and multi-size capture all work;
recomposition of the isolated tiles reproduces the page (fixtures: basic 0.015,
adversarial 0.14, hazards 0.003). IKEA passes on real hardware at 0.948 with zero
blockers — that number deserves a look at its heat map before being called good.

**Confirmed by building it:**
- Measuring first was right. Every bug in `README.md`'s hard-won list was found by the
  recomposition test, not by reading a spec.
- The raster floor holds: isolated tiles composite back to the page exactly, so the
  bottom rung of every ladder is safe.
- The `.h2d` route is weaker than it looked. It can only ever supply structure, never
  paint, so it caps out at the Peel rung. Still a spike, still not a dependency.

**Changed since writing:**
- `paints()` was not in the brief. Only elements that put pixels on screen need an
  oracle tile; on a real site the majority of nodes are layout wrappers that do not.
  This is what makes the oracle affordable at real-site scale.
- Horizontal scroll is not captured at all. The brief assumed full-page capture; in
  practice only vertical strips are taken, so carousel content off to the right is
  counted in `oracle.offscreenX` rather than pretended at.
- Preparation (interstitials, lazy loading, animation settling, media freezing) turned
  out to be a first-class stage with its own failure modes, not a footnote in capture.

**Not started:** the ladder, the Figma plugin, the server, calibration. See
`docs/ARCHITECTURE.md` for the shape those three take at runtime.
