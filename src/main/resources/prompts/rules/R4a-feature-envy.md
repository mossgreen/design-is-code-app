---
id: R4a
name: business-rule feature envy
summary: Each participant owns its own data — methods don't reach into another's fields
applies-to: every participant whose methods declare `touches[]`
---

Before returning, walk every method on every participant. For each
entry in `touches[]` whose `mode` is `"write"`, check the target
entity's `ownedBy`:

- If `ownedBy` names *this* participant, the write is legitimate — keep
  going.
- If `ownedBy` names a *different* participant, the method is reaching
  into state that belongs elsewhere. Rewrite.

Three ways to rewrite, in priority order:

1. **Move the operation onto the owner.** Replace the cross-participant
   write with a method call on the owning participant. The owner now
   exposes a behaviour like `applyDiscount(code)` and the caller
   delegates to it. This is almost always the right fix.
2. **Reassign ownership.** If the writing participant is the one whose
   purpose is most about this entity's lifecycle, the entity's
   `ownedBy` was wrong — fix the ownership.
3. **Make the write a read.** If the participant only thinks it needs
   to write (e.g. it's projecting data across a boundary, not changing
   state), the `mode` is wrong — set it to `"read"` and consume the
   value functionally.

The point: every entity has one participant that "owns" its lifecycle,
and only that participant writes to it. This keeps responsibilities
local and prevents the Anemic Domain Model anti-pattern (services that
manipulate data structures the data structures themselves should own).

When `ownedBy` is missing on an entity, assign one before continuing —
the design isn't complete until every entity has a clear owner. Pick
the single most-responsible participant.
