# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
adheres loosely to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
(pre-1.0: anything may break between minors).

## [Unreleased]

Post-v0.8.0 work on `main`. Not in the published jar.

### Fixed
- **The design validator now sees the decision tables.** `--validate-only`
  received the `.puml` alone, so Step 1 judged the design as if every leaf were
  unspecified: a decision table could contradict the diagram, or specify a call
  the design never makes, and validation still passed — the reviewer was told the
  design was fine while the generator went on to read a different one. Sidecars
  are now staged beside the design being validated. (Long-standing; tracked as
  "P4".)
- **A Stage-D guard that could never fire.** The "SUT must not be added" rule
  required the change to be filed under `element == "participant"`, but the
  differ files SUT rewiring under `"arrow"`, so no real delta could ever trip it.
  Now keyed on the operation and name, which is the actual invariant.

### Added
- **Tests that prove the claims in [WHY.md](WHY.md)**, all free of model calls:
  `DerivationStabilityTest` (repeated derivation is byte-identical; a comment
  moves nothing; one added call moves exactly one arrow),
  `DesignDeltaValidatorTest` (Stage D had no direct tests despite owning the rule
  that prevents a wholesale overwrite from deleting uncaptured code),
  `DesignReceiptTest` (the orchestrator has zero branches while the naive
  counterfactual for the same ticket has three; the expected `verify()` count is
  computable from the design alone).
- **`DerivationStabilityForeignRepoTest`** — the same stability properties
  against any repository, opt-in and free:
  `./gradlew test --tests '*ForeignRepo*' -Ddisc.stability.repo=<path>
  -Ddisc.stability.entry=Class#method`. Verified on upstream `spring-petclinic`.
- **[WHY.md](WHY.md)** — the seven-claim argument for DisC, each claim with its
  mechanism, the test that proves it, and an explicit list of what DisC does
  *not* claim.

## [v0.8.0] - 2026-07-31

The theme is a single defect class: **a design could name values that nothing
produces.** Call arrows echoed the callee's declared parameter names instead of
binding the caller's actual values, so a flow could fetch something and hand it
to nobody — code that compiles, tests that pass, and a feature that does
nothing. The fix restores `data_pipe` in the emitter, then adds a deterministic
gate so the same class of defect cannot reach a reviewer again.

**Generation is no longer labelled experimental.** It is verified end-to-end on
spring-petclinic — both a greenfield feature and a variance change over its own
generated output, each to a green suite with zero hand edits. That is one
repository, and the README says so; it is a real result, not a general
guarantee.

**If you already have the DisC plugin, upgrade it with `claude plugin update`** —
see Requires, below. The command previous releases documented does not work.

### Fixed
- **Call arrows carry value bindings, not signature echoes.** `sequencer.md`
  told the model to omit args when reusing an existing method, and `app.js`
  discarded any args it did send, rendering the callee's *declared* parameter
  names into the arrow. The plugin reads an arrow as `verify(collab).method(value)`
  — a binding — so the two agreed only when names happened to coincide. Steps
  now carry `args` and `resultName`; `callSignature(step, m)` emits the binding
  and falls back to declared names only for hand-built sequences. Declaration
  and binding stay separate, because decision-table sidecars key on parameter
  names and a binding must never rewrite them.
- **Resolvers emit the real discriminator instead of a placeholder `key`.**
  Every generated resolver carried `resolve(key)` and a sidecar keyed on
  `key: String` — a name copied out of the analyzer prompt's pattern sketch and
  hardcoded into `DesignDeltaEmitter`, referring to a value no flow produced.
  Stage B already classified the discriminator; it was simply dropped after
  classification. `DesignDelta` now carries it, and the emitter uses it for both
  the arrow and the sidecar's input column.
- **`scripts/disc-generate` refuses an ambiguous repo.** It picked the
  alphabetically-first `.puml` when a project had several — the normal case from
  the second ticket onward — and reported success having generated the wrong
  one. It now refuses and lists the `--file` options. The app's Generate button
  is unaffected; it passes an explicit path.
- **Missing favicon.** `index.html` declared no icon, putting a `/favicon.ico`
  404 in every user's console on first load. Now an inline SVG data URI.

