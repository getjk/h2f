# Working on h2f

## The rule

Every PR shows the corpus score table, before and after:

```
npx tsx bin/gate.ts L,M,S
```

Fidelity may not drop on any page. Editability may not drop without a stated reason.
A page that regresses is not "fixed" by special-casing its URL — fix the rule and add
the case to `packages/harness/fixtures/adversarial.html` or `hazards.html`.

## Who does what

- **Cheap agents (Haiku/Sonnet)**: one ladder rung, one calibration property, or one
  emitter rule per task, from the `TODO.md` in the package being worked on. Snippet
  generation and calibration sweeps are entirely theirs.
- **Main model**: briefs, plans, and QA of what came back.
- **Opus review**: the schemas in `packages/schema`, the fusion/planning step, the
  metric, and any change to the raster-vs-vector decision rule.

## Style

The fewest lines that read clearly. No abstraction for a second use that does not
exist yet. If a CSS property maps in five lines, write five lines.

Tool UIs — the Figma plugin panel, any harness viewer — use Base UI components.

## Branches

One branch per milestone, e.g. `m1/peel-ladder`. PRs into `main`.
