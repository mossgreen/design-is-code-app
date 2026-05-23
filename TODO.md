# Design is Code App — TODO

The app's only output is **one valid UML sequence diagram** that DisC consumes.
DisC itself handles project scanning, CREATE/UPDATE detection, classification, test generation and implementation. This wizard stays thin.

## Helper: Connect project (optional)
- [x] Backend scan endpoint — walks `src/main/java/**/*.java`, returns classes, interfaces, data types, methods
- [x] "Connect project" chip in the header — path input + scan
- [ ] Future: replace path paste with git repo connection or file picker
- [ ] Scan result powers autocomplete in Step 2 (class + type datalist) and Step 3 (collaborators)
- Rule: the chip is **never a gate**. Empty means user types freely; reuse is optional, not required (aligns with DisC supporting CREATE and UPDATE equally).

## Step 1: User Story
- [x] Textarea for natural-language user story
- [ ] Multimodal icons (voice / image / video) shown disabled — roadmap signal only

## Step 2: Entry Point
- [x] Class input with scan-powered typeahead, story-keyword boost
- [x] Package (autofills from scan match)
- [x] Method name + method picks from existing class
- [x] Parameters list
- [x] Return type (datalist of primitives + scanned types)
- [ ] Post-MVP: allow the user to describe the method in natural language and have the system propose a name

## Step 3: Collaborators (the core design step)
- [ ] One row = one call arrow. Each row captures:
  - **Callee** — `Abstraction` or `Implementation : Abstraction` (colon-split per DisC participant naming)
  - **Method**
  - **Input** — e.g. `order : Order`
  - **Return** — e.g. `savedOrder : Order` (absence = no return arrow)
- [ ] Add / remove rows
- [ ] Reorder via ↑ / ↓ buttons (drag-drop is post-MVP)
- [ ] Autocomplete callee from scan (interfaces first, then classes)
- [ ] Post-MVP: fragment markers (`alt`, `loop`, `throws`) — defer until the row model is stable

## Step 4: Preview
- [ ] Render the entry + arrows as a minimalist sequence diagram
- [ ] Participants row at top (derived from entry + unique callees)
- [ ] Read-only — edits go back to Step 3
- [ ] Post-MVP: team review / sign-off

## Step 5: Generate
- [ ] Emit the design as structured JSON matching DisC's expected sequence-diagram shape
- [ ] Show the JSON + a copy button (MVP)
- [ ] Post-MVP: POST to backend → backend runs the DisC skill → stream back tests + implementation
- [ ] Post-MVP: export / push to repo

## Open questions
- Step 3 fragments (alt / loop / throws): how to represent visually without cluttering the row? (open)
- Step 4 rendering: hand-built HTML/CSS vs. a diagram library? (MVP = HTML/CSS)
- Backend-to-DisC handoff: shell out to the `claude` CLI with a crafted prompt, or expose an HTTP wrapper around the skill? (post-MVP decision)


## manual entered

in step 4, if we identify a participiant is not in an interaction, it's a leaf node, then we need to let user to decide, is it pure function. if it's pure function, then we need to provide a decision table.

## Design decisions

A running log of non-obvious architectural choices, what they imply, and what
they rule out. Append new entries on top of older ones in each subsection.

### Codebase analysis (Step 1 → server scan)

- **JavaParser 3.26.1, not Eclipse JDT or reflection.**
  Source-parsing AST library. Reflection would need the user's compiled
  classes on our classpath — brittle for a tool that scans *other people's*
  projects. Eclipse JDT can do the same job but needs more scaffolding;
  JavaParser is one call (`parser.parse(file)`) and was already a dependency.
  Set to `JAVA_21` so records/sealed/pattern syntax parses on modern repos.

- **Walk `src/main/java/**` only.** Skip tests, `build/`, generated sources,
  multi-module gradle output. Production code is what the analyser cares about.

- **Per-file parse failures are counted, not thrown.** One corrupt `.java`
  shouldn't kill a 500-file scan. Tracked as `skippedCount` in the response.

- **Heuristic role classifier, not ML or runtime introspection.**
  Cascade: annotations win first (`@Entity`/`@Service`/`@Repository`/...) →
  naming suffix (`*Request`/`*Response`/`*Dto`/`*Mapper`) → structural
  (extends `*Exception` → exception; record with one field → domain-primitive)
  → fall back to `other`. Wrong sometimes, but cheap, deterministic, and
  good enough that "entity vs service vs repository" calls are trustworthy.

- **First Javadoc sentence as `purpose`, capped at 140 chars.** Human-written
  intent is the highest-quality "why this exists" signal available. Full
  Javadoc is too verbose for prompt budget; full sentence is too noisy.