### Added
- **Data-flow gate.** `DataflowLinter` + `POST /api/design/lint`, run by the
  wizard right after composition — it retries the sequencer once through the
  existing `{REFUSAL_FEEDBACK}` path, so the model fixes its own mistake before
  a reviewer sees it. Step 3 stays as the backstop. One rule core over a
  normalized `Flow`, with two adapters (`fromPuml`, `lintSteps`). Rules: an
  argument with no producer above it (violation); a design-declared value
  produced and never used (warning); a method invoked on a REUSE'd type that the
  codebase scan says does not exist (violation); a return label that is a bare
  type rather than `value : Type` (warning). Unknown and generic types are never
  judged — a false refusal costs more than a missed catch.
- **Decision-table sidecars are linted against the flow.**
  `DataflowLinter.lintDecision` reports a sidecar with no `target:`, a malformed
  target, a target nothing in the flow calls, and two rows mapping the same
  inputs to different outputs. `POST /api/design/lint` accepts an optional
  `sidecars` map and merges both verdicts; a client that sends none gets the
  flow verdict alone, unchanged.
- **One decision-table frontmatter emitter.** `decisionFrontmatter()` replaces
  four hand-rolled copies across the resolver, rule-table, pure-function-leaf,
  and human-authored paths, and `collectAllDecisionTables()` returns one deduped
  list in precedence order — a human-authored table wins over a synthesised one.
  Config defaults are merged per key rather than as a whole object, and the keys
  that came from a default are reported back as `appliedDefaults`.
- **The frontend's first automated tests.** `app.js` was 6.4k lines with no test
  coverage, which is where the `data_pipe` defect lived. `FrontendChainTest` +
  `src/test/js/{harness,design-chain}.js` load the *real* `static/js/app.js` in a
  Node vm behind a DOM stub — a copy would prove nothing. Each case is a property,
  not a scenario: a binding beats the declared name, a step without args falls
  back, a signature-shaped args list is never read as values, a severed flow is
  reported. Runs under `./gradlew test` with no model calls, and skips cleanly
  when `node` is absent.
- **`SequencerEvalTest`** — judges the sequencer's raw step JSON, which is
  exactly what the prompt controls: args as strings not signature objects, no
  placeholder names, `resultName` on non-void calls, and `DataflowLinter.lintSteps`
  clean. Pass-rate gated like the analyzer eval. `EvalConfig` extracted so both
  evals share one opt-in config path.
- **`src/test/js/e2e-wizard.js`** — Playwright against the real browser and a
  real Spring project. It also breaks a binding on purpose and asserts sign-off
  is blocked: a gate observed only passing is not observed.
- **`rules/dataflow-provenance.md`** — a new `must` rule, single-sourced into
  both the analyzer's guidance and its self-check. States the outside-in
  contract, forbids placeholder names, and (added after live runs invented a
  `visit.hoursUntilVisit()` that does not exist) states that a reused type's
  method surface is fixed.
- **Sign-off lists the decision-table defaults nobody chose.** A table pins
  behaviour at its rows; its `config:` block pins what happens off them — nulls,
  rounding, the exception type. Blanks get filled in by the wizard, and those are
  decisions the methodology assigns to a person. They are now shown per file and
  per key at sign-off, including when the author set *some* config and left the
  rest — the case where it is easiest to believe you configured something you
  did not. Informational, never a gate.

### Fixed
- **The plugin upgrade command the app suggests now works.** When the plugin is
  installed but behind, `GET /api/generator/status` returns `claude plugin
  update …` instead of `claude plugin install …`. The install form succeeds,
  prints "already installed", and leaves the old version in place — so the user
  runs what the tool told them and stays outdated.
- **README install command named the wrong repo** (`mossgreen/design-is-code`
  instead of `mossgreen/design-is-code-plugin`), so every fresh install from the
  quickstart failed at the plugin step. Present since v0.7.0.
- README described the analyze chain as three model calls; the data-flow gate's
  retry makes it four. Its test section named only `./gradlew test`, omitting
  `./gradlew eval` and the browser e2e — both of which cost money.

### Requires
- The DisC plugin **v0.11.2+** — resolver-mode permits are Spring beans. The
  earlier rules said permits get no Spring stereotype while resolver mode injects
  them by constructor; the contradiction was invisible to every unit test and
  only appeared when the application context loaded.
- **Upgrade with `claude plugin update design-is-code@mossgreen-design-is-code`.**
  If you already have the plugin, `marketplace update` followed by
  `plugin install` does **not** upgrade it — `install` reports "already
  installed" and leaves the old version in place. Earlier releases documented
  that sequence, so anyone who followed it is still on the older plugin.

[v0.8.0]: https://github.com/mossgreen/design-is-code-app/releases/tag/v0.8.0

