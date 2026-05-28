You are decomposing a software requirement into a tree of named abstractions
for a Java/Spring system. The output is consumed by an automated tool — JSON
shape must be exact.

# Input

A user requirement, free text:

```
{CONTEXT}
```

# Acceptance criteria

Each row below is a Gherkin-style constraint on the design. When deciding
which abstractions to propose and how they collaborate, ensure the resulting
participants and (later) sequence demonstrably satisfy **every** row.
Treat each `Given … when … then …` as a constraint, not a flow specification:

- A row's *Given* clause may imply a participant whose responsibility is the
  state described (e.g. "Given the calendar is loaded" → a `CalendarRepository`).
- A row's *When* clause typically maps to a behaviour on an existing
  participant (e.g. "When a slot is proposed" → a `proposeSlot()` method on
  the orchestrator).
- A row's *Then* clause is the postcondition the design must guarantee —
  if no proposed participant could produce it, add or rename one until they
  can.

{ACCEPTANCE_CRITERIA}

# Abstraction discipline (read before producing any output)

A design describes the SHAPE of a system — its contracts, responsibilities,
and collaborations. The implementation supplies the CONTENT — the specific
values, thresholds, and branches that satisfy those contracts. A design
that names content in its prose has confused the two.

Acceptance criteria are samples of content the design's shape must admit.
They are evidence, not blueprints.

## The invariance test

Before writing any `purpose` field or any sentence of the `story`, ask:
*would this sentence need to change if the implementation grew — a new
case added, a new threshold introduced, a new variant appearing?*

If yes, the sentence is about content; rewrite it to describe shape.
If no, keep it.

A design's prose reads true across all valid implementations of the
same shape.

## Three places this applies

1. **`purpose` fields name responsibilities.** Every `purpose` answers
   *what does this thing hold responsibility for?* — in domain nouns
   and verbs. It identifies the kinds of inputs the operation consumes
   and the kind of output it produces. It never enumerates specific
   input values, output values, thresholds, branches, or variant
   identifiers.

2. **Method names name operations.** A method name is a verb
   describing the operation. The varying input is a parameter; the
   parameter — not the method's name — distinguishes one case from
   another. One method per operation, regardless of how many cases
   the parameter can take.

3. **`story` narrates participants and flow.** The story describes
   which participant collaborates with which and what each contributes,
   naming only participants and entities. It does not quote values
   exchanged between them, name branches taken inside them, or
   paraphrase the rule tables.

## A `purpose` is a user need, not a function description

A `purpose` answers *what need does this abstraction exist to meet?* —
not *what does this abstraction do?* Function descriptions name the
mechanism; purposes name the need the mechanism serves.

Three criteria every `purpose` must satisfy:

1. **Need-focused.** The purpose names a need (of the user, or of the
   calling participant), not the operation that satisfies it.
   - Mechanism (wrong): "computes the earliest overlap of free slots."
   - Need (right):      "guarantees every attendee can attend the booked time."

2. **Specific to this abstraction.** The purpose distinguishes this
   participant from every other in the design. If two purposes are
   paraphrases of each other, at least one participant is misplaced.

3. **Evaluable.** Reading the purpose, you can ask "did this design
   meet that need?" and get a yes/no.
   - Evaluable:     "allow undeletion."
   - Not evaluable: "makes the system safer."

Reframe trick: if your draft purpose names an operation (verb on data),
ask what NEED that operation serves and rewrite as the need. Canonical
example: `Trash`'s purpose isn't "softly removes files," it's "allow
undeletion."

## Variance is governed by the patterns below

When the AC implies variance — different cases producing different
outcomes — choose ONE pattern per axis using the rules in the
"Variance-handling patterns" section below. The default priority is
rule table > resolver > sealed polymorphism > pattern matching.

Under every pattern, the names of specific kinds, the rule values, and
the branch conditions never appear in any `purpose` field or `story`
sentence — that invariance from rules 1–3 above is unconditional.

## Self-check before returning

Before returning, walk the design against every rule below. Each rule
is **unconditional** — when a rule fires, rewrite the offending field
before emitting. Do not surface lint; produce a design that already
satisfies the discipline.

1. **Invariance.** Every `purpose` and every sentence of `story` passes
   the invariance test — if any sentence would need to change to
   accommodate a hypothetical new case in the implementation, rewrite
   it. See the "invariance" rule below for examples.

2. **Leaf freestandingness.** No leaf participant's `purpose` names
   another participant. Leaves must be describable in isolation — if
   a leaf needs to name its caller to make sense, the leaf is misplaced.

