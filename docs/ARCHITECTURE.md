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

**The plugin** is where the editability ladder runs, and it has to be: only plugin code
can call `exportAsync`. Build a node the most editable way, export it, diff it against
Chrome's tile for that element, step down a rung on a miss. That loop cannot live on the
server (which cannot render Figma) or in the extension (which cannot see the document).

## The two flows

```
Paste a URL in the plugin   →  server captures headlessly  →  plugin fetches and renders
Click the extension         →  bundle uploads to server    →  appears in the plugin queue
```

The first needs no install and covers most public pages. The second covers everything
the first cannot reach. Same two-path shape html.to.design has, from the same constraints.

## The payload problem, and the answer

Oracle tiles have to reach the plugin for the diff to happen, and a 2000-tile page at
DPR 2 is a lot of megabytes. Shipping them all up front would make import feel terrible.

So the plugin fetches a tile **only when the ladder actually needs to verify that node**.
Most nodes pass on the top rung and their tile is never requested at all. The server
serves tiles individually by node id; a clean import pulls a small fraction of them.

This is why `Oracle.tiles` is a map keyed by node id rather than a blob, and why tiles
are written as separate files rather than a sprite sheet. The lazy fetch is the reason
the format looks the way it does.

## Status

Built: capture, oracle, metric, corpus harness — everything above the dashed line in
`packages/`. Not built: the extension wrapper, the server endpoints, the plugin, the
ladder, calibration. The plugin is the next milestone and the one that turns this from a
measurement harness into a tool.
