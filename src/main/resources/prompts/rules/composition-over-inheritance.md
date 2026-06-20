---
id: composition-over-inheritance
title: composition over inheritance
why: prefer composing collaborators over declaring inheritance hierarchies
applies-when: always
severity: must
assertion: no `purpose` or `story` sentence frames inheritance; sharing is delegation
---

When two abstractions share behaviour or data, model the sharing through
**composition** (one holds a reference to the other and delegates) rather
than **inheritance** (one extends the other). Walk the draft before
returning and rewrite anything that violates this.

## Four places this applies

1. **Participants are call-graph nodes, not type-hierarchy nodes.**
   No participant's `purpose` may describe it as "a specialised
   variant of", "a subtype of", "extends", or "inherits from" another
   participant. If two participants share responsibility, either
   merge them (one participant, one purpose) or keep them separate
   and let one delegate to the other via the call graph.

   ❌ "A specialised `OrderProcessor` for express orders."
   ✅ "Processes express orders by delegating fulfilment to
       `OrderProcessor`."

2. **Entity reuse goes through fields, not extension.** When entity
   B "is a kind of" entity A, ask: does B genuinely need to be a
   *subtype* callers can pass anywhere an A is expected? Only then
   reach for the sealed-family pattern (`kind: "sealed-interface"`
   with non-empty `permits[]`). For ordinary "B uses A's data" or
   "B specialises A's role", make the relationship a field:

   ❌ `record ExpressOrder extends Order { ... }`  (not modelable here
       — the schema has no extends — but the *intent* leaks through
       in story prose and purposes)
   ✅ `record ExpressOrder(Order common, Duration cutoff)` — the
       specialisation composes the base.

3. **Variance priority codifies this.** Walk the "Selection priority"
   honestly — the first two patterns are pure composition; do not
   reach for a sealed family while a lower-numbered pattern's
   criterion still holds.

4. **Watch the `story` for inheritance smells.** Phrases like
   "extends", "is a kind of", "specialised version of", "subclass
   of", or "inherits from" in the story narrative are signals the
   design has reached for inheritance. Rewrite as "uses", "wraps",
   "delegates to", or "composes" where the meaning permits. Keep
   inheritance language only when the design genuinely needs a
   sealed family — and in that case, make sure that family is
   declared in `entities[]` with `kind: "sealed-interface"` and a
   real `permits[]` list, not just hinted at in prose.

## Why this matters

Composed designs change in one place: swap the collaborator, the
composer is untouched. Inherited designs leak the parent's implementation
choices into every subclass and force tests to include the parent's
wiring transitively. Composition keeps the seams visible at the call
site; inheritance buries them inside a class hierarchy. For a design
that DisC will turn into tests-first code, visible seams matter more
than syntactic brevity.