3. **Purpose specificity (R2).** Every `purpose` is need-focused,
   specific to this abstraction, and evaluable. Rewrite any purpose
   that joins two needs with "and", names a mechanism instead of a
   need, paraphrases another participant's purpose, or hides behind
   vague qualifiers. See the "R2" rule below.

4. **Feature envy (R4a).** No participant's method writes to fields of
   an entity it doesn't own. For every entry in `behaviors[].touches[]`
   with `mode: "write"`, the target entity's `ownedBy` must equal the
   participant's `name`. When it doesn't, move the operation onto the
   owner, reassign ownership, or downgrade the touch to a read. See
   the "R4a" rule below.

5. **Composition over inheritance.** When two abstractions share
   behaviour or data, model the sharing through delegation, not
   through a type hierarchy. No participant `purpose` may frame
   itself as a "specialised variant of" or "subtype of" another
   participant; no entity's role in the design may rely on implicit
   extension. The variance-priority list above codifies this — the
   first two patterns (rule table, resolver) are pure composition,
   and you only reach for sealed polymorphism when the lower-numbered
   patterns' criteria genuinely fail. See the "composition-over-inheritance"
   rule below.

6. **Variance plan consistency.** Every `variancePlan` entry has
   matching shape in `participants[]`/`entities[]`. `rule-table` → a
   `Repository` + `Applier` shape (or method on the orchestrator)
   exists; NO `sealed-interface` entity for that axis. `resolver` →
   an `XxxResolver` participant exists, AND a `kind: "interface"`
   entity (the StrategyInterface) with non-empty `behaviors[]` and a
   `permits[]` list of N `class` entities exists, AND the resolver's
   `mapping[]` is present and exhaustive over those permits.
   `sealed-polymorphism` → a `kind: "sealed-interface"` entity with
   non-empty `behaviors[]` and a `permits[]` list of variant records
   exists. `pattern-matching` → a `kind: "sealed-interface"` entity
   with EMPTY `behaviors[]` and a `permits[]` list of pure-data
   records exists. Rewrite anything that contradicts the plan — do
   not weaken the plan to match a sloppy design.

The full rule bodies — including worked examples — appear at the end
of this prompt under "Rule details", composed in from
`prompts/rules/*.md`. Treat the four checks above and the rule bodies
as one tier of discipline: silent, mandatory, applied before emission.

# Variance-handling patterns

For each variance axis the AC exposes, choose ONE of the four patterns
below. Each pattern produces a specific participant shape; mixing
patterns within one axis fragments the design.

## The four patterns

### 1. Rule table — variance as data

The cases are rows in a table (config, database, hardcoded list). Code
is constant; adding a new case adds a row.

Choose when: cases differ only in data values (thresholds, percentages,
windows, eligibility predicates). The case set can grow without new
code.

Participant shape:
- A `Repository` participant (`kind: "reuse"` if it already exists in
  the codebase; else `kind: "leaf"`) exposing a `find(...)` method that
  returns the applicable rule.
- An `Applier` leaf (or a method on the orchestrator) that consumes the
  rule and produces the outcome.

No `sealed-interface` entity is needed for this pattern — the
discriminator is a plain enum or reused value type.

The rule record itself MUST appear as a `kind: "record"` entity in
`entities[]` (its fields hold the per-discriminator values — windows,
percentages, thresholds, etc.). The `variancePlan` entry for this
axis MUST include an exhaustive `mapping[]` of `{ key, expected }`
rows (one row per discriminator value found in the AC); `expected`
carries the rule record's field values for that discriminator. See
"Mapping (resolver and rule-table)" below for the row schema.

### 2. Resolver — variance as pluggable processors

The cases are N implementations of a common interface, selected at
runtime by a key.

Choose when: each case is a full operation (not just data). The variants
are interchangeable at the same call site, selected by an external key.

Entity & participant shape:
- A `XxxResolver` participant exposing `resolve(key) → StrategyInterface`,
  `isLeaf: true`. The resolver participant has exactly one method.
- A `StrategyInterface` entity (kind: `interface`) declaring the strategy
  operation's contract in `behaviors[]` (typically one behavior), with a
  `permits[]` list naming the N strategy class entities.
- N strategy entities of `kind: "class"` (one per variant), each listed
  in the interface's `permits[]`. Each strategy class is an entity in
  `entities[]`, NOT a participant — they are leaf implementations of the
  contract, treated like sealed-family variant records but as regular
  classes so they can carry Spring stereotypes and infrastructure
  dependencies the user supplies.
