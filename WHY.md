# Why DisC

> DisC makes an AI's structural decisions reviewable before the code exists,
> refuses the ones that can't be tested cleanly, and derives the design from code
> afterwards so the two can never drift apart.

The bet: **the bottleneck in AI coding is review, not generation.** Models write
working code faster than anyone can judge whether it is the *right* code.
Reviewing a 400-line diff means weighing a thousand decisions where most are
mechanical and a few are load-bearing, with nothing marking which is which.

This file is the canonical claim set. Each claim carries its mechanism and the
honest status of its evidence — `✅` demonstrated, `🟡` being measured, `⛔` not
yet tested. A claim with no evidence column is a claim nobody has checked.

## The claims

Claims 1 and 2 together produce claim 3. Claim 3 produces claims 4 and 7. Claim 1
alone produces claim 5. Claim 6 rests on the derive-on-demand architecture and
stands by itself. Where a claim's mechanism belongs to a different claim, the
table says so.

| | Claim | Mechanism | Evidence |
|---|---|---|---|
| 1 | You approve a **change** at design altitude, before code exists | derived before/after diff (**both surfaces**) + the variance reasons behind it — in the wizard those are the analyzer's `variancePlan`, model-generated, not `WhyRenderer`'s deterministic output | ✅ artifact shipped — two public PRs open design-only. ⚠️ Both self-approved: no reviewer outside this project has used the surface. Same missing experiment as claim 5 — one outside reviewer closes both |
| 2 | The tool **refuses** designs that cannot be built or tested well | Step-1 refusal protocol, boundary bracketing pairs, data-flow gate, sidecar lint | ✅ **`DataflowLinterTest`** (22 cases, both directions), **`DesignDeltaValidatorTest`** (10, **harness**), **`DesignContractValidatorTest`** — all deterministic. ⚠️ Two gaps: the plugin-side half is not deterministic (see below), and `DesignDeltaValidator`'s 10 cases guard `/api/code-diff`, not the wizard |
| 3 | So structure is **bounded, uniform, and testable** — every branch gets an address and a receipt | orchestrator stays linear; resolver variance lives in table rows; leaf variance is table-pinned | ✅ **`DesignReceiptTest`** — the DisC orchestrator has zero fragments; the naive counterfactual for the same ticket has three. That counterfactual (`goldens/petclinic/oldway-act2.puml`) is hand-authored. Naive chain 1 of `experiments/naive-vs-disc` confirmed the *prediction* behind it — the naive arm inlined the variance instead of extracting a seam, reaching green unaided — but not the same shape: it added an enum, an overload and one `if` to the static `Visit.cancellationFee`, with no orchestrator and no strategy participants |
| 4 | Which **flattens the cost of the next variant** | branches are *placed*, not accumulated — a new variant arrives as a table row plus a leaf, leaving existing code untouched | ⛔ the comparison has not started — 1 chain in the naive arm, **0 in the DisC arm** (`REPORT.md`: *"The DisC arm has never run"*). The decisive numbers will be existing-lines-modified and `naive_extracted_strategy`; max NPath is reported but does not discriminate, because a linear orchestrator scores 1 by construction. See `REPORT.md` amendment 2 |
| 5 | Comprehension is **built at sign-off**, before the code exists — the reviewer approved the structure the generator then produced | sign-off precedes generation (claim 1); the orchestrator's structure is determined by the design | ⛔ never tested on anyone outside the project. Scoped to structure: leaf behaviour is sampled, so this says nothing about what a leaf does between its table rows |
| 6 | **Design/code drift cannot return**, because the *before* view is derived and never stored | on-demand projection from code. The *proposal* is stored — written to `design/`, committed, and ageing as a dated decision | ✅ **`DerivationStabilityTest`** (determinism — five derivations byte-identical, a comment moves nothing, one added call moves exactly one arrow) **and `CallGraphDeriverSoundnessTest`** (fidelity — every call in the entry body is captured as an arrow or disclosed as a gap). Determinism alone is satisfied by a projection that silently drops calls; until 2026-08-01 this one did. **`DerivationStabilityForeignRepoTest`** extends the same properties to any repository, and is **opt-in** — it skips unless you pass `-Ddisc.stability.repo`, so a plain `./gradlew test` never runs it |
| 7 | And you can **check that every designed interaction has a test**, in 30 seconds | arrow count equals `verify()` count (claim 3's invariant) | ✅ **`DesignReceiptTest`** computes the expected receipt from the design alone (6 calls, 2 rows). That the plugin then emits 6 matching `verify()` calls is recorded in PR #2 — no test in this repo checks the equality |

Every `✅` except claim 1's names a test. Run them with `./gradlew test`. Claim
1's is an artifact you can open. No test costs a model call, so the proofs run on
a laptop in seconds. They fail if a property regresses, which a report cannot do.

That the `✅`s stay honest is itself enforced: **`TESTING.md`** maps the value to
testable properties, and `CoverageGovernanceTest` fails the build when a claim
here cites a test that does not exist, is untracked, or does not run. It also
records what the checking cannot reach.

**Claims 2 and 6 carry the pitch.** They are the two that do not decay when the
next model ships. Claims 4 and 5 are *consequences* — worth measuring, worth
stating, but not the reason to adopt: "our generated code is better" is a race
against every frontier-model release, and a race DisC does not need to win.

## Which path each mechanism runs on

DisC Studio ships two surfaces. The **wizard** is the product: the analyzer
proposes a design, `/api/design/lint` checks it, `/api/design` saves it. The
**code→design harness** derives a design and diffs a variant request against it,
deterministically; `code-diff.html` and `scripts/disc-diff` drive it. Both call
the same `CallGraphDeriver`, so the derived *before* view is identical.
Everything downstream of derivation differs.

| Mechanism | Wizard | Harness |
|---|---|---|
| Derived "before" (`CallGraphDeriver`) | ✅ | ✅ |
| `DataflowLinter`, `DesignContractValidator` | ✅ | — |
| "Why this design" | analyzer's `variancePlan` — **model-generated** | `WhyRenderer` — deterministic |
| `DesignDeltaValidator`, `DesignDiffer` (Stage C `ASK`), `CounterfactualRenderer` | — | ✅ |

Claims are marked **(harness)** where the two diverge. A harness-only mechanism
is real and tested. It does not protect a wizard user.

## What the grammar actually enforces

Claim 3 is not "uniform structure, no opinion about quality" — but the strength
of the guarantee differs by rule, and conflating the tiers is how a pitch loses
its credibility. Three tiers, weakest last.

**Tier 1 — mechanically checked.** Nine named failure modes at two strengths. One
refuses. The other warns and can be waived. They are listed apart because that
gap is exactly what a reader needs to see.

**Tier 1a — refused at Generate. No acknowledge path.** The plugin stops and
explains; nothing proceeds.

| Failure mode | Where |
|---|---|
| A "family" with one member — a `sealed-interface` with <2 permits | plugin Step 1; also mirrored app-side in `DesignContractValidator` |
| An unstated numeric threshold — a declared `boundary` with no bracketing pair | plugin Step 1; also mirrored app-side |
| A decision the table neither demonstrates nor pins in `config:` | plugin Step 1 |
| A finite-domain input column not covered by its rows | plugin Step 1 |
| A type reference DisC cannot place | plugin **Step 5** — fires mid-generation, so the Step-4 `--validate-only` preflight (which runs Step 1 only) cannot catch it |

**Tier 1b — flagged at Sign-off, and acknowledgeable.** Deterministic app-side
code runs at Step 3 and disables the Next button. The reviewer fixes the design
or ticks an acknowledge box. A false refusal must not be a dead end — see
*Deterministic does not mean correct* below — but a reviewer can click past a
true one just as easily, and nothing server-side re-checks. `POST /api/design`
writes the `.puml` either way.

| Failure mode | Where |
|---|---|
| An argument no earlier step produces — severed data flow | `DataflowLinter`, app-side |
| A method called on a reused type that the codebase scan says has no such method | `DataflowLinter`, app-side |
| A decision table targeting a call the design never makes, or mapping the same inputs to two outputs | sidecar lint, app-side |

**Not reachable from the wizard.** **Over-abstraction**, a one-variant strategy
family, is refused by `DesignDiffer` Stage C (`8c64798`). Stage C runs only in
the code→design harness.

**Tier 2 — hard to express. The notation resists it.** Branching at the
orchestrator has nowhere to go except a fragment or one of the four pattern
hosts; domain types resolve as interfaces via the Domain Type Rule. Not a
refusal, but not something a design falls into by accident either.

**Tier 3 — advisory. A model is asked, and usually complies.** The **2-axis
budget** ("if a participant would need more than 2 axes, mark it non-leaf") and
the **pattern selection priority** — rule-table → resolver → sealed-polymorphism
→ in-method matching, where *"lower-numbered patterns have lower coupling and
lower test-nesting cost"* — both live in `prompts/analyzer.md`, alongside
`R2-purpose-specificity`, `R4a-feature-envy`, `leaf-freestandingness` and
`composition-over-inheritance`. These are the rules most directly about
*abstraction quality*, and they are the ones DisC does **not** guarantee.

So: DisC mechanically refuses eight named failures. It refuses
**over**-abstraction as well, but only in the code→design harness — the widest
reachability gap in this table. It also holds a stated position on which
abstraction fits a given variance shape. But its anti-**under**-abstraction rule
is a prompt, not a gate. Making the 2-axis budget a Step-1 refusal is the biggest
available upgrade to claim 3.

## What DisC does not claim

The limits are part of the argument. A tool that names them is one you can
check.

- **It does not choose your axis of variance, or name things well.** DisC has
  real opinions about seams and enforces several of them mechanically — see
  *What the grammar actually enforces* above. What it cannot do is domain
  modelling: it checks that a design is sound **given** that `initiator` is the
  axis you are varying on, and cannot tell you the business really varies by
  service type and you modelled the wrong thing. Nor does it judge names —
  analyzer naming is still unstable across runs (`VisitCanceller` vs
  `VisitCancellation`), and a bad name is a bad abstraction.
- **Half the refusals are deterministic; the other half are a model's opinion.**
  The rules the app checks itself (`DataflowLinter`, `DesignContractValidator`,
  `DesignDeltaValidator`) are plain code: same design, same verdict, every time.
  The plugin's Step 1 is not. It is deterministic rule-checking *written as prose
  and executed by a language model*, and on 2026-08-01 the same design was
  **refused by Haiku and accepted by Sonnet**. Validation now asks a capable
  model, and `PluginContractEvalTest` pins the rules whose verdicts are observed
  to be stable — but "the tool refuses" is only literally true for the half that
  runs as code. Making the whole of it deterministic needs a machine-readable
  grammar spec, which does not exist yet. Note also that `DesignDeltaValidator`
  runs in the code→design harness only; the wizard's deterministic half is
  `DataflowLinter` and `DesignContractValidator`.
- **Deterministic does not mean correct.** The code half gives the same verdict
  every time; it can still give the same *wrong* verdict every time. On
  2026-08-01 the contract checks were pointed at the wizard's design state
  without re-auditing rules written against the analyzer's output, and one of
  them — every entity must name an owning participant — then refused every design
  a human authored by hand, because nothing the wizard builds carries that field.
  Caught the same day, before any release. A false refusal is worse than a
  missing one: it blocks work that was fine, and teaches people to click past the
  gate. That is why the Step-3 contract block can be acknowledged rather than
  being absolute, and why `PluginContractEvalTest` checks both directions.
- **Its softer design rules are advisory, not enforced.**
  `R2-purpose-specificity`, `R4a-feature-envy`, `leaf-freestandingness` and
  `composition-over-inheritance` live in `prompts/rules/` and are **judged by a
  model**, single-sourced into the analyzer's guidance and its self-check. They
  express the right preferences; they do not guarantee them run to run. Only the
  Tier-1 list above is a guarantee.
- **No one outside this project has said the seams are right.** The mechanical
  rules prevent named failure modes; whether the result reads as *well
  abstracted* to an experienced engineer is untested. Same gap as claim 5.
- **It imposes one shape.** DisC fits variance that dispatches on a
  discriminator. A pipeline, a state machine, a parser — those decompose
  differently. The grammar will produce resolvers and tables anyway. DisC checks
  a design for soundness. Fit is your judgement.
- **The PR record is a decision with a date on it.** Deriving design from code
  kills design/code drift by construction. Six months later, only a human can say
  whether the agreed structure still holds. Intent drift moves to the PR timeline
  and ages there.
- **It does not eliminate branching.** It places it. Orchestrator: none.
  Resolver: table rows. Leaf: pinned by a decision table, where a declared
  boundary needs a bracketing pair. "Every branch has an address and a receipt"
  is the claim — never "no if-else".
- **Leaf behaviour is sampled, not determined.** A decision table pins behaviour
  at its rows and at declared boundaries. Between rows the algorithm is free —
  interpolation risk is real and named.
- **Side-effect leaves get no behavioural test.** They are mocked and verified
  for interaction only.
- **Java/Spring only.** The methodology is language-neutral; one profile exists.
- **Generation is verified on one repository.** Both acts on `spring-petclinic`,
  zero hand edits. One repo is evidence, not a guarantee.
- **Derivation stability is proven where it has been run, not everywhere.**
  `DerivationStabilityTest` runs against a DisC-shaped fixture;
  `DerivationStabilityForeignRepoTest` has been run against upstream
  `spring-petclinic` (30 sources, `VisitController#processNewVisitForm`) and
  holds. That is two codebases. The test is opt-in and costs nothing, so the
  honest position is "point it at yours and find out" — not "it always holds".
  On that upstream run DisC also reported `captureComplete=false`, correctly
  refusing to claim it had understood a body containing a branch and a chained
  static call; a partial derivation is disclosed, not hidden.

## The alternative this has to beat

Most teams have a second answer: **stop reviewing.** Make failure cheap and
detectable. Heavy tests, strong types, CI, canaries. Regenerate instead of
repairing. It costs nothing and needs no notation. Comparing DisC to a 400-line
diff leaves this answer standing.

DisC's answer is **blast radius**. Structure bounds how far a change reaches.
Nobody has to read the code for that to hold. Rewrite a leaf behind a pinned
contract; the orchestrator's tests stay green. Add a variant as a table row;
existing code is untouched. Both hold when an agent does the maintaining.
Regenerate-don't-repair reports the break and leaves the radius unknown.

Claim 4 measures this. The codegen-quality axis beside it decays each model
release. Claim 4 still earns its place. Change cost (`PROTOCOL-2`) carries the
argument. Complexity (`PROTOCOL.md`) decorates it.

## How to check these yourself

`./gradlew test` runs every test named below, with no model calls. Claims 1, 4
and 5 need something else: two PRs, an experiment, and a person.

| Claim | How to check |
|---|---|
| 1, 7 | Open [PR #1](https://github.com/mossgreen/spring-petclinic/pull/1) and [PR #2](https://github.com/mossgreen/spring-petclinic/pull/2) — each opens with a design-only commit. Count the arrows, then count the `verify()` calls in the generated tests. `DesignReceiptTest` computes the expected count from the design alone. |
| 2 | `DataflowLinterTest` (wizard) and `DesignDeltaValidatorTest` (harness) — each refusal has a case, and each has a counterpart proving correct designs are *not* refused. Or hand the plugin a sealed family with one permit and watch Step 1 explain itself. |
| 3 | `DesignReceiptTest.theDiscOrchestratorContainsNoBranchAtAll`, beside `theNaiveVersionOfTheSameTicketDoesBranchInTheOrchestrator` — same ticket, one design with three fragments and one with none. The naive design is hand-authored. Naive chain 1 confirmed its prediction — inline the variance, do not extract a seam — but produced a different shape: read `results/naive-chain1/act2.diff`. |
| 4 | `experiments/naive-vs-disc/` — pre-registered and PMD-measured, but the DisC arm has not run, so there is nothing to compare yet. Predictions were committed before any result existed; see `PROTOCOL.md`, `PROTOCOL-2.md`, and `REPORT.md` for the dated amendments. The change-cost rows will carry the result. |
| 5 | Not checkable yet. Needs one reviewer outside this project — the same person claim 1 needs. |
| 6 | `DerivationStabilityTest` — derives five times and compares bytes, then proves a comment changes nothing and one added call adds exactly one arrow. Commit `0164796` records that both edit tests were confirmed to *fail* on a real change before being accepted; no test in the repo reproduces that check. `CallGraphDeriverSoundnessTest` carries the fidelity half — every call in the entry body is captured as an arrow or disclosed as a gap. Then run it on **your own** repository, which needs no model calls:<br>`./gradlew test --tests '*ForeignRepo*' -Ddisc.stability.repo=<path> -Ddisc.stability.entry=Class#method` |

## Where the evidence lives

- `experiments/naive-vs-disc/PROTOCOL.md` — the pre-registration for claim 4,
  frozen before results, including the outcome that would falsify it.
- `CHANGELOG.md` — what shipped when.
- The plugin's `SKILL.md` and `java_spring.md` — the canonical rules behind
  claims 2, 3 and 7.
