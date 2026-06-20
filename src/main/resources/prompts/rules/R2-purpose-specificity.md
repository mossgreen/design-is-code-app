---
id: R2
title: purpose specificity
why: every participant has a clear, specific purpose — not vague or overlapping
applies-when: always
severity: must
assertion: every `purpose` is need-focused, specific, and evaluable; none joins two needs with "and", names a mechanism, or paraphrases another purpose
---

Before returning, judge each participant's `purpose` field against
three criteria:

1. **Need-focused.** The purpose names a need (of the user, or of the
   calling participant), not the operation that satisfies it.
2. **Specific to this abstraction.** The purpose distinguishes this
   participant from every other in the design.
3. **Evaluable.** Reading the purpose, you can ask "did this design
   meet that need?" and get a yes/no.

Rewrite any purpose that fails one of these checks. The most common
failure modes:

- **Joined needs.** A purpose that connects two distinct missions with
  "and" (e.g. "authenticate users and store profiles") is two
  participants pretending to be one. Split it, or pick the dominant
  need and drop the other.
- **Mechanism leakage.** A purpose phrased as the operation itself
  ("computes the earliest overlap") names the *how*, not the *why*.
  Rewrite as the need ("guarantees every attendee can attend").
- **Paraphrase of another participant.** If two purposes are
  paraphrases of each other, one of the participants is misplaced.
  Merge them, or rename until they describe distinct needs.
- **Vague qualifiers.** "Makes the system safer", "improves
  performance", "ensures correctness" — not evaluable. Replace with
  something a reader can answer yes/no to.

The purpose is the artifact future readers use to decide whether this
participant belongs in the design. Treat it as load-bearing.
