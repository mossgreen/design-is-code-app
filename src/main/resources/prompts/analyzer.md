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

## When the domain noun has multiple kinds

If the domain treats one conceptual thing as having multiple kinds,
choose one of two structural patterns:

(a) **Discriminator + policy.** The noun stays a flat discriminator
    type — an `enum` for a new noun, or a reused class for an existing
    one. A separate participant — the policy — holds the abstract
    decision; its `purpose` describes the decision in shape language,
    without naming any kind. The rules per kind live only in the
    policy's implementation.

(b) **Sealed contract.** The noun itself becomes `kind:
    "sealed-interface"` with `permits[]` listing concrete record
    variants; each variant is a `kind: "record"` entry in the same
    `entities[]` array. The contract names the abstract operation
    each variant implements; the variants implement it differently.

Choose (a) when the kinds differ only in data a policy consumes.
Choose (b) when each kind owns behaviour the design exposes — when
you can name a method whose implementation differs in operation
across the kinds, not merely in the data it uses.

**Default to (a).** Promote to (b) only when (b)'s criterion holds.

Under both patterns, the names of specific kinds, the rule values,
and the branch conditions never appear in any `purpose` field or
`story` sentence.

## Self-check before returning

After producing the design, verify every `purpose` field and every
sentence of the `story` against the invariance test. If any sentence
would need to change to accommodate a hypothetical new case in the
implementation, rewrite it before returning.

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

Produce a single tree. Each node is an interface — a named concept with a
one-sentence purpose, optional attributes, and behaviours (methods).

The **root** is the orchestrator / use-case entry point. Its children are
the collaborators it needs. Their children are *their* collaborators, and
so on, until termination.

## Termination rule — stop decomposing when ANY of these is true

Mark the node `"isLeaf": true` and set `"children": []`:

- It maps to a **pure function** (e.g. `validate`, `normalise`, `format`,
  `parse`). Pure functions have no collaborators.
- It maps to a standard Spring **stereotype** that doesn't itself collaborate
  with sibling abstractions in this design — e.g. `@Repository` (talks to a
  DB), `@Controller` (handles HTTP), `@Configuration` (provides beans). The
  thing it talks to (DB, HTTP) is not modelled here.
- It maps to **a single method on an existing JDK / Spring type** (e.g.
  `RestTemplate.postForObject`, `Files.write`). Don't model the platform.

Prefer 2–5 nodes per level. Never go deeper than 4 levels. If you're tempted
to add a 5th sibling or a 5th level, consolidate or stop.

## Orchestrator vs leaf — when to leave a node non-leaf

If a node represents a custom abstraction with its own internal call graph
(it would orchestrate further collaborators when implemented), leave it
**non-leaf** (`isLeaf: false`) even if you don't expand its children in
this output. Downstream tooling treats such nodes as deferred sub-designs:
they get a stub at this level and a separate design pass for their
internals. Don't force-flatten an orchestrator into a leaf just to meet
the depth limit — better to truncate the tree (omit children) than to
mis-classify a multi-step concern as a pure function.

# Output

**Strict JSON. No prose. No markdown fences. The very first character of your
output must be `{` and the very last must be `}`.**

The top-level shape has THREE fields:

```
{
  "tree":     { ...the recursive node shape below... },
  "story":    "...",
  "entities": [ ...record/enum/class entries the participants pass around... ]
}
```

## `tree` — the recursive node shape

Each node:

```
{
  "name":         "PascalCaseTypeName",
  "existingFqn":  "com.foo.order.OrderRepository",   // ONLY when reusing an existing codebase type; OMIT otherwise
  "purpose":      "one sentence describing why this abstraction exists",
  "attributes":   [ { "name": "camelCase", "type": "PascalCase or primitive" } ],
  "behaviors":    [ { "name": "camelCase", "args": [{"name":"x","type":"Foo"}], "returns": "Type" } ],
  "isLeaf":       false,
  "children":     [ ...recursive... ]
}
```

### Rules for tree fields

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
- `children` — `[]` when `isLeaf` is true. Otherwise the direct collaborators
  this abstraction calls. Each child is a separate concept, not a sub-method.

## `story` — a short prose narrative

A single paragraph, **3–5 sentences**, that explains what the system does in
plain English. This is read by humans, not by code.

### Rules for the story

- **Mention every abstraction by name at least once.** Each tree node's
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

Independent of the participant tree, list every named **type** the
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
- **Which kind for variance.** The "When the domain noun has multiple
  kinds" subsection in the Abstraction-discipline block above governs
  the choice between (a) discriminator + policy and (b) sealed contract.
  The schema here only specifies *how* to express each kind once chosen.
- **Skip primitives and JDK collections.** No `int`, `long`, `String`,
  `boolean`, `void`. No `List`, `Map`, `Set`, `Optional` — but the
  *element* types inside them (e.g. `Visit` inside `List<Visit>`) DO go
  in `entities` if domain-specific.
- **Participants are NOT entities.** A type that appears in `tree` (a
  service, repository, orchestrator) must not also appear in `entities`.
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
  "tree": {
    "name": "MeetingScheduler",
    "purpose": "Books a meeting time that works for all attendees.",
    "attributes": [],
    "behaviors": [
      { "name": "schedule", "args": [{"name":"request","type":"MeetingRequest"}], "returns": "Meeting" }
    ],
    "isLeaf": false,
    "children": [
      {
        "name": "CalendarRepository",
        "purpose": "Reads and writes attendees' calendar entries.",
        "attributes": [],
        "behaviors": [
          { "name": "loadFor",     "args": [{"name":"attendees","type":"List<Attendee>"}], "returns": "List<Calendar>" },
          { "name": "recordBlock", "args": [{"name":"meeting","type":"Meeting"}], "returns": "void" }
        ],
        "isLeaf": true,
        "children": []
      },
      {
        "name": "AvailabilityFinder",
        "purpose": "Computes the earliest overlap of free slots across calendars.",
        "attributes": [],
        "behaviors": [
          { "name": "firstOverlap", "args": [{"name":"calendars","type":"List<Calendar>"},{"name":"duration","type":"Duration"}], "returns": "TimeSlot" }
        ],
        "isLeaf": true,
        "children": []
      },
      {
        "name": "InviteDispatcher",
        "purpose": "Sends meeting invites once the slot is chosen.",
        "attributes": [],
        "behaviors": [
          { "name": "send", "args": [{"name":"meeting","type":"Meeting"}], "returns": "void" }
        ],
        "isLeaf": true,
        "children": []
      }
    ]
  },
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

Why each child is a leaf — one termination reason each:

- `CalendarRepository` — maps to a Spring `@Repository` stereotype. The
  storage backend (a DB, a Google Calendar API) is out of scope.
- `AvailabilityFinder` — pure function. Given calendars and a duration, it
  returns the earliest overlap. No collaborators.
- `InviteDispatcher` — a single method on a platform type (an HTTP / SMTP
  send). The transport is out of scope.

Notice how the `story` mentions each name in `[brackets]` every time, reads
as plain English, and describes the flow rather than the structure.

# Now produce the analysis for the input at the top of this prompt.