- The orchestrator's sequence dispatches polymorphically to the
  StrategyInterface entity in ONE arrow; do not enumerate variants as
  separate arrows from the orchestrator.

Shape sketch (abstract placeholders, no domain content):

```
participants:
  - { name: "Orchestrator",   isLeaf: false }   # SUT — the orchestrator
  - { name: "StrategyResolver", isLeaf: true,
      behaviors: [ { name: "resolve", args: [{name:"key", type:"KeyType"}],
                     returns: "Strategy" } ] }

entities:
  - { name: "Strategy", kind: "interface",
      behaviors: [ { name: "perform", args: [{name:"input", type:"Input"}],
                      returns: "Output" } ],
      permits: ["StrategyA", "StrategyB"] }
  - { name: "StrategyA", kind: "class", fields: [] }
  - { name: "StrategyB", kind: "class", fields: [] }

variancePlan entry:
  { axis: "key → Strategy", pattern: "resolver", criterion: 2,
    rationale: "...", mapping: [{key:"K_A",strategy:"StrategyA"},
                                {key:"K_B",strategy:"StrategyB"}] }
```

### 3. Sealed polymorphism — variance as data-with-behaviour

The cases are a sealed family of records, each owning its own
implementation of a common method.

Choose when: the variance genuinely belongs ON a domain noun — the
behaviour is part of the noun's identity (each variant has its own
operation tied to its data).

Participant shape:
- A `sealed-interface` entity in `entities[]` with `behaviors[]`
  declaring the contract.
- N `record` entities in the same `entities[]` array, listed in the
  parent's `permits[]`, each implementing the contract.
- The caller invokes `entity.method(...)` directly — no branching at
  the call site.

### 4. In-method pattern matching — variance as a local switch

The cases are a sealed family of pure-data records (no per-variant
behaviour), and the caller `switch`es over them in its method body.

Choose when: variance is local to ONE method, behaviour doesn't belong
on the variants, the case set won't grow.

Participant shape:
- A `sealed-interface` entity with EMPTY `behaviors[]` (pure sum type)
  and `permits[]` listing record variants.
- The caller's method body owns the switch — this spends ONE level of
  the caller's complexity budget (see below).

## Selection priority

For each variance axis, ask in order; pick the first whose criterion
holds:

1. Can the variance be expressed as data with a constant code path?
   → **rule table**.
2. Are the variants interchangeable processors selected by an external
   key?
   → **resolver**.
3. Does the behaviour conceptually belong on a domain noun?
   → **sealed polymorphism**.
4. Is the variance a closed sum used at one site, with logic that
   doesn't belong on the variants?
   → **in-method pattern matching**.

Lower-numbered patterns have lower coupling and lower test-nesting cost.
Only step to a higher number when the lower one's criterion genuinely
fails.

## Complexity budget per participant

A single participant owns AT MOST 2 independent variance axes in its
method body. Count axes by clustering AC rows:

- Each distinct `Given` condition pattern is one axis.
- Each distinct `When` condition pattern is another axis.

If a participant would need more than 2 axes, mark it `"isLeaf": false`
(orchestrator) — the user is reading this signal to decide whether the
abstraction is carrying too much, and to consider redistributing
responsibilities across participants.

This budget corresponds to the DisC plugin's 2-level test-nesting limit:
each axis the participant owns becomes one `@Nested` class in its test.
Past two, the test class becomes hard to read.

## The orchestrator must be linear

The root participant's method body is a LINEAR sequence of calls to its
collaborators. No `if`, no `switch`, no ternary at the orchestrator
level. Every branch at the orchestrator's level is a sign that a
variance axis was not delegated to one of the four pattern hosts above.

Branches live in:
- The rule table's lookup (data, not code).
- The resolver's map lookup (data, not code).
- The variant record's polymorphic method (invisible at the call site).
- The pattern-matching method body of a single non-root participant
  (one level of test nesting; used sparingly).

# Existing codebase (optional)

These types already exist in the user's project. When one of them
*already fulfils* the role of a node you would otherwise propose, **reuse
it**: keep its exact `name` and set `existingFqn` to its fully-qualified
class name. When in doubt, propose new and omit `existingFqn`. Never
force-fit (e.g. don't reuse `OrderService` for a meeting use case just
because nothing else matches).

## Summary

{CODEBASE_SUMMARY}

## Types (most relevant to the story)

{CODEBASE_TYPES}

# Task

Produce a flat list of participants. Each participant is an interface — a
named concept with a one-sentence purpose, optional attributes, and
behaviours (methods).

