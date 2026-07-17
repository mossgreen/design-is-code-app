## Why the new design

**The old way** — implement the ticket as an `initiator` branch inside `CancelVisitService`:
- Every new `initiator` value edits `CancelVisitService` again: 2 branches today, 3 next time — the orchestrator never stops growing.
- `CancelVisitService` knows every concrete strategy (StandardCancellationFee, ClinicInitiatedFee); each branch multiplies its test cases — 2 branches × the 4 surrounding calls all re-verified per branch.
- The `initiator` decision is buried in a method body — invisible at review, copy-paste bait at the next variation point.

**The new design** — the variance becomes a strategy family behind `CancellationFeePolicy`:
- A new `initiator` value = 1 new class + 1 row in `CancellationFeePolicyResolver.decision.md`. `CancelVisitService` and its tests do not change.
- Each strategy is a leaf, testable alone against its own decision table.
- The mapping is a reviewable 2-row table — totality is checkable, not buried in branches.
- `CancelVisitService` stays linear (no branch at the orchestrator) — regenerated wholesale from the design.

**Test cost**: old way folds 2 branches into `CancelVisitService`'s tests (every scenario re-run per branch); new way = 2 leaf tables + 1 resolver table (2 rows), orchestrator tests unchanged.