- **`pkg` not `package` in the DTO.** `package` is a Java reserved word.
  Serialises as `pkg` in JSON; the prompt-rendering layer relabels it
  "package" in the markdown that reaches the LLM.

### AI grounding (catalog → analyser prompt)

- **Three-tier catalog: summary (always-on) + filtered detail (top-K).**
  Full type list on a 500-type monorepo is ~40K tokens — would blow the
  context window. Split into a compact summary (`packages` + `glossary` +
  `conventions`, ~few hundred tokens) that's always sent, plus a per-story
  filtered top-K of detailed types. Two independent dials for token budget.

- **Lexical scoring, not embeddings or vector retrieval.**
  Story tokenised (lowercase, length ≥ 3, stopwords removed). Score each
  type: +5 per camelCase-split name-token match, +2 per method-name token,
  +1 per purpose word, ×1.3 for high-signal roles (service/entity/repo/VO),
  ×0.7 for low-signal (dto/controller/config/exception). Zero scores
  dropped, top 20 kept. Deterministic, ~ms, no model dep. **Trade-off:**
  synonym misses (story says "basket", code has `ShoppingBag` → no
  match). Acceptable for v1 since the user can rename in Step 2. Revisit
  embeddings only if synonym misses become a real complaint.

- **Top-K = 20, hardcoded.** Empirical fit: each rendered `TypeRecord` is
  ~80 tokens of markdown, so 20 ≈ 1.6 KB — leaves ~3-4 KB of prompt budget
  for everything else. Dynamic budget tuning is overkill until we see real
  prompts overflow.

- **`existingFqn` is OMITTED, never set to `null`.** The analyser-output
  schema rule. JSON-null on an absent field is ambiguous (LLM might emit
  it always); explicit omission is a strong signal "no reuse here".

- **Conservative reuse: "suggest, never force".** Prompt rule:
  reuse only when name + role + signature plausibly match; prefer the
  interface over `*Impl`; when in doubt, propose new. The opposite
  ("aggressive reuse") was offered to the user — they picked conservative
  to avoid force-fitting `OrderService` into a meeting use case.

- **Catalog round-trips through the client, not server-cached.**
  `state.codebaseCatalog` lives in the browser. The analyse POST sends
  `{context, catalog}`. No server-side session, no staleness window, no
  multi-user cross-talk. Re-scan = re-send.

### Frontend reuse wiring (analyser output → participant cards)

- **Catalog wins over LLM for reused types.** When a tree node has
  `existingFqn` and that FQN exists in the catalog, `flattenTreeToParticipants`
  pulls `methods` and `purpose` from the catalog — discards the AI's
  `behaviors` for that node. The LLM hallucinates method signatures; the
  real type doesn't.

- **`implByDefault = false` on reused participants.** Downstream impl
  generation should not regenerate code that already exists. Manual-add
  and new-from-AI participants keep `implByDefault = true` (the default).

- **Visual reuse marker = slate `#64748b` left-border + monospace FQN chip.**
  Deliberately not blue (clashes with `.caller`) or purple (clashes with
  `.is-sut`). Neutral grey reads as "ambient property" rather than "active
  state". Same family as the SUT chip but muted.

### Folder picker (Step 1 input)

- **Server-backed directory listing, not browser File System Access API.**
  Browsers deliberately hide absolute paths from web pages — `showDirectoryPicker`
  returns a handle, `<input webkitdirectory>` returns `webkitRelativePath`.
  Neither can produce `/Users/.../my-project` which the scan endpoint needs.
  Since Spring runs on the user's machine (localhost), a `GET /api/fs/list`
  is safe and yields real paths.

- **Popover anchored to the input, not modal or sidebar tree.**
  Inline flow matches the rest of Step 1; modal is overkill for a quick
  path pick; sidebar tree eats horizontal space we'd rather give to step
  content. Popover wraps the stepper at narrow viewports.

- **Whole-filesystem scope (default-hidden dotfolders) over a `$HOME` sandbox.**
  Standard for dev tooling — projects live anywhere. The user toggle
  "Show hidden" handles dotfolders for the rare case.

### Sequence diagram (Step 2/3 live render)

- **Custom inline SVG renderer, not the PlantUML server or a JS library.**
  PlantUML server is the obvious move but means an external HTTP call per
  render, theming friction (PNG output), and an extra failure mode. The
  custom SVG is ~200 lines, themable via CSS variables, renders
  instantly, and supports our fragment grammar (loop/while/foreach/alt/
  opt/par) natively.

- **`padX` adapts to the half-width of the first and last lifeline boxes.**
  Originally hardcoded 60px. Wide names like `CartAdditionUseCase` poked
  past the viewBox. `padX = max(60, firstHalf + 16, lastHalf + 16)` keeps
  the layout symmetric (so the fragment-bracket math at L2465 stays
  unchanged) while preventing clipping at both ends.

