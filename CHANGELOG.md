# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
adheres loosely to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
(pre-1.0: anything may break between minors).

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
