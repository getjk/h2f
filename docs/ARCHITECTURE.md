# How the shipped thing works

Three components. Each exists because of something the other two cannot do.

```
  Chrome extension (MV3)                    Server                      Figma plugin
  ──────────────────────                    ──────                      ────────────
  your real session                  transcode images                 build nodes
  authenticated pages                fetch fonts (CORS)               export each block
  a page in a state                  headless capture                 diff vs oracle tile
  you clicked into                   serve bundles + tiles            step down a rung
          │                                  │                              │
          └────── CaptureBundle ────────────▶│◀───── GET tile/:id ──────────┘
                                             │         (lazily)
                                             └──────── CaptureBundle ───────▶
```

## Why each piece

**The extension** exists for pages a server cannot reach: anything behind a login, an
SSO'd staging site, a page in a particular state you clicked into, a hover you want
captured. It runs `prepare.js` and `inpage.js` — the same files the harness uses, not a
reimplementation — and drives the CDP screenshots through `chrome.debugger`.

**The server** does the three jobs that can happen nowhere else. Figma will not accept
AVIF or WebP, and will not take an image fill over 4096px without tiling, so images are
transcoded. CORS stops a page from reading its own `@font-face` files, so fonts are
fetched server-side. And a capture of a real page is tens of megabytes, so the plugin
needs a URL to pull from rather than a message to receive. It also runs the headless
capture for public URLs — and that capture engine is `packages/capture` unchanged. The
harness is the server's capture half; it does not get rewritten.

**The plugin** applies a plan; it does not search for one. The ladder's descent happens
offline, on the server, because the plugin sandbox is a QuickJS-in-WASM VM roughly 150x
slower than real JS for computation, and shipping pixels across the iframe boundary to
diff them is the documented cause of plugin freezes. So the plugin creates nodes, loads
fonts, applies fills — and verification is a sampled QA mode rather than a per-node loop.
See `docs/DECISIONS.md` D1 for the reasoning and D3 for the constraints this imposes.

## The two flows

```
Paste a URL in the plugin   →  server captures headlessly  →  plugin fetches and renders
Click the extension         →  bundle uploads to server    →  appears in the plugin queue
```

The first needs no install and covers most public pages. The second covers everything
the first cannot reach. Same two-path shape html.to.design has, from the same constraints.

## Oracle tiles and the plugin

Because fitting moved off the plugin (D1), a normal import fetches **no oracle tiles at
all** — the server has already decided every rung, and the plugin only needs the assets
it is going to place. Tiles travel to the plugin in exactly two cases: a node that landed
on the raster rung, where the tile *is* the artwork, and QA mode, which samples a handful
of nodes to check the planner. The main thread has `fetch` with `arrayBuffer()`, so both
pull binary directly with no iframe round-trip.

`Oracle.tiles` stays a map keyed by node id rather than a blob because both of those
cases want individual tiles by id, not the whole set. That is the reason the format looks
the way it does.

## Revised milestones

M0 (done) capture, oracle, metric, corpus harness.

**M1 — the emulator.** Render CandidateIR back to HTML constrained to Figma's vocabulary,
screenshot in Chrome, diff against oracle tiles. No Figma involved. This is where the
ladder's rung decisions get made and graded, at corpus scale, in CI. It comes *before*
the plugin because it is what tells the plugin what to build.

**M2 — the plugin as applier.** `createNodeFromJSXAsync` benchmarked against an
imperative loop (the highest-value unknown), fonts deduped and preloaded, images
pre-transcoded and tiled server-side, chunked and cancellable. Plus QA mode: sample,
export, diff, report.

**M3 — calibration.** Fit the Chrome→Figma transfer functions per property, from
generated snippets. Bulk sweeps are cheap-agent work.

**M4 — the server and the extension.** Endpoints, bundle storage, MV3 wrapper for
authenticated pages.

Text is the exception that keeps real Figma verification throughout, because a browser
emulator predicts Figma's text layout worst of anything (D1).