### Wizard chrome / UX

- **Single-row header (brand + stepper), tagline below brand.**
  Saved ~80px of vertical space vs the original two-row layout.
  `justify-content` is `flex-start` (not `space-between`) so the stepper
  sits next to the brand instead of being pushed to the far right.

- **rAF `window.scrollTo(0, 0)` at the tail of `goToStep`.**
  Step 2's Add-Step composer uses `<input autofocus>`, which the browser
  scrolls into view — parked the page at the bottom of the new step.
  `requestAnimationFrame` runs after the browser's autofocus scroll, so
  our reset wins reliably.

- **Single styled separator (`.as-dot`) between class and method pills.**
  Bug fix: the method-pill text used to be ``.${name}(args)`` AND a
  separate ``<span class="as-dot">.</span>`` rendered the separator —
  visible as `Class . .method(...)`. Choice: the styled span is the
  intended separator; the method-pill text should be `name(args)` with
  no leading dot.

- **Step 3 SUMMARY shows AI's `purpose`, falls back to method names.**
  The AI already produces one-sentence purposes per node (it was being
  thrown away in `flattenTreeToParticipants`). Surface them. Manual-add
  participants have no purpose, so fall back to the previous method-list
  display rather than render a bare em-dash.

- **Team signoff: hardcoded names, in-session persistence, click-handler guard.**
  Ceremony, not real authorization. Boxes persist across step-back
  navigation (less friction) but reset on page reload. The Generate
  button is `disabled` *and* the click handler re-checks `allSignedOff()`
  — belt-and-suspenders against devtools tampering / Enter-on-form.

- **SUT auto-marked on the root participant after AI analyse.**
  Domain-correct default — the use-case orchestrator (tree root) is by
  convention the System Under Test. `setSut` is idempotent and shared
  with the manual click path; manual-add flow never auto-marks.


## Multi-level design (parked for MVP — restore post-PMF)

This capability is **critical to the product long-term**. It was implemented
through several iterations (sub-design stack, manifest tree, build-status
walker, AC inheritance) and then cut wholesale for MVP because demos rarely
surface it. This section preserves the intent so a future revive starts
from an informed position, not a from-scratch redesign.

### Capability description

The wizard models orchestrator participants as deferred sub-designs.

- When the analyzer marks a participant `isLeaf: false` (because it exceeds
  the 2-axis complexity budget defined in [analyzer.md](src/main/resources/prompts/analyzer.md),
  or carries its own internal call graph), the user can "Design this level"
  to drill in.
- A new wizard run opens with:
  - That participant as the SUT.
  - The parent's AC subset inherited, filtered by `acIndices` (the
    AC-inheritance logic that closes the loop).
  - The parent's call signature on the child captured as the entry-point
    method.
- The sub-design produces its own .puml file under a nested folder, parented
  to the original via a manifest tree (`_index.json`).
- Recursion stacks arbitrarily: sub-designs can have their own orchestrators
  that drill further.

### Why it matters

The 2-axis budget per participant is a hard rule because Java test classes
hit cognitive overload at >2 levels of `@Nested`. Once a real domain has
3+ axes anywhere, multi-level recursion is the **only** way to keep each
test class within budget. Without it, complex domains compile into single
oversized designs that defeat the discipline.

### Why we cut for MVP

- Senior-dev demos are one-shot ("here's a story; here's clean Java").
  They don't surface 3-axis domains in 30 seconds.
- Implementation cost was high: 2 controllers, 2 services, 4 DTOs,
  contract-drift hashing, build-status walker, tree UI, manifest
  persistence, sub-design stack.
- Demo-time benefit was approximately zero.
- Bringing it back AFTER core PMF is the right sequencing.

### Artifacts to restore when reviving

Backend (deleted):
- `controller/TreeController.java`
- `controller/BuildStatusController.java`
- `service/TreeService.java`
- `service/BuildStatusService.java`
- `dto/TreeLoadRequest.java`
- `dto/TreeSaveRequest.java`
- `dto/BuildStatusRequest.java`
- `dto/Manifest.java`
- Manifest-write paths inside `service/DesignService.java` and parent-relative-path handling in `dto/DesignRequest.java`

Frontend (deleted from `static/js/app.js`):
- `subDesignStack`, `subDesignContext` declarations
- `snapshotWizardState()`, `exitSubDesign()`, `startSubDesign()`
- `fetchContractHash()`, `relativeUp()` helpers
- The whole `#tree-view-list` rendering + `tree-design-this` click wiring
- The Build-all walker + per-node build-status dots
- The `inSub` branch in `goToStep()`

