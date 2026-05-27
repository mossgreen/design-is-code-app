You are composing a call sequence for a Java/Spring system. The user has
already named the participants (interfaces) and given a free-text story.
Your job: produce the ordered list of method calls between participants
that implements the story. The output is consumed by an automated tool —
JSON shape must be exact.

# Input

## Story

```
{STORY}
```

## Participants (available cast)

Each participant is an interface with named methods. Use only these names.
If you need a method that doesn't exist, you may invent one — the tool
will auto-add it.

```
{PARTICIPANTS}
```

## Polymorphic entities (additional callees)

Some entity types in the design are polymorphic callables — `interface`
or `sealed-interface` entities with non-empty `behaviors[]`. Calling one
of these models polymorphic dispatch: the runtime variant (chosen by the
language's `sealed`/`implements` machinery, or returned by an upstream
resolver) supplies the implementation. The list below may be empty.

```
{ENTITIES}
```

## System under test (orchestrator)

```
{SUT}
```

If non-empty, the first call MUST have `caller` equal to this exact name.
The wizard separately manages the `[*] -> SUT` entry and `[*] <-- SUT`
return rows — do NOT include those.

## Previous attempt (if any)

{REFUSAL_FEEDBACK}

# Task

Produce an ordered sequence of calls that implements the story using the
named participants. Wrap repetition in a loop fragment, branching in an
alt fragment — but only when the story genuinely calls for them. Flat is
better than nested.

## Rules

- **Use existing methods when they fit.** Don't invent `OrderRepository.find`
  if `OrderRepository.findAllByCustomerId` already exists and fits.
- **Invent new methods sparingly.** Only when no existing method on the named
  callee fits the responsibility. Use `camelCase` names and realistic
  `args`/`returns` shapes.
- **Caller and callee must come from the cast.** Caller is always a
  participant name. Callee may be a participant name OR the name of a
  polymorphic entity listed in `{ENTITIES}` above. Don't reference
  types absent from both lists. Don't use `[*]` or `system_caller` —
  those are managed by the wizard.
- **Dispatch to an entity only when the story names variance.** Use a
  participant for stateless services and orchestration; dispatch to a
  polymorphic entity when a single behavior has variant-specific
  implementations supplied by the variants. When a participant returns
  a polymorphic entity (e.g. a resolver returning a `Strategy`
  interface), the very next call typically dispatches to that entity —
  ONE arrow, not an `alt`/`switch` over variants.
- **3-8 calls is typical.** Hard cap: 12 calls (counting only direct calls,
  fragments don't count). If your sequence is longer, your decomposition
  is wrong.
- **Fragments:** `loop` for repetition; `alt` for if/else branching;
  `opt` for a single optional block. Each fragment has a `label` and
  recursive `steps`. `alt` may also include `elseSteps` for the else
  branch.
- **No system-caller rows.** If the SUT field is set, the boundary rows
  exist already; your sequence is purely the body.

# Output

**Strict JSON. No prose. No markdown fences. First character `{`, last `}`.**

```
{
  "steps": [
    { "caller": "Name", "callee": "Name", "method": "name", "args": [{"name":"x","type":"Foo"}], "returns": "Type" },
    {
      "kind": "loop",
      "label": "for each item",
      "steps": [ ...recursive... ]
    },
    {
      "kind": "alt",
      "label": "if condition",
      "steps":     [ ...if-branch... ],
      "elseSteps": [ ...else-branch (optional)... ]
    }
  ]
}
```

`args` and `returns` are OPTIONAL on call steps. Include them only when
the method doesn't yet exist on the named callee — that's the signal to
auto-create. If you're using an existing method, omit args/returns.

# Example

## Inputs

Story: *"Schedule a meeting at a time that works for all attendees."*

Participants:
```
[
  { "name": "MeetingScheduler", "methods": [{ "name": "schedule", "args": [{"name":"request","type":"MeetingRequest"}], "returns": "Meeting" }] },
  { "name": "CalendarRepository", "methods": [
      { "name": "loadFor",     "args": [{"name":"attendees","type":"List<Attendee>"}], "returns": "List<Calendar>" },
      { "name": "recordBlock", "args": [{"name":"meeting","type":"Meeting"}], "returns": "void" }
  ]},
  { "name": "AvailabilityFinder", "methods": [{ "name": "firstOverlap", "args": [{"name":"calendars","type":"List<Calendar>"},{"name":"duration","type":"Duration"}], "returns": "TimeSlot" }] },
  { "name": "InviteDispatcher", "methods": [{ "name": "send", "args": [{"name":"meeting","type":"Meeting"}], "returns": "void" }] }
]
```

SUT: `MeetingScheduler`

## Output

```
{
  "steps": [
    { "caller": "MeetingScheduler", "callee": "CalendarRepository", "method": "loadFor" },
    { "caller": "MeetingScheduler", "callee": "AvailabilityFinder",  "method": "firstOverlap" },
    { "caller": "MeetingScheduler", "callee": "CalendarRepository", "method": "recordBlock" },
    {
      "kind": "loop",
      "label": "for each attendee",
      "steps": [
        { "caller": "MeetingScheduler", "callee": "InviteDispatcher", "method": "send" }
      ]
    }
  ]
}
```

Notes about this example:
- Every `caller` is `MeetingScheduler` (the SUT). The other participants
  don't call each other in this design; they're leaves invoked by the
  orchestrator. Most well-decomposed systems look like this.
- No `args`/`returns` on the steps — every method already exists on its
  callee, so they're optional.
- One loop, because invites are sent per attendee. Flat would also be
  correct (a single `send` call modelling "broadcast"). Either is fine;
  pick what fits the story's wording.

# Now produce the sequence for the input at the top of this prompt.
