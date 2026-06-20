---
id: leaf-freestandingness
title: leaf freestandingness
why: reused leaves stand on their own — they don't depend on this design's context
applies-when: always
severity: must
assertion: no leaf participant's `purpose` names another participant; leaves are describable in isolation
---

Walk every leaf participant (`isLeaf == true`) before returning. Read
its `purpose` field. Confirm the purpose does NOT name any other
participant in the design.

If it does, the leaf is misplaced. Two ways to fix:

1. **Rewrite the leaf's purpose so it stands alone.** A leaf's purpose
   should describe what the leaf does at its boundary, in domain
   terms, without reference to who calls it or what they do with the
   result. Example: an `AvailabilityFinder` leaf's purpose is
   "guarantees every attendee can attend the booked time" — not
   "helps the MeetingScheduler choose a slot."
2. **Promote the leaf to a non-leaf, or absorb it into its caller.**
   If you can't describe the leaf without naming its caller, the leaf
   isn't a separable abstraction — fold it back into the caller, or
   give it its own internal collaborators (which makes it non-leaf).

Leaves are the building blocks of the design. A building block whose
identity depends on the building above it has no independent identity.
