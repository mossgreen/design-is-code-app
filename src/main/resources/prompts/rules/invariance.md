---
id: invariance
name: invariance discipline
summary: Reused code keeps its real behaviour — the design doesn't redefine it
applies-to: every `purpose` field and every sentence of `story`
---

Apply the invariance test to every `purpose` field and every sentence
of `story` before returning:

> *Would this sentence need to change if the implementation grew — a
> new case added, a new threshold introduced, a new variant appearing?*

If **yes**, the sentence is about content; rewrite it to describe
shape.
If **no**, keep it.

A design's prose reads true across all valid implementations of the
same shape. The implementation supplies the content (specific values,
thresholds, branches, variant identifiers); the design supplies the
shape (contracts, responsibilities, collaborations). A `purpose` that
quotes thresholds, names branches, or enumerates variants has confused
the two.

Examples:

- ❌ "Applies a 10% discount when the customer is a member."
  → ✅ "Computes the price a customer is charged given the rules in
  effect."
- ❌ "Routes orders worth over $500 to manager approval."
  → ✅ "Routes orders through the approval path their value selects."
- ❌ "Books a meeting at the earliest 30-minute slot that fits."
  → ✅ "Books a meeting time that works for all attendees."

Acceptance criteria are samples of content the design's shape must
admit. They are evidence, not blueprints. The story narrates the
shape; the AC rows demonstrate it.