HTML (deleted from `static/index.html`):
- `#tree-view-list`, `#build-all`, `#build-all-progress`, `#build-all-nodes`
- "Design this level" buttons
- "Back to parent design" affordance

CSS (deleted from `static/css/style.css`):
- `.tree-list`, `.tree-row-*`, `.tree-design-this`, `.tree-chevron`,
  `.build-all-*` rules

Persistence format (no code, but the convention):
- Nested folder structure: `parent.puml` → `parent/Child.puml` → `parent/_index.json` linking them.

Critical slice that goes with this revival:
- **Slice C (commit `e9b3bf8`)**: the `inheritedAc` derivation inside
  `startSubDesign`. This is the AC-inheritance logic that closes the
  multi-level loop. Restore it exactly when bringing back multi-level.

### Open questions for the revival

- **Persistence format**: keep the manifest-as-JSON-sidecar (`_index.json`)
  or fold parent/child relationships into a single `.puml` stereotype
  (`<<@parent:...>>`) so the wizard stops needing a separate manifest
  file? The latter would simplify save/load but couple .puml to the
  parent/child concept.
- **Drift detection**: re-introduce contract-drift hashing
  (`parentContractHash`), or replace with simple file-mtime checks?
  Hashing is more accurate but more expensive.
- **Entry-point UX**: surface "Design this level" on the orchestrator
  participant CARD in Step 2 (where the user already is), instead of
  buried in a Step 3 tree view? See slice G below for context.

### What's still in place that the revival can build on

- The discipline that triggers the need for multi-level is intact:
  `acIndices` per participant (slice B, commit `c6798e2`) + the 2-axis
  rule in [analyzer.md](src/main/resources/prompts/analyzer.md).
- The analyzer already emits `isLeaf: false` as a hint when a participant
  would overflow — the wizard just doesn't drill in. A future revive
  re-wires that hint to a clickable affordance.
- Participant model carries `acIndices`; `flattenTreeToParticipants` still
  reads and propagates it.

---

## UI improvement roadmap (post-discipline iterations)

After slices A–D (analyzer discipline + abstraction kinds + axes chip +
AC↔participant cross-highlight), the wizard's reasoning is increasingly
visible. The next slices, in rough priority order, make the rest of the
discipline transparent and reduce visual clutter.

### Slice E — Variance pattern badges on participant cards

Each participant gets a small badge: `rule-table` / `resolver` /
`polymorphism` / `pattern-match` / `n/a`. Derived from a new analyzer
output field (`pattern` per tree node) so the wizard surfaces *which*
of the four variance-handling patterns from analyzer.md applies to
each participant. Teaches the discipline without forcing the user to
read the prompt.

### Slice F — Step 3 redesign as analytical design-checks

Replace the four named-reviewer checkboxes (peter / john / chen / wang)
with concrete checks computed from the design itself:

- AC coverage (every AC row has ≥1 carrier — from slice D)
- Orchestrator linearity (no branches at the root)
- No orphaned entities (every entity is referenced by some participant signature)
- Axes within budget (every participant has ≤2 axes)
- Sealed-interface variants ≥ 2 (no one-permit sealed families)
- Reused types resolve in the catalog

Sign-off becomes signing off on the checks, not on each other. The
"four reviewers" idea was always ceremony; the discipline checks are
what actually matter.

### Slice G — Sub-design drill-in surfaced on Step 2

Move the "Design this level" affordance from Step 3's tree view to
orchestrator participant cards in Step 2 directly. Users iterate on
Step 2; the multi-level capability should be reachable where they
work. Optional onboarding banner the first time an orchestrator
appears: "X participants are orchestrators — design them in sub-flows."

### Slice H — Chip consolidation pass

Visual-density audit. Each participant card carries up to 4 chips
(kind, axes, SUT, FQN); each entity card up to 3 (kind, provenance,
FQN). Signal-to-noise is dropping. Options:

- Collapse `kind` + `provenance` into a single role badge with
  hover-for-details
- Use border-style / colour to encode kind instead of a chip
- Cap chip count per card at 2 visible + an overflow indicator

### Slice I — Manual edit of `acIndices`

Let the user click an AC row and toggle which participants carry it
(checkbox grid in a small popover, or drag-and-drop). Currently
`acIndices` is read-only from analyzer output; user edits would let
them correct mis-mappings without re-running the analyzer.

### Slice J — Real-time discipline feedback

As the user edits Step 2 fields, surface inline hints:

- ">5 participants at this level" — recommend decompose
- "no SUT marked" — every chain needs one
- AC row with empty `Then` — won't constrain the design
- Method signature with > 3 args — consider grouping into a record

Cheap to compute, debounce-aware, visible only when triggered.