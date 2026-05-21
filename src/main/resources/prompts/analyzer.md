You are decomposing a software requirement into a tree of named abstractions
for a Java/Spring system. The output is consumed by an automated tool — JSON
shape must be exact.

# Input

A user requirement, free text:

```
{CONTEXT}
```

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

The top-level shape has TWO fields:

```
{
  "tree":  { ...the recursive node shape below... },
  "story": "..."
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
  "story": "The [MeetingScheduler] orchestrates the booking flow. It asks the [CalendarRepository] for everyone's calendars, hands them to the [AvailabilityFinder] to compute the earliest overlap that fits the requested duration, and once a slot is chosen the [InviteDispatcher] sends invites to all attendees. The [CalendarRepository] also records the new meeting block so future scheduling sees it."
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
