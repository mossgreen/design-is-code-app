# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
adheres loosely to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
(pre-1.0: anything may break between minors).

## [v0.1.0] - 2026-05-06

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
