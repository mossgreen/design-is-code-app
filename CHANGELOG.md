# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
adheres loosely to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
(pre-1.0: anything may break between minors).

## [v0.3.0] - 2026-05-10

Public-ready polish: the wizard no longer auto-fills with demo data, you
can pick which Claude model runs DisC, and the "Run it for me" pipeline
streams progress live with an 8-step checklist and a working Cancel
button. Plus a Claude Code plugin pre-flight that catches "DisC isn't
installed" before you hit run, and surfaces updates when they're available.

### Added
- **Live DisC run console.** "Run it for me" now streams the subprocess's
  stream-json output back into the wizard as it happens: an 8-step
  checklist (init → tests → green → impl → coverage …) ticks through in
  real time, the elapsed timer updates each second, and a Cancel button
  cleanly tears down the spawned `claude` process.
- **Model picker on Step 4.** Pick Sonnet 4.6 (default), Opus 4.7, or
  Haiku 4.5 next to the "Run it for me" button. The selection is passed
  to the spawned subprocess as `--model <id>` against a server-side
  allowlist; no other models are accepted. Doesn't affect the slash
  command you copy for interactive use.
- **DisC plugin pre-flight.** Before the wizard offers "Run it for me"
  it checks whether `design-is-code` is installed in your Claude Code
  config and which version. If missing, an inline "Install plugin"
  banner runs `claude plugin install …` for you. If outdated, an
  "Update plugin" banner shows the new version + changelog link and
  installs the upgrade with one click.
- **"Load demo data" button** in the header (next to the Connect-project
  chip). Click it to seed the same end-to-end "generate invoice"
  example that used to load automatically.
- **Multi-modal input affordances** on Step 2's Participants and Steps
  section heads — greyed-out text/image/voice/video icons signaling the
  natural-language / multi-modal input paths planned for a later release.
- **Release runbook** ([`RELEASE.md`](./RELEASE.md)) — a checklist the
  AI agent follows when you say "release it."

### Changed
- **Wizard starts blank.** Story textarea, participants list, sequence
  steps, target package, and project chip all start empty on page load.
  This makes the app usable for someone other than the author. Use the
  new "Load demo data" button to get the previous behavior.
- **Step 4 layout** tightened around the run-result panel — model picker,
  copy-command button, plugin pill, and run controls now sit on a single
  wrapping row instead of stacking.

### Breaking
- The page no longer auto-prefills with the invoice example or
  auto-connects to `/Users/mossgu/Downloads/demo`. If you relied on a
  full-screen demo on page load (e.g. screencasts, screenshots), click
  "Load demo data" first or revert to v0.2.0.

[v0.3.0]: https://github.com/mossgreen/design-is-code-app/releases/tag/v0.3.0

## [v0.2.0] - 2026-05-09

Branching support: sequences can now express the full PlantUML control-flow
family (if/else, while, for-each, optional, parallel branches), not just
plain loops. Plus a Linear/Vercel-flat visual refresh and a Playwright
end-to-end test suite.

### Added
- **Control-flow fragments** in Step 2's composer:
  - `+ if/else` (PlantUML `alt`) with `+ else` insertion for else-if branches.
  - `+ opt` for single-condition optional blocks.
  - `+ par` (parallel) with `+ else` for separating concurrent branches.
  - `+ while`, `+ for-each` — semantic loop variants on top of plain `+ loop`.
  Each fragment renders as a colored bracket in the live SVG (indigo for
  loops, teal for alt, violet for opt, cyan for par) with dashed `else`
  divider lines for alt/par. The legacy `+ start loop` / `+ end loop`
  shorthand still works — old sequences are unaffected.
- **Visual refresh.** New design-token block (`--accent`, `--border`,
  `--radius`, etc.), Inter + JetBrains Mono via Google Fonts, deep blue
  accent (`#1e40af`), tighter Linear/Vercel-flat surfaces and 13px base.
- **End-to-end test suite** in [`e2e/`](./e2e). Playwright-driven, 14
  tests covering page load, step navigation, participant modal, every
  fragment-add button, and PlantUML emission for each fragment type.
  Run with `cd e2e && npx playwright test` against a running app.

### Changed
- `state.sequence` model unified onto `FRAG_START` / `FRAG_ELSE` / `FRAG_END`
  markers with a `fragType` field. The legacy `LOOP_START` / `LOOP_END`
  kinds are preserved as back-compat aliases — old in-flight diagrams keep
  rendering and emitting correctly.
- `emitPlantUml` now indents fragment bodies one level and auto-closes any
  unbalanced fragments at the end so the output is always valid PlantUML.

### Compatibility
No breaking changes for users of v0.1.0. The loop seed in the demo, any
diagrams in `design/` folders, and the `/api/scan` / `/api/design` /
`/api/run-disc` endpoints behave identically.

[v0.2.0]: https://github.com/mossgreen/design-is-code-app/releases/tag/v0.2.0

## [v0.1.0] - 2026-05-05

First usable release. A 4-step wizard for designing sequence-diagram-driven
flows and handing them off to DisC for code generation.

### Added
- 4-step wizard: User Story → Designer → Review → Generate.
- Step 2 designer: participant cards with modal editor (interface name,
  IMPL toggle, typed IN/OUT methods), sentence-style step composer with
  progressive hint and Enter-to-add, and a live SVG sequence diagram that
  updates as you compose.
- Loop fragments: `+ start loop` / `+ end loop` step kinds, rendered as a
  translucent indigo bracket in the SVG and emitted as indented
  `loop ... end` in the PlantUML.
- Create-arrow inference: when a method's return type names another
  defined participant, the step renders as a regular call to the factory
  followed by a dashed `<<create>>` arrow that introduces the new
  participant's lifeline mid-diagram.
- Step 4 generate panel: target-package input emits the `' @package` header
  DisC requires; soft validation warns when the package is empty or
  malformed without blocking save.
- "Save to project" writes the `.puml` into the connected project's
  `design/` folder. "Run it for me" shells out to
  `claude --dangerously-skip-permissions -p /design-is-code:disc <file>`
  and streams output back into the wizard.
- README + screenshots (end-to-end demo GIF + DisC run result).

### Status
POC. Single-user. Localhost-only. No persistence — refreshing the browser
loses your work.

[v0.1.0]: https://github.com/mossgreen/design-is-code-app/releases/tag/v0.1.0
