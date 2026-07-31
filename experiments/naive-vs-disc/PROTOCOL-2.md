# Pre-registration 2: does change cost stay flat?

**Written 2026-07-31, after naive chain 1 completed.** `PROTOCOL.md` is frozen
and must not be edited, so this extension is a separate document with an honest
statement of what was already known when it was written.

## What was known at authoring time

Naive chain 1 had finished both tickets:

| | act1 | act2 |
|---|---|---|
| max NPath (touched files) | 3 | **4** |
| existing production lines modified | 59 | **31** |
| new production files | 1 | **0** |
| tests | 77 green | 79 green |

Ticket 2 added a `CancellationInitiator` parameter to the existing
`Visit.cancellationFee` and branched inside it. **No DisC chain had run**, so
nothing was known about the comparison — only about one arm's absolute numbers.

That is the honest bias declaration: the predictions below were written knowing
the naive arm's *first* data point and nothing about DisC's.

## The new question

`PROTOCOL.md` asks whether DisC's output is less complex at one variance step.
This asks the question that actually matters for maintenance:

> **Does the cost of the next variant stay flat, or grow?**

A single variance step can favour either arm by luck. The claim DisC makes is
about the *second, third and fourth* — that placing variance behind a resolver is
an up-front cost that is repaid every time the axis grows.

## Tickets 3 and 4

Same axis (`initiator`), two more variants, given verbatim and identically to both
arms — same terms as `PROTOCOL.md`.

### Ticket 3 — `tickets/act3.md`

> **Insurer-initiated cancellations are billed, not charged**
>
> When an insurer cancels a visit on the owner's behalf, the owner is not charged
> a fee. The amount that would have been the owner's fee is recorded against the
> insurer instead.
>
> Acceptance criteria:
> - Insurer-initiated cancellation 2 hours ahead charges the owner 0.00.
> - Insurer-initiated cancellation 2 hours ahead records 20.00 against the insurer.
> - Owner- and clinic-initiated cancellations are unchanged.

### Ticket 4 — `tickets/act4.md`

> **Cancellations for staff training are always free**
>
> The clinic sometimes cancels visits to run staff training. These are free
> regardless of notice, and are reported separately from ordinary
> clinic-initiated cancellations.
>
> Acceptance criteria:
> - Training-initiated cancellation 2 hours ahead charges 0.00.
> - Training-initiated cancellation is distinguishable from clinic-initiated in
>   the result.
> - All previously specified behaviour is unchanged.

## Predictions

Per ticket, measured the same way `measure.sh` already measures.

| Measure | Naive | DisC |
|---|---|---|
| Existing production lines modified, tickets 2→4 | **rises or stays high** | **≈0 and flat** |
| Existing test lines modified | rises | **0** |
| Max NPath in the varying method | **climbs with each variant** (4 → 5 → 6) | **flat** |
| New files per ticket | ~0 | **1 (+1 table row)** |
| Cumulative production LOC | lower throughout | higher throughout |

**The shape is the claim.** Two lines: naive rising, DisC flat. If DisC's line
also rises, the maintenance argument fails and should be dropped from `WHY.md`
claim 4 — that is what this is for.

### What would falsify it

Any of:

- DisC's existing-lines-modified grows across tickets 3 and 4 — the resolver is
  not actually absorbing the change.
- The naive arm's line stays flat because it extracted a strategy of its own
  accord at ticket 2 or 3. Then DisC's contribution is *guaranteeing* the
  refactor, not achieving it — a weaker claim, and one `WHY.md` would have to
  state instead.
- DisC needs a design change (not just a new variant) to absorb ticket 3 or 4.
  Then "flat" was only true for variants that happen to fit the first design.

Ticket 3 is deliberately chosen to stress this last one: recording an amount
against a *different party* is not purely a fee-value change, so it may not fit
behind the existing `CancellationFeePolicy` contract. If DisC has to widen the
interface, that is a real finding and must be reported as one, not smoothed over.

## Cost and sequencing

4 tickets × 2 arms × 3 chains = 24 generations, double the original. **Do not
start this until the 5 chains outstanding under `PROTOCOL.md` are finished** —
running both at once multiplies an unfinished experiment's cost and produces two
half-answers instead of one whole one.

## Method changes

`run.sh` now takes a ticket list (`--tickets act1,act2,...`) instead of hardcoding
two. Everything else — arms, model, metrics, PMD version, the discard rule for
harness defects — is unchanged from `PROTOCOL.md`.
