# Why DisC

> DisC makes an AI's structural decisions reviewable before the code exists,
> refuses the ones that can't be tested cleanly, and derives the design from code
> afterwards so it can never drift.

The bet: **the bottleneck in AI coding is review, not generation.** Models write
working code faster than anyone can judge whether it is the *right* code.
Reviewing a 400-line diff means weighing a thousand decisions where most are
mechanical and a few are load-bearing, with nothing marking which is which.

This file is the canonical claim set. Each claim carries its mechanism and the
honest status of its evidence — `✅` demonstrated, `🟡` being measured, `⛔` not
yet tested. A claim with no evidence column is a claim nobody has checked.

## The chain

Each link forces the next. That ordering is the argument; the list is not a
grab-bag of features.

| | Claim | Mechanism | Evidence |
|---|---|---|---|
| 1 | You approve a **change** at design altitude, before code exists | derived before/after diff + the variance reasons behind it | ✅ shipped — two public PRs open design-only |
| 2 | The tool **refuses** designs that cannot be built or tested well | Step-1 refusal protocol, boundary bracketing pairs, data-flow gate, sidecar lint | ✅ **`DataflowLinterTest`** (22 cases, both directions), **`DesignDeltaValidatorTest`** (10), **`DesignContractValidatorTest`** — all deterministic. ⚠️ The *plugin-side* half is not: see below |
| 3 | So structure is **bounded, uniform, and testable** — every branch gets an address and a receipt | orchestrator stays linear; resolver variance lives in table rows; leaf variance is table-pinned | ✅ **`DesignReceiptTest`** — the orchestrator has zero fragments; the naive version of the same ticket has three |
| 4 | Which keeps **NPath complexity low** and change cost flat | branches are *placed*, not accumulated | 🟡 measuring — `experiments/naive-vs-disc`, 1 of 6 chains |
| 5 | And the reviewer **already understands** the code, having approved its shape | sign-off precedes generation | ⛔ mechanism sound, never tested on anyone outside the project |
| 6 | **Drift cannot return**, because design is derived and never stored | on-demand projection from code | ✅ **`DerivationStabilityTest`** (DisC-shaped fixture) + **`DerivationStabilityForeignRepoTest`** (any repo, opt-in) — five derivations byte-identical, a comment moves nothing, one added call moves exactly one arrow |
| 7 | And you can **check all of it in 30 seconds** | arrow count equals `verify()` count | ✅ **`DesignReceiptTest`** computes the expected receipt from the design alone (6 calls, 2 rows) — the same counts the real generation produced |

Every `✅` above names a test you can run with `./gradlew test`. None of them
costs a model call, so the proofs are reproducible on a laptop in seconds — and
they fail if the property ever regresses, which a report cannot do.

**Claims 2 and 6 carry the pitch.** They are the two that do not decay when the
next model ships. Claims 4 and 5 are *consequences* — worth measuring, worth
stating, but not the reason to adopt: "our generated code is better" is a race
against every frontier-model release, and a race DisC does not need to win.

## What the grammar actually enforces

Claim 3 is not "uniform structure, no opinion about quality" — but the strength
of the guarantee differs by rule, and conflating the tiers is how a pitch loses
its credibility. Three tiers, weakest last.

**Tier 1 — refused. The design is rejected and told why.**

| Failure mode | Where |
|---|---|
| A "family" with one member — a `sealed-interface` with <2 permits | plugin Step 1 |
| An unstated numeric threshold — a declared `boundary` with no bracketing pair | plugin Step 1 |
| A decision the table neither demonstrates nor pins in `config:` | plugin Step 1 |
| A finite-domain input column not covered by its rows | plugin Step 1 |
| A type reference DisC cannot place | plugin Step 1 |
| An argument no earlier step produces — severed data flow | `DataflowLinter`, app-side |
| A method called on a reused type that the codebase scan says has no such method | `DataflowLinter`, app-side |
| A decision table targeting a call the design never makes, or mapping the same inputs to two outputs | sidecar lint, app-side |
| **Over-abstraction** — a one-variant strategy family | Stage C asks instead of generating (`8c64798`) |

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

So: DisC mechanically refuses **over**-abstraction and eight other named
failures, and holds a stated position on which abstraction fits a given variance
shape — but its anti-**under**-abstraction rule is a prompt, not a gate. Closing
that gap (making the 2-axis budget a Step-1 refusal) is the single biggest
available upgrade to claim 3.

## What DisC does not claim

The limits are part of the argument. A tool that names them is one you can
check.

- **It does not choose your axis of variance, or name things well.** DisC has
  real opinions about seams and enforces several of them mechanically — see
  *What the grammar actually enforces* below. What it cannot do is domain
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
  grammar spec, which does not exist yet.
- **Its softer design rules are advisory, not enforced.**
  `R2-purpose-specificity`, `R4a-feature-envy`, `leaf-freestandingness` and
  `composition-over-inheritance` live in `prompts/rules/` and are **judged by a
  model**, single-sourced into the analyzer's guidance and its self-check. They
  express the right preferences; they do not guarantee them run to run. Only the
  mechanical list below is a guarantee.
- **No one outside this project has said the seams are right.** The mechanical
  rules prevent named failure modes; whether the result reads as *well
  abstracted* to an experienced engineer is untested. Same gap as claim 5.
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

## How to check these yourself

`./gradlew test` runs every proof below except claims 4 and 5. No model calls.

| Claim | How to check |
|---|---|
| 1, 7 | Open [PR #1](https://github.com/mossgreen/spring-petclinic/pull/1) and [PR #2](https://github.com/mossgreen/spring-petclinic/pull/2) — each opens with a design-only commit. Count the arrows, then count the `verify()` calls in the generated tests. `DesignReceiptTest` computes the expected count from the design alone. |
| 2 | `DataflowLinterTest` and `DesignDeltaValidatorTest` — each refusal has a case, and each has a counterpart proving correct designs are *not* refused. Or hand the plugin a sealed family with one permit and watch Step 1 explain itself. |
| 3 | `DesignReceiptTest.theDiscOrchestratorContainsNoBranchAtAll`, beside `theNaiveVersionOfTheSameTicketDoesBranchInTheOrchestrator` — same ticket, one design with three fragments and one with none. |
| 4 | `experiments/naive-vs-disc/` — pre-registered, PMD-measured, in progress. Predictions were committed before any result existed; see `PROTOCOL.md` and `PROTOCOL-2.md`. |
| 5 | Not checkable yet. This is the gap. |
| 6 | `DerivationStabilityTest` — derives five times and compares bytes, then proves a comment changes nothing and one added call adds exactly one arrow. Both edit tests were confirmed to *fail* when given a real change, so they are not passing vacuously. Then run it on **your own** repository, which needs no model calls:<br>`./gradlew test --tests '*ForeignRepo*' -Ddisc.stability.repo=<path> -Ddisc.stability.entry=Class#method` |

## Where the evidence lives

- `experiments/naive-vs-disc/PROTOCOL.md` — the pre-registration for claim 4,
  frozen before results, including the outcome that would falsify it.
- `CHANGELOG.md` — what shipped when.
- The plugin's `SKILL.md` and `java_spring.md` — the canonical rules behind
  claims 2, 3 and 7.