One participant is the **SUT** (system under test) — the use-case entry
point that the caller invokes. The rest are its direct collaborators.
Name the SUT explicitly via the top-level `sut` field; list every
collaborator alongside it in `participants[]`. The wizard composes the
call sequence between them in a separate pass — your job is to identify
WHO, not WHO-CALLS-WHOM.

## Termination rule — when to mark a participant `"isLeaf": true`

Mark a participant `"isLeaf": true`:

- It maps to a **pure function** (e.g. `validate`, `normalise`, `format`,
  `parse`). Pure functions have no collaborators.
- It maps to a standard Spring **stereotype** that doesn't itself collaborate
  with sibling abstractions in this design — e.g. `@Repository` (talks to a
  DB), `@Controller` (handles HTTP), `@Configuration` (provides beans). The
  thing it talks to (DB, HTTP) is not modelled here.
- It maps to **a single method on an existing JDK / Spring type** (e.g.
  `RestTemplate.postForObject`, `Files.write`). Don't model the platform.

Prefer 2–5 participants total (SUT + 1–4 collaborators). If you're tempted
to add a 6th, consolidate two of the existing ones or stop.

## Orchestrator vs leaf — when to leave a node non-leaf

If a node represents a custom abstraction with its own internal call graph
(it would orchestrate further collaborators when implemented), leave it
**non-leaf** (`isLeaf: false`). The wizard surfaces this as a reader hint
on the participant card so the user can see at a glance which abstractions
carry internal complexity vs. which are terminal.

A participant whose AC subset spans more than 2 variance axes is by
definition an orchestrator (`isLeaf: false`). See "Complexity budget per
participant" in the Variance-handling patterns section.

# Output

**Strict JSON. No prose. No markdown fences. The very first character of your
output must be `{` and the very last must be `}`.**

The top-level shape has FIVE fields:

```
{
  "variancePlan": [ ...one entry per variance axis; [] when the AC has no variance... ],
  "sut":          "PascalCaseSutName",
  "participants": [ ...the per-participant shape below... ],
  "story":        "...",
  "entities":     [ ...record/enum/class entries the participants pass around... ]
}
```

## `variancePlan` — declare your pattern choice before producing the design

For each variance axis the AC exposes, walk the priority list in
"Variance-handling patterns" (above) in order — ask criterion 1 first;
only if it fails consider 2; only if 1 and 2 fail consider 3; only if
1, 2, and 3 fail consider 4 — and record the pick.

Each entry:

```
{
  "axis":      "<short discriminator → output(s)>",
  "pattern":   "rule-table" | "resolver" | "sealed-polymorphism" | "pattern-matching",
  "criterion": 1 | 2 | 3 | 4,
  "rationale": "one sentence; genuinely justify why this pattern fits, not just restate the criterion text",
  "mapping":   [ ... ]   // REQUIRED for "resolver" and "rule-table"; omit for "sealed-polymorphism" and "pattern-matching"
                         //   resolver row:    { "key": "<keyValue>", "strategy": "<StrategyClassName>" }
                         //   rule-table row:  { "key": "<keyValue>", "expected": { "<recordField>": <value>, ... } }
}
```

### Rules for `variancePlan`

- **One entry per variance axis.** A variance axis is a distinct
  "Given X / When Y" pattern in the AC that produces different
  outcomes across cases. Most ACs have 0–2 axes. If the AC has no
  variance — every row reaches the same outcome through the same
  shape — emit `[]`.
- **Walk the priority list honestly.** Lower-numbered criteria have
  lower coupling and lower test-nesting cost. Pick the first whose
  test holds.
- **Commitment contract.** The `participants[]` and `entities[]` you
  produce below MUST be consistent with the patterns you declare here:
  - `rule-table` → a `Repository` + `Applier` shape (or method on the
    orchestrator) PLUS a `kind: "record"` entity for the rule itself
    (its fields hold the per-discriminator values). The Repository's
    `find(...)` method returns that record. NO `sealed-interface`
    entity for this axis. The variance entry MUST carry `mapping[]`
    (see "Mapping (resolver and rule-table)" below). The Applier
    participant MUST be `isLeaf: true` and its `apply(...)` behavior
    MUST carry a `cases[]` array (one row per AC row) so the wizard
    auto-emits the applier's decision-table sidecar — see
    `behaviors[].cases` below.
  - `resolver` → a `XxxResolver` participant exposing
    `resolve(key) → StrategyInterface` PLUS a `kind: "interface"`
    entity (the StrategyInterface) with non-empty `behaviors[]` and a
    `permits[]` list of N `class` entities. The strategies are entities,
    NOT participants. See the Resolver pattern's "Entity & participant
    shape" section above for details.
  - `sealed-polymorphism` → a `kind: "sealed-interface"` entity in
    `entities[]` with non-empty `behaviors[]` and a `permits[]` list
    of variant records, also in `entities[]`.
  - `pattern-matching` → a `kind: "sealed-interface"` entity with
    EMPTY `behaviors[]` (pure sum type) and a `permits[]` list of
    pure-data records.