## [v0.7.0] - 2026-07-27

DisC Studio becomes a **design-review tool**: point it at an existing
Java/Spring project and it derives the current design from your code, shows a
before/after diff of the change under review, and blocks sign-off if the
proposed design would silently drop calls that exist today. Handing the design
to the DisC plugin to generate tests + code is included but **experimental** —
the design-review path is the verified one.

### Added
- **Code→design derivation.** A deterministic projection of a Java entry
  method's call flow into a sequence diagram (`POST /api/code-derive`,
  `/api/code-derive-by-path`): same code in, same diagram out; a small edit
  makes a small diagram change. Resolves through an interface to its
  implementing class, so the derived flow is the real one, not an empty stub.
- **Step 3 is a design diff.** Sign-off shows *before* (your code's current
  flow, or a greenfield banner) beside *after* (the proposed design), plus a
  plain-language "why this design" from the analyzer's variance plan.
- **Dropped-call gate.** If the proposed design removes a call that exists in
  the current code, Step 3 lists it and blocks team sign-off until the removal
  is explicitly acknowledged — catching silent behaviour regressions before
  any generation.
- **Update-mode grounding.** When the story names an existing class
  ("Update X"), that class's current flow is injected into analysis so the
  design preserves calls the acceptance criteria never mention; a chip under
  the story box shows whether the name matched (and hints on near-misses).
- **Code→design diff pipeline** (dev harness at `code-diff.html`): a ticket +
  code → minimal design delta (new variant behind a resolver / rule-table),
  with a before/after view and a deterministic test-cost rationale.
- **Abort a running analysis** — the Analyze banner gains an Abort action that
  stops the in-flight LLM chain and kills the subprocess.

### Changed
- Story and acceptance criteria are entered together in one Step-2 box;
  Gherkin lines parse into criteria automatically.
- `disc.claude.effort` defaults to `medium`; subprocess timeout raised to 600s.
- A one-variant "family" is refused with a question instead of generating an
  abstraction with nothing to choose.

### Requires
- The DisC plugin **v0.11.1+** (validate no longer false-refuses correct
  designs). Install/update: `/plugin marketplace update mossgreen-design-is-code`.

[v0.7.0]: https://github.com/mossgreen/design-is-code-app/releases/tag/v0.7.0

## [v0.6.1] - 2026-06-25

Analyzer design rules are now single-sourced: each rule is authored once and
rendered into both the prompt's full guidance and its one-line self-check, so
the two can no longer drift apart. No change to the design judgment itself —
eval holds at 6/6 on vanilla petclinic with no regression versus v0.6.0.

### Changed
- **Rule-as-object model in the analyzer prompt.** `analyzer.md` defines a Rule
  concept (`id` / `title` / `guidance` / `why` / `appliesWhen` / `severity` /
  `assertion`); the `rules/*.md` files carry normalized frontmatter plus an
  `assertion:` line, and the prompt gains an explicit "Apply the rules" step.
- **`AnalyzeService` loads rules once and renders them twice.** Rules are read
  into a single `Rule` record and rendered into both `{RULES}` (full guidance)
  and `{SELF_CHECK_RULES}` (one assertion line each) from the same objects;
  the separate dev/jar loaders collapse into one `loadRules()`.

[v0.6.1]: https://github.com/mossgreen/design-is-code-app/releases/tag/v0.6.1

## [v0.6.0] - 2026-06-16

The analyzer prompt is rebuilt around two explicit invariants — "shape, not
content" and "one declared pattern per variance axis" — giving its design
judgment a principled, self-auditing foundation. The Claude subprocess no
longer uses `--dangerously-skip-permissions`; both the analyzer and sequencer
now run as pure prompt→JSON transforms via `--strict-mcp-config --tools ""`.
The model picker offers Opus 4.8 (replaces 4.7). `Optional<X>` return types
in resolver/rule-table matching are now unwrapped correctly, fixing a silent
variance-gap false alarm.

### Added
- **`disc.claude.timeout` and `disc.claude.effort` config properties.** Override
  the subprocess timeout (default 300 s, was 120 s) and Claude's reasoning
  effort (default `low`; raise to `medium`/`high` for deeper designs) in
  `application.yml` or via `-D` flags.
- **`./gradlew eval` task.** Runs the analyzer eval suite against the real Claude
  CLI in isolation from unit tests. Streams per-run summaries; artifacts land in
  `build/eval/`. Tune with `-Ddisc.eval.runs=N` and `-Ddisc.eval.passRate=0.N`.
