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

## Variance is governed by the patterns below

When the AC implies variance — different cases producing different
outcomes — choose ONE pattern per axis using the rules in the
"Variance-handling patterns" section below. The default priority is
rule table > resolver > sealed polymorphism > pattern matching.

Under every pattern, the names of specific kinds, the rule values, and
the branch conditions never appear in any `purpose` field or `story`
sentence — that invariance from rules 1–3 above is unconditional.

## Self-check before returning

After producing the design, verify every `purpose` field and every
sentence of the `story` against the invariance test. If any sentence
would need to change to accommodate a hypothetical new case in the
implementation, rewrite it before returning.

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

### 2. Resolver — variance as pluggable processors

The cases are N implementations of a common interface, selected at
runtime by a key.

Choose when: each case is a full operation (not just data). The variants
are interchangeable at the same call site, selected by an external key.

Participant shape:
- A `XxxResolver` participant exposing `resolve(key) → Strategy`.
- N strategy participants implementing a common operation; each strategy
  is its own leaf in the participant tree.

No `sealed-interface` entity is needed for this pattern either — the
strategies are participants, not entities.

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

The top-level shape has FOUR fields:

```
{
  "sut":          "PascalCaseSutName",
  "participants": [ ...the per-participant shape below... ],
  "story":        "...",
  "entities":     [ ...record/enum/class entries the participants pass around... ]
}
```

## `participants` — flat list, each entry one participant

Each participant:

```
{
  "name":         "PascalCaseTypeName",
  "existingFqn":  "com.foo.order.OrderRepository",   // ONLY when reusing an existing codebase type; OMIT otherwise
  "purpose":      "one sentence describing why this abstraction exists",
  "attributes":   [ { "name": "camelCase", "type": "PascalCase or primitive" } ],
  "behaviors":    [ { "name": "camelCase", "args": [{"name":"x","type":"Foo"}], "returns": "Type" } ],
  "isLeaf":       false,
  "acIndices":    [ 0, 2 ]   // 0-based indices of AC rows whose `Then` clause this participant directly produces or enforces
}
```

### Rules for participant fields

- `name` — PascalCase, no `Impl`/`Default` suffixes (these are interfaces, not
  implementations). Don't add `Service`/`Manager`/`Handler` unless the
  abstraction genuinely is one (an `InviteDispatcher` is an
  `InviteDispatcher`, not an `InviteDispatcherService`).
- `existingFqn` — set ONLY when a type from "Existing codebase" already
  fulfils this exact role with a matching name. Prefer the interface
  over the `*Impl` class when both exist. **Omit** (do not set to null)
  when proposing a new abstraction. The bar is "obvious match" — when in
  doubt, propose new.
- `purpose` — one sentence, present tense, "this thing does X." Not docs;
  rationale.
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
  "fields":      [ { "name": "camelCase", "type": "PascalCase or primitive" } ],
  "values":      [ "UPPERCASE_VALUE" ],
  "behaviors":   [ { "name": "camelCase", "args": [{"name":"x","type":"Foo"}], "returns": "Type" } ],
  "permits":     [ "VariantNameA", "VariantNameB" ]
}
```

### Rules for entities

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
    permits empty.
  - `enum` → `values[]` populated (each an UPPERCASE_NAME string);
    everything else empty.
  - `interface` → `behaviors[]` populated (at least one); fields /
    values / permits empty.
  - `sealed-interface` → `permits[]` populated (at least one),
    `behaviors[]` may be populated or empty; fields / values empty.
- **Permits resolve to records.** Each name in `permits[]` MUST appear
  as another `record` (rarely `class`) entry in the same `entities[]`
  array. Variant records may have empty `fields[]` (pure tag-records).
- **Field & arg types should themselves resolve.** A field's `type`
  or an argument's `type` is either a primitive, a JDK type, an existing
  FQN-bound entity, or another entity in this same `entities` array.
  Don't invent types that don't appear somewhere.

# Example

Input: *"Schedule a meeting at a time that works for all attendees."*

Output:
```
{
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
      "purpose": "Reads and writes attendees' calendar entries.",
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
      "purpose": "Computes the earliest overlap of free slots across calendars.",
      "attributes": [],
      "behaviors": [
        { "name": "firstOverlap", "args": [{"name":"calendars","type":"List<Calendar>"},{"name":"duration","type":"Duration"}], "returns": "TimeSlot" }
      ],
      "isLeaf": true,
      "acIndices": []
    },
    {
      "name": "InviteDispatcher",
      "purpose": "Sends meeting invites once the slot is chosen.",
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

# Now produce the analysis for the input at the top of this prompt.
