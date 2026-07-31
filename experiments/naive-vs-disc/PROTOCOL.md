# Pre-registration: naive AI vs DisC — NPath complexity

**Frozen 2026-07-31, before any run.** Nothing in this file may be edited after
the first generation. Corrections go in `REPORT.md` as amendments, dated.

> **Amendment 1 — 2026-07-31, before run 1.** Added a **ticket-scoped** view of
> the same metrics, reported *alongside* the whole-repo figure and never instead
> of it. Reason: dry-running the ruler showed whole-repo NPath is dominated by
> ~840 lines of untouched PetClinic that both arms share (`Owner.getPet` scores
> 6, `VisitController.processNewVisitForm` scores 6), which dilutes the signal
> to noise. The scoped view measures only production files the ticket added or
> modified. Both numbers appear in the report; the scoped one is not a
> substitute for the honest total. No prediction was changed.

## The question

DisC Studio claims that putting a reviewed design between the ticket and the
code produces **lower-complexity, better-structured output than prompting an AI
directly**. That claim has never been measured. `WhyRenderer` computes the
argument for it deterministically, and `goldens/petclinic/oldway-act2.puml`
specifies exactly what the naive version would look like — but line 2 of that
file reads `' the old way — ... never generated`.

This experiment generates the naive version and measures both.

## Operationalization

**"Lower complexity" = lower NPath complexity per method.**

NPath counts acyclic execution paths through a method. It is chosen over
cyclomatic complexity because it is **multiplicative**: two sequential
if/else blocks score NPath 4 but cyclomatic 3, and nesting compounds. It
therefore punishes precisely the shape DisC forbids at the orchestrator
(branches accumulating in one method) and rewards precisely the shape DisC
enforces (a linear orchestrator delegating to table-pinned leaves).

A linear orchestrator scores **NPath = 1** regardless of how many collaborators
it calls. That is the number this experiment is really about.

## Predictions

| Measure | Naive arm | DisC arm |
|---|---|---|
| Orchestrator NPath after ticket 1 | > 1 | **= 1** |
| Orchestrator NPath after ticket 2 | **higher than after ticket 1** | **= 1, unchanged** |
| Max NPath, any production method, after ticket 2 | higher | lower |
| Existing production lines modified by ticket 2 | > 0 | **≈ 0** |
| Existing test lines modified by ticket 2 | > 0 | **0** |
| Total production LOC after ticket 2 | **lower** | higher |
| Production file count after ticket 2 | **lower** | higher |
| Coupling (CBO) of the entry class | higher | lower |

**DisC is predicted to lose the LOC and file-count rows.** That is the trade
being claimed — up-front structure paid for in volume, repaid in change cost.
The report shows both in the same table.

### What would falsify the pitch

Plain Claude Code, given the fair prompt below, spontaneously extracts a
strategy interface for the ticket-2 variance anyway. If that happens in **2 or
3 of 3 naive chains**, DisC's claim weakens from *"achieves good structure"* to
*"guarantees it"*.

**How often the naive arm gets it right unaided is the single most informative
output of this experiment.** It is recorded per chain as a yes/no
(`naive_extracted_strategy`) alongside the numbers.

## Repo

Clean `spring-projects/spring-petclinic` clone, one per chain, reset to a pinned
commit recorded in each chain's `meta.json`. No DisC fixtures, no prior output,
no `design/` directory at start.

## Tickets

Given **verbatim and identically** to both arms. Written as a product person
would write them — no structural hints, no mention of strategies, resolvers,
interfaces, or DisC.

### Ticket 1 — `tickets/act1.md`

> **Cancel a visit**
>
> An owner can cancel a scheduled visit for their pet.
>
> Cancelling close to the appointment time incurs a late-cancellation fee:
>
> - 48 hours or more before the visit: no fee.
> - Less than 48 hours before the visit: a $20.00 fee.
>
> A visit that has already happened cannot be cancelled.
>
> Acceptance criteria:
> - Cancelling 120 hours ahead charges 0.00.
> - Cancelling exactly 48 hours ahead charges 0.00.
> - Cancelling 47 hours ahead charges 20.00.
> - Cancelling 2 hours ahead charges 20.00.
> - Cancelling a past visit is rejected.
> - A cancelled visit is removed from the owner's pet.