- **`DesignContractValidator`** — a structured contract-level assertion harness
  for eval, replacing `DesignModelAssertions`. Validates participants, entities,
  variancePlan, and cases[] against contract rules rather than raw field equality.

### Changed
- **Analyzer prompt rebuilt around two invariants.** "Shape, not content" and
  "one declared pattern per variance axis" are now declared up front with worked
  examples, so every rule in the prompt derives from one of these invariants
  rather than appearing ad-hoc.
- **Safer Claude invocation.** Both `AnalyzeService` and `SequenceService` now
  run `--strict-mcp-config --tools ""` instead of `--dangerously-skip-permissions`.
  Single-completion prompt→JSON transforms never needed agent tools or MCP servers;
  disabling both removes the permission footprint and prevents stalled tool calls.
- **Timeout raised to 300 s and made configurable.** The 120 s limit was too
  tight for Opus on complex designs; 300 s is the new default.
- **Background stdout reader.** Stdout is now drained on a daemon thread before
  `waitFor()`, preventing a potential deadlock on outputs larger than the ~64 KB
  pipe buffer.
- **Opus 4.8 replaces Opus 4.7** in both model pickers (Analyze step and Generate step).
- **Rule prompt refinements.** `invariance`, `composition-over-inheritance`, and
  `R2-purpose-specificity` updated with tighter worked examples.

### Fixed
- **`Optional<X>` return types in resolver/rule-table matching.** A resolver
  whose method returns `Optional<StrategyInterface>` (correct Java for a
  map-lookup miss) was silently dropped from variance-gap checks and resolver
  sidecar generation. The new `unwrapOptional()` strips the wrapper before
  matching.

[v0.6.0]: https://github.com/mossgreen/design-is-code-app/releases/tag/v0.6.0

## [v0.5.0] - 2026-05-30

The Design step gets a design-intelligence upgrade: the analyzer commits to a
variance-handling pattern up front, auto-emits the matching decision-table
sidecars, validates each design against the DisC plugin before you save, and
surfaces AC-coverage gaps inline — so under-specified designs are caught at
authoring time, not at codegen. Also lowers the minimum JDK to 17.

### Added
- **Variance-handling pattern selection.** The analyzer picks one of four patterns
  (rule-table / resolver / sealed-polymorphism / pattern-matching) per variance
  axis and records it in a top-level `variancePlan`, with an exhaustive `mapping[]`
  for rule-table and resolver axes.
- **Auto-emitted decision-table sidecars.** Pure-function leaves and rule-table
  appliers get their `.decision.md` sidecars generated from per-AC-row examples —
  one row per acceptance criterion — feeding the plugin's filled-mode codegen.
- **Plugin validate-and-retry.** Step 2 runs the design through the DisC plugin's
  `--validate-only` mode and shows refusals inline, so contract problems are fixed
  before saving.
- **AC coverage on Step 2.** AC ↔ participant coverage plus a per-participant
  variance-axis-count chip, so under-specified or overloaded participants are
  visible while you design.
- **Model picker** for the Claude CLI calls.
- **Polymorphic-entity callees** — `interface`/`sealed-interface` entities with
  behaviors can be called directly in the sequence, plus a resolver `mapping[]` schema.
- **OS-native folder browser** on Step 1 for connecting a project.

### Changed
- **Wizard reflow** into Connect / Design / Sign-off / Generate, with AC rows,
  per-card purpose, auto-compose, and "Connect project" moved into Step 1.
- **Codebase-grounded analyzer** — fed the connected project's packages, glossary,
  and most-relevant existing types so it reuses them (`existingFqn`) instead of
  re-proposing.
- **Abstraction discipline** baked into the analyzer prompt (invariance,
  purpose-specificity, leaf freestandingness, feature-envy, composition-over-
  inheritance) plus `interface`/`sealed-interface` entity kinds.
- **Callee-anchored `@package` recommendation** on Step 4; plugin integration
  refactored behind a `CodeGenerator` abstraction.
- **Minimum JDK lowered to 17** (was 21). DisC Studio now builds and runs on Java 17 LTS.

### Removed
- **Multi-level design recursion** parked for MVP (single-level compose;
  `defer-design` trees documented but not auto-walked).
- **The two "Load demo" buttons** and their seeded data.

[v0.5.0]: https://github.com/mossgreen/design-is-code-app/releases/tag/v0.5.0

## [v0.4.2] - 2026-05-12