- **Mapping (resolver and rule-table).** When `pattern: "resolver"` or
  `pattern: "rule-table"`, the `mapping[]` field is REQUIRED and must
  be exhaustive over the discriminator values present in the AC. The
  frontend uses these mappings to auto-emit the corresponding
  decision-table sidecar.
  - **Resolver rows** — `{ key, strategy }`. Every value in the
    StrategyInterface entity's `permits[]` MUST appear exactly once as
    a `strategy` value (exhaustive over the permits); every `key`
    value MUST be a valid input value for the resolver's input
    parameter (typically an enum constant name).
  - **Rule-table rows** — `{ key, expected: {...} }`. Each row carries
    the rule record's field values for one discriminator. The
    `expected` object's keys MUST match the rule record entity's
    `fields[].name` set exactly (same names, same set — no extras, no
    omissions). The `key` value MUST be a valid input value for the
    Repository's `find(...)` method's discriminator parameter. Values
    in `expected` are scalars (numbers, strings, enum constant names
    as strings) — not formulas. Conditional logic (e.g. "within
    window") is NOT a discriminator value and does NOT appear in
    `mapping[]`; it belongs in the downstream Applier's body.
- **No rationalisation.** `rationale` is a one-sentence justification
  the user can audit. If you cannot honestly justify the pick, the
  pick is wrong — walk the priority list again.

## `participants` — flat list, each entry one participant

Each participant:

```
{
  "name":         "PascalCaseTypeName",
  "existingFqn":  "com.foo.order.OrderRepository",   // ONLY when reusing an existing codebase type; OMIT otherwise
  "purpose":      "one sentence naming the user need this abstraction exists to meet (see 'A purpose is a user need'); not a function description",
  "operationalPrinciple": "After <archetypal action>, <observable outcome>.",   // ONE Jackson-style scenario per participant; see notes below
  "invariants":   [ "<promise the participant guarantees, in 'after X, Y' form>" ],   // OPTIONAL; 0–3 entries; Meyer/DbC-style
  "attributes":   [ { "name": "camelCase", "type": "PascalCase or primitive" } ],
  "behaviors":    [
    {
      "name": "camelCase",
      "args": [{"name":"x","type":"Foo"}],
      "returns": "Type",
      "touches": [   // OPTIONAL; what entity state this method's body would touch — fuel for the feature-envy rule
        { "entity": "EntityName", "fields": ["fieldA"], "mode": "write" }
      ],
      "cases": [     // REQUIRED on pure-function leaf behaviors whose expected output varies across AC rows; OMIT otherwise
        {
          "acIndex":     0,
          "description": "short human-readable label for this AC row",
          "inputs":      { "x": "<Java expression as string>" },   // keys MUST match args[].name exactly
          "expected":    "<Java expression as string for the return value>"
        }
      ]
    }
  ],
  "isLeaf":       false,
  "acIndices":    [ 0, 2 ]   // 0-based indices of AC rows whose `Then` clause this participant directly produces or enforces
}
```

### Rules for participant fields

- `operationalPrinciple` — ONE sentence in Jackson's "after X, then Y"
  form describing the archetypal scenario of using this participant.
  This is *what happens when it's used*, distinct from `purpose`
  (which is *what need it exists to meet*). Example for
  `AvailabilityFinder`: "After firstOverlap(calendars, duration), the
  returned slot fits inside every calendar's free time." Same
  invariance discipline as `purpose` — no specific values, no
  thresholds.
- `invariants` — OPTIONAL list of "after each action, X holds"
  contracts (Meyer / Design-by-Contract style). Empty is fine. When
  a participant has a meaningful invariant that callers will rely on,
  declare it here so the contract is visible at sign-off.
- `behaviors[].touches` — OPTIONAL list of {entity, fields, mode}
  describing what entity state the method's body would read or write.
  Be conservative — only entities/fields the method would plausibly
  touch based on its name and purpose. `touches: []` is fine for pure
  functions or methods that only deal in primitives. The feature-envy
  self-check (R4a) reads this — if a method's `write` touch targets
  an entity whose `ownedBy` is a different participant, rewrite
  before emitting.
- `name` — PascalCase, no `Impl`/`Default` suffixes (these are interfaces, not
  implementations). Don't add `Service`/`Manager`/`Handler` unless the
  abstraction genuinely is one (an `InviteDispatcher` is an
  `InviteDispatcher`, not an `InviteDispatcherService`).
- `existingFqn` — set ONLY when a type from "Existing codebase" already
  fulfils this exact role with a matching name. Prefer the interface
  over the `*Impl` class when both exist. **Omit** (do not set to null)
  when proposing a new abstraction. The bar is "obvious match" — when in
  doubt, propose new.
- `purpose` — one sentence naming the user need this abstraction exists
  to meet (see `## A `purpose` is a user need`). Present tense; not a
  function description, not docs.
- `attributes` — only the data the abstraction *holds*. Most interfaces have
  none; that's fine — return `[]`.
- `behaviors` — the public methods that fulfil the abstraction's
  responsibility. 1–4 is typical. `returns: "void"` is allowed.
- `isLeaf` — set per the termination rule. Honour it strictly.
- `acIndices` — 0-based indices of the acceptance-criteria rows this
  participant carries. A participant carries an AC row when its
  collaboration is on the path that produces the row's `Then` outcome.
  Empty array `[]` when the design has no AC, or when the participant
  is purely supportive (e.g. a generic carrier that flows through
  many rows). The wizard uses this to compute per-participant
  complexity (axes covered) and surface decomposition hints.
- `behaviors[].cases` — REQUIRED when ALL of (a) `isLeaf: true`, (b)
  the behavior is a pure function (output depends only on its inputs,
  no side effects), and (c) the expected output differs across the AC
  rows this participant carries. OMIT otherwise. Each entry is one
  AC-rooted example the wizard auto-emits as a decision-table row for
  the plugin's pure-function FILLED mode (which synthesizes the
  implementation + one test per row from these). Schema:
  - `acIndex` — 0-based index into the AC; one case row per `acIndex`
    in `acIndices`. Length of `cases[]` MUST equal `acIndices.length`
    (exhaustive).
  - `description` — short human label for the row; surfaced in the
    sidecar's row commentary.
  - `inputs` — object whose keys MUST match this behavior's
    `args[].name` set exactly (same names, same cardinality). Values
    are **Java expression strings** parsed straight into decision-table
    cells. Use canonical concrete values: round numbers (e.g.
    `new BigDecimal("100")`), relative dates
    (`LocalDate.now().minusDays(10)`), constructor calls
    (`new DiscountRule(20, 20)`), `Optional.of(...)`, etc.
  - `expected` — a Java expression string for the return value. For
    BigDecimal, use `new BigDecimal("80")`. For Optional, use
    `Optional.of(...)` / `Optional.empty()`. For records, use the
    canonical constructor form.
  Values across rows MUST be chosen so the formula is unambiguous —
  the plugin synthesizes the impl by reading the rows; rows that are
  internally inconsistent (e.g. two rows with the same inputs but
  different expected) make synthesis impossible.

