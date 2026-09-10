# h2f — HTML → Figma, paint-verified

Implements M0 of the v4 brief: the **oracle** (per-element ground truth from Chrome)
and the **metric**, plus multi-size capture. Nothing here maps CSS to Figma yet —
that comes next, and it will be graded by what is already in this repo.

## The idea being tested

For any element, Chrome can be asked what *that element alone* looks like: make the
whole page invisible, make one element visible, screenshot its box on transparency.
Do it for every element and you have a per-element ground truth in vector-free form.
Composite all of those tiles back in paint order and you should get the page back.

If that recomposition is pixel-exact, the oracle is sound — and every later stage
(vector boxes, real text, auto layout, components) can be graded element by element
against it, with a guaranteed raster fallback at the bottom of every ladder.

It is exact:

| page | size | nodes | tiles | meanΔE | p95ΔE | SSIM |
|---|---|---|---|---|---|---|
| basic | L 1440×900@2 | 19 | 19 | **0.015** | 0 | 0.9981 |
| basic | M 834×1194@2 | 19 | 19 | **0.015** | 0 | 0.9987 |
| basic | S 393×852@3 | 19 | 19 | 0.045 | 0 | 0.9953 |
| adversarial | L | 50 | 50 | **0.141** | 0.811 | 0.9900 |
| adversarial | M | 50 | 50 | 0.168 | 1.016 | 0.9876 |
| adversarial | S | 50 | 50 | 0.524 | 1.842 | 0.9624 |
| hazards | L | 34 | 34 | **0.057** | 0 | 0.9970 |

ΔE2000 of 1.0 is roughly the smallest difference a trained eye can see, so a mean of
0.015 is "the same image" and 0.5 is "sub-threshold everywhere". The adversarial page
covers linear and radial gradients, `clip-path` polygons, elliptical corner radii,
inset shadows, 2D transforms, WebP, AVIF, inline SVG with its own gradient, a sticky
header, `overflow` clipping, CSS columns, pseudo-element badges and a wavy underline.

The hazards page is the one that matters for real sites: a cookie bar, a newsletter
modal that only appears once the cookie bar is gone, infinite scroll that appends
three sections, `IntersectionObserver` reveals, lazy AVIF images, an autoplaying
video, a looping keyframe animation, a one-shot reveal animation and a sticky header.
Both interstitials are dismissed, all three appended sections arrive, every reveal
lands revealed, and the capture reports what it clicked (`prepared.dismissed`) and
anything still covering the page (`prepared.blockers`).

## Run it

```
npm i
npm run capture -- <url|file://…> L,M,S out    # structure.json + oracle tiles per size
npx tsx bin/verify.ts out/L                    # recomposition self-test
npx tsx bin/gate.ts L,M,S                      # score table over the whole corpus
npx tsx bin/gate.ts L ikea,nike                # ...or a subset
```

The corpus lives in `packages/harness/corpus.json`: IKEA, Nike and Airbnb first —
each picked for a different hazard — plus the three local fixtures.

## What is here

```
packages/schema/ir.ts        StructureIR + Oracle. The only vocabulary between stages.
packages/capture/inpage.js   Runs in the page: geometry, per-line text boxes,
                             computed style, cascade-derived variable bindings,
                             layer names, structural hashes.
packages/capture/capture.ts  Driver: device presets, settle, oracle capture, packing.
packages/harness/metric.ts   CIEDE2000 + SSIM + heat grid.
bin/{capture,verify,gate}.ts CLI.
```

### Getting the page ready to be copied

`packages/capture/prepare.js` runs before collection and does four things, in order,
because each one depends on the last. It clicks consent controls (including inside
shadow roots, where OneTrust and friends live), waits, and clicks again — the second
banner usually only exists once the first is gone. Anything still covering more than
45% of the viewport gets its close control tried, and whatever survives *that* is
reported rather than papered over: a paywall we cannot dismiss should show up in the
report, not as a silently wrong capture. Then it scrolls the page in 400px steps,
re-measuring height each pass so infinite scroll actually terminates, forces
`loading=lazy` images eager and decodes them. Then animations: looping ones are
paused at frame 0, one-shot ones are `finish()`ed, so scroll reveals land revealed
instead of frozen mid-fade. Then videos are paused and nudged to a real frame, and a
video with no decoded frames falls back to its poster.

### Five things that had to be right

1. **The root background propagates to the viewport canvas** and paints under every
   tile no matter what `visibility` says. It is cleared unless it is the target.
2. **`captureBeyondViewport` temporarily changes device metrics**, which re-lays-out
   the page under mobile emulation — the geometry we measured then described pixels
   that no longer existed. Screenshots scroll and stitch instead, clipped to the
   visible viewport so metrics never move.
3. **`captureScreenshot` without a `clip` ignores the device scale factor.** Strips
   came back at 1× while every coordinate was computed at 2×.
4. **A page with no viewport meta** gets Chrome's 980px fallback plus page scale,
   which puts layout, scroll and screenshot coordinates in three different spaces.
   Mobile presets lay out at device width instead, and the capture reports that it
   did (`injectedViewportMeta`).
5. **Sticky and fixed elements ride the viewport**, so they appear once per stitched
   strip. They are captured in the first strip at their scroll-0 position and hidden
   after that.

Each of these was found by the recomposition test, not by reading a spec. That is
the point of building the harness before the mapper.

### Variables come from the cascade, not from values

Matching computed values against token values is wrong — `16px` matches `--space-4`
by accident. Chrome also expands shorthands in the CSSOM and drops the `var()` from
the longhands, so `border-radius: var(--radius)` is invisible on
`border-top-left-radius`. The collector parses the authored declaration text and
expands shorthands itself, so a binding means the author really wrote the token.

## Not done yet

- **CandidateIR + the ladder.** Next milestone: rung 1 for text (reflowing paragraph)
  and boxes (parametric frame), verified per element against the oracle tiles.
- **The Figma plugin.** The verification loop has to live there — only the plugin can
  `exportAsync`. Its UI is built with Base UI components.
- **Calibration.** The transfer-function fitting rig (cheap-agent grunt work).
- **Real sites.** Still unvalidated. In Claude's sandbox the egress relay resets
  Chromium's TLS 1.3 handshake (curl and Node succeed through the same proxy);
  `H2F_TLS12=1` gets past that, and pages then load — but real pages are large enough
  that they exposed two scaling bugs in the collector, both now fixed: `varBindings`
  ran one `querySelectorAll` per CSS rule (now grouped by binding set and chunked),
  and `isolationBlocker` re-walked every ancestor calling `getComputedStyle` (now
  inherited down the walk). The scroll pass also gained a time and height budget so
  an infinite feed terminates and says it was truncated. None of this is validated
  against IKEA/Nike/Airbnb yet — that is the first job on real hardware:
  `npm run gate -- L ikea,nike,airbnb`.
- **Asset extraction** (image bytes, font files) and the server.