Hotfix on top of v0.4.1's downloadable jar: the demo no longer pretends a
project is connected (a hardcoded path that only existed on the author's
machine), and the Release ships a starter Spring Boot project so anyone
evaluating DisC Studio can complete the flow end-to-end without bringing
their own codebase.

### Added
- **`disc-studio-starter.zip`** attached to the Release — a minimal Spring
  Boot scaffold (Spring Initializr export, ~55KB) with one `com.example.demo`
  package and an empty `design/` folder. Unzip and point the Studio at it to
  evaluate the full save → run flow without an existing Java project.

### Changed
- **README leads with "What you need" before Quick start.** Three numbered
  requirements (Java 21+ · required; a Java/Spring project · required, with
  the starter as fallback; Claude CLI + plugin · optional) replace the
  parenthetical version note from v0.4.1. The reader knows what they're
  signing up for before downloading.

### Fixed
- **Demo no longer fakes a connected project.** "Load simple demo" /
  "Load complex demo" used to set `state.projectPath` to a hardcoded
  `/Users/mossgu/Downloads/demo` and run `/api/scan` against it, producing
  a red error banner for every user except the author. The demos now seed
  story + participants + sequence only; the header chip stays in "Connect
  project" mode until the user pastes a real path.

[v0.4.2]: https://github.com/mossgreen/design-is-code-app/releases/tag/v0.4.2

## [v0.4.1] - 2026-05-12

DisC Studio is now downloadable. Grab `disc-studio-0.4.1.jar` from the
Release page, `java -jar`, open `localhost:8080` — no clone or Gradle
required.

### Added
- **Downloadable jar.** `./gradlew bootJar` produces a single fat jar
  (`disc-studio-0.4.1.jar`, ~30MB) attached to the GitHub Release. Run
  with `java -jar disc-studio-0.4.1.jar` on any machine with Java 21+.

### Changed
- **README restructured around "download-and-run" first.** New Quick
  start section leads with the jar path. Running from source demoted
  into a Development section for contributors.

### Fixed
- **Composer step number off-by-N.** The "Add step N" composer was
  counting fragment markers (`loop`, `else`, `end`) and SUT boundary
  edges (`[*] -> SUT`, `[*] <-- SUT`) as steps, so "Step 9" would
  appear above a list whose last CALL badge read "7". Now counts CALL
  rows only, matching the badges.