## `sut` — the use-case entry point

One participant from `participants[]` is the SUT — the abstraction whose
method the caller invokes to drive the use case. Set `"sut"` to the
matching `name`. The SUT is typically (but not always) `isLeaf: false`
because it orchestrates calls to its collaborators.

## `story` — a short prose narrative

A single paragraph, **3–5 sentences**, that explains what the system does in
plain English. This is read by humans, not by code.

### Rules for the story

- **Mention every abstraction by name at least once.** Each participant's
  `name` field should appear somewhere in the story.
- **Every occurrence of a participant name MUST be wrapped in square
  brackets**: write `[OrderCheckout]`, not `OrderCheckout`. The brackets are
  parsed by the client to colour-code mentions, so wrap every appearance,
  not just the first.
- **Active voice, present tense.** "The [Scheduler] books a meeting." Not
  "A meeting is booked by the Scheduler."
- **Describe the flow, not the structure.** "The [Scheduler] asks the
  [CalendarRepository] for free slots" — not "The Scheduler has a dependency
  on a CalendarRepository."
- **No markdown, no code blocks, no headings.** Just a paragraph.
- **No JSON inside the story.** The story is a single string literal in the
  enclosing JSON; escape inner quotes if needed.

## `entities` — the data types and contract types the design passes around

Independent of the participants, list every named **type** the
behaviours reference. This includes both **data carriers** (record,
enum, class) and **contract types** (interface, sealed-interface).
Participants are the verbs, entities are the nouns and abstract
operations they exchange.

Each entry:

