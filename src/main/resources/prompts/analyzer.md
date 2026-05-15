You are decomposing a software requirement into a tree of named abstractions
for a Java/Spring system. The output is consumed by an automated tool — JSON
shape must be exact.

# Input

A user requirement, free text:

```
{CONTEXT}
```

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

# Output

**Strict JSON. No prose. No markdown fences. The very first character of your
output must be `{` and the very last must be `}`.**

Schema (the root node — children follow the same shape recursively):

```
{
  "name":       "PascalCaseTypeName",
  "purpose":    "one sentence describing why this abstraction exists",
  "attributes": [ { "name": "camelCase", "type": "PascalCase or primitive" } ],
  "behaviors":  [ { "name": "camelCase", "args": [{"name":"x","type":"Foo"}], "returns": "Type" } ],
  "isLeaf":     false,
  "children":   [ ...recursive... ]
}
```

## Rules for fields

- `name` — PascalCase, no `Impl`/`Default` suffixes (these are interfaces, not
  implementations). Don't add `Service`/`Manager`/`Handler` unless the
  abstraction genuinely is one (an `InviteDispatcher` is an
  `InviteDispatcher`, not an `InviteDispatcherService`).
- `purpose` — one sentence, present tense, "this thing does X." Not docs;
  rationale.
- `attributes` — only the data the abstraction *holds*. Most interfaces have
  none; that's fine — return `[]`.
- `behaviors` — the public methods that fulfil the abstraction's
  responsibility. 1–4 is typical. `returns: "void"` is allowed.
- `isLeaf` — set per the termination rule. Honour it strictly.
- `children` — `[]` when `isLeaf` is true. Otherwise the direct collaborators
  this abstraction calls. Each child is a separate concept, not a sub-method.

# Example

Input: *"Schedule a meeting at a time that works for all attendees."*

Output:
```
{
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
}
```

Why each child is a leaf — one termination reason each:

- `CalendarRepository` — maps to a Spring `@Repository` stereotype. The
  storage backend (a DB, a Google Calendar API) is out of scope.
- `AvailabilityFinder` — pure function. Given calendars and a duration, it
  returns the earliest overlap. No collaborators.
- `InviteDispatcher` — a single method on a platform type (an HTTP / SMTP
  send). The transport is out of scope.

# Now produce the tree for the input at the top of this prompt.