### Removed
- **Dead `/api/disc-steps` endpoint.** The Java controller, the
  `loadDiscSteps()` JS indirection, and the on-disk skill bundle were
  serving a path that no longer had a frontend consumer. The run
  checklist now reads from a hardcoded `DISC_STEPS` constant in
  `app.js` (the run-event regex matches step numbers only, so a title
  mismatch couldn't break event mapping anyway). Net –80 lines.

## [v0.4.0] - 2026-05-12

The wizard grew up. It's now **DisC Studio** — the companion editor for
DisC. Designs are first-class authoring objects with decision tables,
explicit system-under-test marking, and a step composer you can actually
live in: one-line rows, click-to-edit pills, insert-anywhere wedges,
duplicate, hover-only delete, drag-reorder with a visible grip. Two demo
seeds (a 4-participant loop example and the full 10-participant order
flow) cover both ends of the complexity gradient.

### Added
- **Decision tables, first-class.** Any CALL step can be marked
  decision-table-backed via a `+ DT` chip on the step row. Click opens a
  modal editor with the method signature as a read-only header, a config
  form (`nullHandling`, `exceptionType`/`defaultValue`, `rounding`,
  `scale`, `locale` — the keys `java_spring.md` enumerates), and a
  freeform rows table. "Save to project" writes the `.puml` plus one
  `<Participant>.decision.md` sidecar per DT-backed call into the same
  `design/` folder.
- **System-under-test mark + entry interaction.** Each participant card
  shows a `+ SUT` chip. Marking auto-adds the entry interaction
  (`[*] -> SUT : method(...)`) and final return (`[*] <-- SUT : Type`).
  Single-method SUTs get the boundary steps instantly; multi-method SUTs
  prompt via an inline "pick entry method" banner on Step 2. Required
  for DisC v0.5.x — Step 1 refuses any `.puml` without exactly one
  `system_caller`.
- **Step composer overhaul** for read, write, and modify:
  - Each CALL renders on **one line** instead of two — the trailing
    return type is a muted inline suffix, halving vertical space. The
    13-step complex demo fits on a single screen.
  - Caller, callee, and method are **click-to-edit pills**. Click opens
    a small popover scoped to valid choices; Esc / outside-click
    dismisses. Method-edit is one click, not "delete + re-pick three
    dropdowns."
  - **Insert-anywhere wedges** between adjacent rows. Hover the gap
    between steps, click `+ insert here`, the composer relocates inline.
  - Per-row **duplicate (⎘)** button deep-copies the step including any
    attached decision table. Delete (×) and duplicate now hover-only to
    reduce idle noise.
  - Visible **6-dot grip** glyph advertises the drag-reorder affordance
    that was already there but invisible.
  - Composer's caller dropdown **prefills from the last CALL's caller**
    (the common "same orchestrator throughout" case).
- **Two demo seeds, side by side.** "Load simple demo" seeds a
  4-participant loop example (matches the `03_loop.puml` corpus).
  "Load complex demo" seeds the 10-participant order flow with three
  pre-populated decision tables (matches `06_order/PlaceOrder.puml`).
  First-timers can climb from one to the other.
- **Target-package autocomplete** on Step 4. Suggestions come from the
  unique `packageName`s in the scanned project. Free typing still works.
  The list is persisted to `localStorage` so it survives a page reload
  before reconnecting.
- **Plugin pre-flight gets an Update flow.** When the installed
  `design-is-code` plugin is older than the latest GitHub release, an
  "Update plugin" banner appears next to "Run it for me" with the new
  version + changelog link + a one-click installer. Skip-for-session
  also available.
- **Boundary box auto-fit.** Participant boxes in the live SVG measure
  their rendered text width (`getBBox()`) instead of guessing 8px/char,
  so long names like `LineSubtotalCalculator` never clip.

### Changed
- **Renamed to "DisC Studio"** (user-facing). `<title>`, `<h1>`,
  README all reframed: DisC owns codegen; the Studio owns design
  authoring. The Java package, Gradle artifact name, plugin slug, and
  repo URL are unchanged — this is a Tier-1 brand rename.
- **PlantUML emitter** uses the SUT-anchored arrow style from the
  canonical `.puml` corpus: returns emit `<--` (dashed) instead of
  `<-` (solid), and the boundary marker `[*]` always anchors the left
  side of every line — both for entry (`[*] -> SUT`) and final return
  (`[*] <-- SUT`). Visually distinguishes returns from forward calls.
- **DisC step-name display** synced to the v0.5.1 SKILL: `Validate
  Inputs` → `Validate Design`, `Classify` → `Classify Participants`,
  `Discover Context` → `Resolve Targets`, `Generate` → `Generate
  Tests`, `Quality Gate` → `Check Tests`, `Implement` → `Generate
  Implementation`. Step numbers unchanged. The run-event regex is
  number-only so live event mapping was unaffected; this is display
  only.
- **Participant cards** drop the noisy CALLER/IMPL header badges —
  premature surface for half-shipped affordances. Grid `minmax` raised
  from 13rem to 18rem so cards have room for typical method signatures;
  method line wraps within the card instead of ellipsizing.
- **Plugin-update flash** simplified. The post-update pill no longer
  says "restart Claude Code" (nothing needs restarting — each "Run it
  for me" spawns a fresh `claude` process that picks up the new
  plugin). Reads `DisC plugin updated to v<X> ✓` then settles to the
  normal status pill.
- **Story textarea placeholder** changed from a concrete example to
  the canonical three-part template `As a <role>, I want to <action>,
  so that <outcome>.` Teaches the shape, not just the tone.
- **Step 2 terminology cleanup**: `+ new class` → `+ new participant`;
  `N classes` counter → `N participants`. Matches the participant data
  model.
- **Modal copy**: "generate a stub class alongside the interface" →
  "also generate the implementation class alongside the interface."
  Stub was misleading — DisC emits a real implementation.

### Breaking
- **Hand-built designs need a SUT.** DisC v0.5.x refuses any `.puml`
  without exactly one `system_caller`. Loading either demo handles
  this automatically. For hand-built designs, click `+ SUT` on the
  participant that is your entry point — Studio adds the boundary
  steps for you. Pre-v0.4.0 designs saved before this release will
  need the SUT marked before they can be re-run.
- **The CALLER and IMPL badges on participant cards are gone.** No
  behavior change beyond visual — the underlying `implByDefault` flag
  is still stored on each participant.

[v0.4.1]: https://github.com/mossgreen/design-is-code-app/releases/tag/v0.4.1
[v0.4.0]: https://github.com/mossgreen/design-is-code-app/releases/tag/v0.4.0

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