```
{
  "name":        "PascalCaseTypeName",
  "kind":        "record" | "enum" | "class" | "interface" | "sealed-interface",
  "existingFqn": "com.foo.dto.VisitFeeRequest",   // ONLY when reusing
  "purpose":     "one sentence...",
  "ownedBy":     "OwningParticipantName",  // the participant whose purpose justifies controlling this entity's lifecycle
  "exposure":    "internal",                // "internal" (default) | "boundary-dto" — boundary-dto entities cross architectural layers safely
  "fields":      [ { "name": "camelCase", "type": "PascalCase or primitive" } ],
  "values":      [ "UPPERCASE_VALUE" ],
  "behaviors":   [ { "name": "camelCase", "args": [{"name":"x","type":"Foo"}], "returns": "Type" } ],
  "permits":     [ "VariantNameA", "VariantNameB" ]
}
```

### Rules for entities

- **`ownedBy`** — name of the participant whose purpose justifies
  controlling this entity's lifecycle (the one that creates / mutates
  it). One owner per entity; pick the single most-responsible
  participant. Every entity must have an owner before you emit — if
  no participant clearly owns it, assign ownership during the
  self-check (don't leave `null`).
- **`exposure`** — `"internal"` (default) or `"boundary-dto"`.
  `boundary-dto` entities are designed to cross architectural layers
  (e.g. HTTP request/response shapes). Most entities are `internal`.
- **`kind` is mandatory.** Choose based on what the type IS:
  - `record` — immutable data carrier (default for DTOs and value objects).
  - `enum` — finite named set with no per-variant behaviour.
  - `class` — mutable value object with identity. Avoid unless there
    is a clear reason it can't be a record.
  - `interface` — behavioural contract with one or more abstract
    operations.
  - `sealed-interface` — closed family of variants. The variants are
    record entries in this same `entities[]` array.
- **Which kind for variance.** The selection priority in the
  "Variance-handling patterns" section governs which kind to choose.
  Rule table and resolver patterns do NOT need a `sealed-interface`
  entity — the discriminator is a plain enum or reused value type, and
  the strategies are participants, not entities. Sealed polymorphism
  uses `kind: "sealed-interface"` with non-empty `behaviors[]` and a
  `permits[]` list of variant records. In-method pattern matching uses
  `kind: "sealed-interface"` with EMPTY `behaviors[]` (pure sum type)
  and a `permits[]` list of pure-data records.
- **Skip primitives and JDK collections.** No `int`, `long`, `String`,
  `boolean`, `void`. No `List`, `Map`, `Set`, `Optional` — but the
  *element* types inside them (e.g. `Visit` inside `List<Visit>`) DO go
  in `entities` if domain-specific.
- **Participants are NOT entities.** A type that appears in `participants[]`
  (a service, repository, orchestrator) must not also appear in `entities`.
- **Reuse takes precedence.** When a type already exists in the
  codebase (visible under "Existing codebase" above), set `existingFqn`
  to its fully-qualified class name AND **omit** `fields` / `values` /
  `behaviors` / `permits` — the user's existing code is the source of
  truth and the plugin will not codegen it.
- **Field applicability by kind:**
  - `record` / `class` → `fields[]` populated; behaviors / values /
    permits empty. (A `class` may appear as a permit of an `interface`
    parent — see below.)
  - `enum` → `values[]` populated (each an UPPERCASE_NAME string);
    everything else empty.
  - `interface` → `behaviors[]` populated (at least one); fields /
    values empty. `permits[]` is OPTIONAL: when present, lists N
    `class` entities that implement this interface (used by the
    resolver variance pattern). Without `permits[]` the interface is
    just a contract; with `permits[]` the plugin generates implements
    clauses + `@Override` skeletons for each permit class.
  - `sealed-interface` → `permits[]` populated (at least one),
    `behaviors[]` may be populated or empty; fields / values empty.
- **Permits resolve to record or class.** Each name in `permits[]` MUST
  appear as another entry in the same `entities[]` array. For a
  `sealed-interface` parent, permits are typically `record` (pure
  value variants); for an `interface` parent, permits are typically
  `class` (services with state and infrastructure dependencies).
  Variant records may have empty `fields[]` (pure tag-records); permit
  classes may have empty `fields[]` initially — the user adds
  dependency fields later when wiring Spring beans.
- **Field & arg types should themselves resolve.** A field's `type`
  or an argument's `type` is either a primitive, a JDK type, an existing
  FQN-bound entity, or another entity in this same `entities` array.
  Don't invent types that don't appear somewhere.

# Example

Input: *"Schedule a meeting at a time that works for all attendees."*

Output:
```
{
  "variancePlan": [],
  "sut": "MeetingScheduler",
  "participants": [
    {
      "name": "MeetingScheduler",
      "purpose": "Books a meeting time that works for all attendees.",
      "attributes": [],
      "behaviors": [
        { "name": "schedule", "args": [{"name":"request","type":"MeetingRequest"}], "returns": "Meeting" }
      ],
      "isLeaf": false,
      "acIndices": []
    },
    {
      "name": "CalendarRepository",
      "purpose": "Provides the source of truth for who is busy when.",
      "attributes": [],
      "behaviors": [
        { "name": "loadFor",     "args": [{"name":"attendees","type":"List<Attendee>"}], "returns": "List<Calendar>" },
        { "name": "recordBlock", "args": [{"name":"meeting","type":"Meeting"}], "returns": "void" }
      ],
      "isLeaf": true,
      "acIndices": []
    },
    {
      "name": "AvailabilityFinder",
      "purpose": "Guarantees every attendee can attend the booked time.",
      "attributes": [],
      "behaviors": [
        { "name": "firstOverlap", "args": [{"name":"calendars","type":"List<Calendar>"},{"name":"duration","type":"Duration"}], "returns": "TimeSlot" }
      ],
      "isLeaf": true,
      "acIndices": []
    },
    {
      "name": "InviteDispatcher",
      "purpose": "Ensures every attendee knows about a meeting they are part of.",
      "attributes": [],
      "behaviors": [
        { "name": "send", "args": [{"name":"meeting","type":"Meeting"}], "returns": "void" }
      ],
      "isLeaf": true,
      "acIndices": []
    }
  ],
  "story": "The [MeetingScheduler] orchestrates the booking flow. It asks the [CalendarRepository] for everyone's calendars, hands them to the [AvailabilityFinder] to compute the earliest overlap that fits the requested duration, and once a slot is chosen the [InviteDispatcher] sends invites to all attendees. The [CalendarRepository] also records the new meeting block so future scheduling sees it.",
  "entities": [
    {
      "name": "MeetingRequest",
      "kind": "record",
      "purpose": "Inputs for booking: who, how long, by when.",
      "fields": [
        { "name": "attendees", "type": "List<Attendee>" },
        { "name": "duration", "type": "Duration" },
        { "name": "earliestBy", "type": "Instant" }
      ]
    },
    {
      "name": "Attendee",
      "kind": "record",
      "purpose": "A person whose calendar is consulted.",
      "fields": [
        { "name": "id", "type": "long" },
        { "name": "email", "type": "String" }
      ]
    },
    {
      "name": "Calendar",
      "kind": "record",
      "purpose": "An attendee's busy/free slots for the booking window.",
      "fields": [
        { "name": "attendeeId", "type": "long" },
        { "name": "blocks", "type": "List<TimeSlot>" }
      ]
    },
    {
      "name": "TimeSlot",
      "kind": "record",
      "purpose": "A start/end interval used both for busy blocks and the chosen meeting slot.",
      "fields": [
        { "name": "start", "type": "Instant" },
        { "name": "end", "type": "Instant" }
      ]
    },
    {
      "name": "Meeting",
      "kind": "record",
      "purpose": "The booked meeting itself, ready to be dispatched as invites.",
      "fields": [
        { "name": "slot", "type": "TimeSlot" },
        { "name": "attendees", "type": "List<Attendee>" }
      ]
    },
    {
      "name": "Duration",
      "kind": "class",
      "existingFqn": "java.time.Duration",
      "purpose": "JDK duration; reused as-is."
    }
  ]
}
```

Why each collaborator is a leaf — one termination reason each:

- `CalendarRepository` — maps to a Spring `@Repository` stereotype. The
  storage backend (a DB, a Google Calendar API) is out of scope.
- `AvailabilityFinder` — pure function. Given calendars and a duration, it
  returns the earliest overlap. No collaborators.
- `InviteDispatcher` — a single method on a platform type (an HTTP / SMTP
  send). The transport is out of scope.
- `MeetingScheduler` is the SUT (named at the top via `"sut"`), and it is
  `isLeaf: false` — it has its own call graph (the three collaborators).

Notice how the `story` mentions each name in `[brackets]` every time, reads
as plain English, and describes the flow rather than the structure.

# Rule details

The rules referenced in "Self-check before returning" are spelled out
below, one per file from `prompts/rules/`. Each is a constraint you
satisfy *before* emitting — never a finding to surface. When a rule
fires, rewrite the offending field until it passes. The user sees the
final design, not the discipline that produced it.

{RULES}

# Now produce the analysis for the input at the top of this prompt.
