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