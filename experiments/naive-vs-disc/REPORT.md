# Report: naive AI vs DisC

`PROTOCOL.md` is frozen. It says corrections go here, dated. This file holds
those amendments and, once the chains finish, the results.

**No results yet.** Naive chain 1 is complete. The DisC arm has never run.
Do not quote a headline number from this file until all six chains are in.

---

## Amendment 2 — 2026-08-01

**Written before the DisC arm has ever run.** Git proves the ordering.

### What changes

Max NPath drops from primary metric to reported-only. Promoted to primary:

- existing production lines modified (ticket-1 state → ticket-2 state)
- existing test lines modified
- `naive_extracted_strategy` (the yes/no `PROTOCOL.md` already calls the single
  most informative output)

### Why

Max NPath does not discriminate between the two arms. Three reasons.

A linear orchestrator scores NPath 1 by construction. DisC forbids branching at
the orchestrator, so the grammar guarantees the number. `PROTOCOL.md`'s
prediction table states "Orchestrator NPath after ticket 1: DisC = 1". That
sentence restates the grammar. A guarantee makes a poor hypothesis.

Max NPath rewards decomposition of any quality. Split one method into five and
the maximum falls, whether or not the split is sensible. The metric measures how
finely the code is divided.

Branches are conserved. DisC's own product principle says the tool places
branching rather than removing it. Total path count across the system moves
around; it does not shrink. A per-method maximum reports the move as a win.

### What does not change

No prediction is withdrawn. No data is discarded. `measure.sh` still collects
every figure it collected before, and the report will print all of them,
including whole-repo and ticket-scoped NPath. Only the rank changes.

### Declared bias

Written knowing naive chain 1's NPath figures — 3 after act1, 4 after act2 — and
nothing at all about DisC's. Same discipline as `PROTOCOL-2.md`, which declared
the same exposure.

This amendment removes the metric DisC wins by definition. A self-serving
amendment adds metrics the author wins. Judge it on that.

### Consequence for the claim

`WHY.md` claim 4 is reworded to match: "flattens the cost of the next variant".
Change cost is the claim. Complexity was a proxy for it, and a bad one.

If the experiment resumes with limited budget, run the change-cost arm
(`PROTOCOL-2.md`, tickets 2→4) ahead of the NPath comparison.

---

## Amendment 1

See `PROTOCOL.md`, recorded inline before run 1: ticket-scoped metrics reported
alongside the whole-repo figure, never instead of it.

---

## Results

| | act1 | act2 | act3 | act4 |
|---|---|---|---|---|
| naive chain 1 | maxNPath 3, 77 tests green | maxNPath 4, 79 green, 31 lines into 1 existing file, 0 new types | not run | not run |
| naive chains 2–3 | not run | not run | not run | not run |
| disc chains 1–3 | not run | not run | not run | not run |

`naive_extracted_strategy`, chain 1: **no**. Ticket 2 added a
`CancellationInitiator` parameter to the existing `Visit.cancellationFee` and
branched inside it — the shape `goldens/petclinic/oldway-act2.puml` predicted.
The run reached green unaided, so the naive arm is a competent opponent.

One chain is an anecdote. The falsification condition in `PROTOCOL.md` needs
2 or 3 of 3.
