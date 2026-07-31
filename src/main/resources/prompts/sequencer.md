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

- **State what each call passes.** `args` on a step is NOT the callee's
  parameter list — it is the list of **values the orchestrator hands over at
  this point in the flow**. See "Values in scope" below. This is the whole
  reason the sequence exists: the participants were already named for you, so
  the only thing you decide is the order of the calls and what flows between
  them.
- **Name what each call returns.** A step whose method returns a value carries
  `resultName`: the name that value takes in the orchestrator. Later steps
  refer to it by that name. Omit `resultName` only for `void` methods.
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

## Values in scope — the rule that makes a sequence real

A sequence diagram is not a picture of which objects talk. It is a statement of
**what flows between them**. Getting the order right and the flow wrong produces
a design that looks correct, generates code that compiles, passes its tests, and
does nothing.

At any step, the values you may pass are exactly:

1. the **parameters of the SUT's entry method** (shown in `{SUT}`'s signature),
2. the **`resultName` of any earlier step**,
3. a field or accessor rooted in one of those (`owner.id`, `order.total()`),
4. a literal (`0`, `"OWNER"`, `true`, `null`).

Nothing else exists. There is no ambient value, no value that "will be there",
no name you may introduce because it sounds right.

**If you need a value that is not in scope, you have exactly two honest moves:**

- add an earlier step that produces it, and name it with `resultName`; or
- if nothing in the cast can produce it, say so in `blocked` (below) — do not
  invent the name and hope.

Two failures this rule exists to stop, both seen in real runs:

- **A value from nowhere.** `feeFor(hoursUntilVisit)` when no earlier step
  returned `hoursUntilVisit` and the entry method has no such parameter. The
  generator has to invent it.
- **A value that goes nowhere.** A step fetches a rule, names it `rule`, and no
  later step passes `rule` to anything. The feature does nothing, silently. If a
  step's result is never consumed and is not the flow's outcome, either you are
  missing the call that uses it, or the step should not be there.

Argument names come from the **caller's** vocabulary, not the callee's. The
callee's declared parameter may be named `key`; what you pass is `initiator`,
because that is what the orchestrator holds. Never emit a placeholder name like
`key`, `input`, or `value` as an argument.

# Output

**Strict JSON. No prose. No markdown fences. First character `{`, last `}`.**

```
{
  "steps": [
    { "caller": "Name", "callee": "Name", "method": "name",
      "args": ["valueInScope", "another.field"], "resultName": "whatItReturns" },
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
  ],
  "blocked": "optional — one sentence naming a value the story needs but no
              participant can produce; omit when the flow is complete"
}
```

Field rules for a call step:

- **`args`** — REQUIRED. An array of **strings**: the values passed at this call,
  each one in scope per "Values in scope" above. `[]` for a no-argument call.
  Never a `{name, type}` object — that would be a signature, and signatures are
  not your decision.
- **`resultName`** — REQUIRED when the method returns a value; omit for `void`.
  A camelCase name for what comes back. Later steps may pass it.
- **`newMethod`** — ONLY when the method does not yet exist on the callee. This
  is the signature you are proposing, and the one place `{name, type}` belongs:
  `"newMethod": { "params": [{"name":"x","type":"Foo"}], "returns": "Bar" }`.
  The parameter names here are the callee's vocabulary; the `args` above are the
  caller's. They may differ, and that is normal.

Omit `newMethod` when using an existing method — its signature is already known.

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
  { "name": "MeetingFactory", "methods": [{ "name": "create", "args": [{"name":"request","type":"MeetingRequest"},{"name":"slot","type":"TimeSlot"}], "returns": "Meeting" }] },
  { "name": "InviteDispatcher", "methods": [{ "name": "send", "args": [{"name":"meeting","type":"Meeting"}], "returns": "void" }] }
]
```

SUT: `MeetingScheduler`

## Output

```
{
  "steps": [
    { "caller": "MeetingScheduler", "callee": "CalendarRepository", "method": "loadFor",
      "args": ["request.attendees()"], "resultName": "calendars" },
    { "caller": "MeetingScheduler", "callee": "AvailabilityFinder", "method": "firstOverlap",
      "args": ["calendars", "request.duration()"], "resultName": "slot" },
    { "caller": "MeetingScheduler", "callee": "MeetingFactory", "method": "create",
      "args": ["request", "slot"], "resultName": "meeting" },
    { "caller": "MeetingScheduler", "callee": "CalendarRepository", "method": "recordBlock",
      "args": ["meeting"] },
    {
      "kind": "loop",
      "label": "for each attendee",
      "steps": [
        { "caller": "MeetingScheduler", "callee": "InviteDispatcher", "method": "send",
          "args": ["meeting"] }
      ]
    }
  ]
}
```

Notes about this example:
- Every `caller` is `MeetingScheduler` (the SUT). The other participants
  don't call each other in this design; they're leaves invoked by the
  orchestrator. Most well-decomposed systems look like this.
- **Trace the values and the design proves itself.** `request` is the entry
  parameter. `calendars` is produced by step 1 and consumed by step 2. `slot` is
  produced by step 2 and consumed by step 3. `meeting` is produced by step 3 and
  consumed by steps 4 and 5. Every argument has a source above it; every result
  has a consumer below it.
- **The `MeetingFactory` step earns its place by data flow.** `recordBlock` and
  `send` both need a `Meeting`, and nothing else in the flow produces one.
  Without that step, `meeting` would be a name from nowhere. When an argument has
  no source, the fix is the call that produces it — never a plausible-looking
  name.
- `recordBlock` and `send` have no `resultName` — both return `void`.
- `loadFor` declares its parameter as `attendees`, but we pass
  `request.attendees()`. Different vocabularies, correctly.
- One loop, because invites are sent per attendee. Flat would also be
  correct (a single `send` call modelling "broadcast"). Either is fine;
  pick what fits the story's wording.

# Now produce the sequence for the input at the top of this prompt.