### Ticket 2 — `tickets/act2.md`

> **Clinic-initiated cancellations use a different fee**
>
> Sometimes the clinic cancels a visit rather than the owner — a vet is sick, or
> equipment fails. When the clinic is the one cancelling, the owner is never
> charged, no matter how close to the appointment it is.
>
> Owner-initiated cancellations keep the fee rules exactly as they are today.
>
> Acceptance criteria:
> - Clinic-initiated cancellation 2 hours ahead charges 0.00.
> - Owner-initiated cancellation 2 hours ahead still charges 20.00.
> - Existing owner-cancellation behaviour is unchanged.

## Arms

Same model (`claude-opus-4-8`), same repo state, same ticket text. Only the
method differs.

### Arm N — naive

One `claude -p` invocation per ticket, in the target repo. The prompt is what a
competent engineer would actually write. **A strawman prompt would invalidate
the whole experiment**, so it is fixed here and published in the report:

```
<ticket text verbatim>

Implement this in the existing Spring PetClinic codebase.

- Follow the conventions and style already used in this project.
- Write tests covering every acceptance criterion.
- Make sure the full test suite passes before you finish.
```

That is all. No structural steering in either direction — the prompt does not
ask for a strategy pattern, and it does not ask for a quick patch.

### Arm D — DisC

The shipped loop via the existing CLI wrappers, reused as-is:
`scripts/disc-derive`, `scripts/disc-diff`, `scripts/disc-apply`,
`scripts/disc-generate`. Ticket 2 passes `--file` explicitly because
`disc-generate` refuses a repo with multiple `.puml` files.

**Arm D includes human review at sign-off; Arm N includes no human step.** This
asymmetry is real and is stated in the report rather than netted out. The
experiment measures *output structure*, not effort.

## Chains

**3 chains per arm.** Each chain = ticket 1 → ticket 2 on the same clone, so
ticket 2 operates on whatever ticket 1 produced *in that chain*. 6 chains, 12
generations total.

One run is an anecdote. This project already encodes that view in
`EvalConfig.runs()` and its 2/3 pass-rate default. Results report spread, not
just central tendency.

## Metrics

Measured by **PMD 7.26.0, pinned** — third-party, not hand-rolled. The author of
DisC does not get to write the ruler for his own claim.

**Primary — PMD `category/java/design.xml`:**
- `NPathComplexity` — max and mean per method, **production code only**
- `CyclomaticComplexity` — reported alongside, so NPath cannot hide anything
- `CouplingBetweenObjects` — the decoupling half of the claim

**Change cost — `git diff --numstat`, ticket-1 state → ticket-2 state:**
- existing production lines modified
- existing test lines modified
- new files added

**Secondary — Maven surefire:** test count, failures, test LOC.

**Judgment, recorded per chain:** `naive_extracted_strategy` — did the naive arm
produce a polymorphic family (interface/abstract with ≥2 implementations) for
the ticket-2 variance? Yes/no, with the class names as evidence so a reader can
disagree.

Baseline measured on the clean clone before either arm; every figure is a delta.

## Threats to validity

| Threat | Mitigation |
|---|---|
| Model nondeterminism | 3 chains per arm; spread reported |
| Strawman naive prompt | Prompt frozen above, published in report |
| Effort asymmetry (DisC has a human step) | Stated, not netted out |
| Post-hoc metric selection | This file, frozen before run 1 |
| Author measures own claim | Pinned third-party PMD; raw diffs published |
| Cherry-picking | All 6 chains reported, including failed generations |
| Ticket text favouring DisC | Tickets written product-side, no structural vocabulary |

## Out of scope

Claim 5 — *people still understand the generated code* — is not tested here.
Its mechanism is the **sign-off**: the reviewer agreed the structure before the
code existed, so comprehension is constructed rather than recovered afterwards.
That is a claim about the process, not about the artifact, and no measurement in
this experiment speaks to it.
