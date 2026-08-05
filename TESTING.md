# TESTING.md — what the tests defend

The core value: **a structural approval that binds.** A reviewer says "build this
shape" before any code exists, and what gets built is that shape.

This file maps that value to properties, and each property to the tests that
defend it. `CoverageGovernanceTest` reads this file and fails when the map goes
stale, so an untested property shows up as an absence rather than as silence.

### What the governance check cannot do

Three limits, stated because a check whose reach is overestimated is worse than
no check.

- **It cannot judge relevance.** It proves a mapping exists and resolves. Whether
  a listed test defends the property it is listed under still needs a reader.
- **Tracked is not the same as buildable.** It asserts each cited test is known to
  `git ls-files`. It compiles nothing. On 2026-08-01 the index held new test files
  whose production dependencies were unstaged, so a commit of that index would not
  have compiled — and this check was green throughout. **Only CI on a real commit
  closes that gap.**
- **It cannot run without git.** A source export has no `.git`, so the
  tracked-evidence half skips there. The guarantee that it never skips silently is
  `.github/workflows/test.yml`, which fails when the skip count moves off its
  expected value.

## Properties

Each is stated by its failure. A property whose failure costs a user nothing does
not belong here.

| Property | What it defends | Tests | Status |
|---|---|---|---|
| P1a | The derived *before* is faithful to the code, or discloses that it is not | `CallGraphDeriverTest`, `CallGraphDeriverPetclinicTest`, `CallGraphDeriverLombokTest`, `CallGraphDeriverSoundnessTest`, `DerivationStabilityTest`, `DerivationStabilityForeignRepoTest`, `SliceRendererTest` | ✅ |
| P1b | The reviewer **sees** what derivation found, gaps included | `CaptureGapDisclosureTest` | ✅ |
| P2a | Code-half refusals fire | `DataflowLinterTest`, `DesignContractValidatorTest`, `FrontendChainTest` | ✅ |
| P2b | No **false** refusals | `FrontendChainTest` | 🟡 |
| P3a | What the human approved equals what was written | `DesignAgreementTest` | ✅ |
| P3b | What was written equals what was generated | `DesignReceiptTest` | 🟡 |
| P3c | The gates enforcing it fire | `ReviewGateTest`, `WizardMarkupTest`, `DesignLintRoutingTest`, `RunServiceValidateVerdictTest`, `RunServiceStageSidecarsTest`, `ClaudeCodePluginGeneratorTest` | 🟡 |

### Where each status stops

- **P1b — closed 2026-08-05.** The gaps were on the wire the whole time:
  `POST /api/code-derive-by-path` returns the full `DerivedSlice`, and the wizard
  read `data.sliceModel` and discarded `data.slice`. So the Before panel drew a
  partial flow and said nothing about the rest — `slice-act1` shows 3 arrows for
  an 8-call method. It now names each gap above the diagram, and states complete
  capture rather than leaving silence to be interpreted. No backend change was
  needed. Scope: the panel's own markup; the diagram itself is unchanged.
- **P2b — one incident, not the class.** `FrontendChainTest` covers the `ownedBy`
  false refusal. Nothing proves every `DesignContractValidator` rule is
  satisfiable by something the wizard can build.
- **P3a — closed 2026-08-01.** `emitPlantUml` emitted `[*] -> SUT` and
  `[*] <-- SUT` while `renderSequenceDiagram` dropped both steps, so the sign-off
  diagram showed neither the entry signature nor the return type. Both consumers
  now read one `resolveSteps()`, and `DesignAgreementTest` compares the drawn
  labels against the emitted arrows. Scope: one fixture, call and return arrows.
  A create step draws a creation arrow the `.puml` writes as `create X`, which
  the comparison does not cover.
- **P3b — the design side only.** `DesignReceiptTest` counts arrows and decision
  rows from the design. No generated artifact exists in the repo, so nothing
  checks that the plugin emitted a matching number of `verify()` calls.
- **P3c — the dropped-call gate covered, the rest not.** Five of the listed tests
  exist because a mechanism silently stopped running. `ReviewGateTest` now closes
  three ways that gate reported clean without judging: a failed derive, a derive
  still in flight, and a proposal set that counted calls the design emits no arrow
  for. Still untested: ack releases, ack resets when the drop set changes, and
  greenfield stating "no baseline" instead of passing silently.

## Buckets

Every file under `src/test/java` maps to a property above or to a bucket here.
Buckets match by simple name, glob allowed, **first match wins in this order**.
A file matching nothing fails the reverse check, which is the point: classifying
it is a decision someone has to make.

| Bucket | Patterns | Why it defends no product property |
|---|---|---|
| eval | `*EvalTest` | Tagged `eval`, excluded from `./gradlew test`, needs `disc.eval.projectPath`. Costs model calls |
| harness | `BindingTimeClassifierTest`, `DesignDifferTest`, `DesignDeltaValidatorTest`, `DesignDeltaEmitterTest`, `CounterfactualRendererTest`, `DeltaRendererTest`, `CodeDesignDiff*` | Frozen. Guards `/api/code-diff`, `code-diff.html` and `scripts/disc-*` — the CLI path that produced PR #1, PR #2 and experiment Arm D. Real, and no product user reaches it |
| utility | `CatalogFilterTest`, `ElidedTreeRendererTest`, `AnalyzeServicePromptTest` | Infrastructure: catalog filtering, tree rendering, prompt assembly |
| governance | `CoverageGovernanceTest` | Defends this map rather than a product property |
| fixture | `Goldens`, `PetclinicFixtures`, `EvalConfig`, `EvalFixture`, `VisitFeeFixture` | Helpers carrying no `@Test` |

## Rules

1. **Every test names the property it defends** in one javadoc line.
2. **Every test carries an anti-vacuity guard** — show it failing on a genuinely
   broken input. A machine cannot judge "meaningful"; this one stays human.
3. **A gate test is seen failing before its fix.** Commit it red.
4. **Every new gate ships with its liveness test.** Four mechanisms have already
   existed and not run: the soft-pass verdict parser, the refusal panel inside a
   hidden step, the unreachable Stage D guard, and the dropped-call fail-open.
   This rule turns four retrospective patches into a policy.

## Findings

Recorded while building the map. Each one surprised us, and each is worth
keeping rather than forgetting. `TODO.md` and `about.md` are gitignored, so
findings meant to outlive one machine belong here.

**Nothing here is an open defect.** As of 2026-08-05 every defect found is fixed
and covered by a test — 1, 2, 4, 5, 6, 8, 10, 12, 14, 15. The rest are **lessons**
about process and tooling — 3, 7, 9, 11, 13 — kept because they change how the
next piece of work should be done, not because anything is outstanding.

That distinction is load-bearing. An unfixed defect sitting among lessons is
exactly the silence this document exists to prevent, so when one is added it must
say **OPEN** in the first cell.

| # | Finding | Why it matters |
|---|---|---|
| 1 | **The step sequence had three independent resolutions, not two.** `isValidCall` indexed fragment brackets by call ordinal and had to agree with both consumers. | Two audits and the plan all said two. Count before trusting a count. |
| 2 | **Two test files had been untracked for some time** — `WizardMarkupTest` and `DesignLintRoutingTest`, both guarding work `CHANGELOG` describes as shipped. | A fresh clone had neither. Nothing would have noticed without the forward check. |
| 3 | **The first version of `DesignAgreementTest` was vacuous.** It compared `resolveSteps()` to the `.puml` and never observed the renderer; reverting the renderer left it green. | Caught only by deliberately breaking the code. Rule 2 is not optional. |
| 4 | **`CoverageGovernanceTest` shipped with the defect it exists to catch.** Its backtick pattern rejected a leading `*`, so the ``*EvalTest`` bucket parsed to nothing and three classes fell through. Its own reverse check caught it. | A total-pattern floor would have passed. An empty-bucket-row check is what actually catches it. |
| 5 | **The staged index did not compile** — new tests staged, their production changes not. | See "tracked is not buildable" above. The argument for CI, in one incident. |
| 6 | **The dropped-call fail-open was sticky.** `{note}` caching meant later visits replayed the banner and skipped the recompute for the rest of the session. | Worse than first diagnosed. Re-derive the blast radius after finding a gate defect. |
| 7 | **`python3` heredoc rewrites injected NUL bytes into a source file.** It still compiled and still passed, because a join and its matching split were corrupted identically; only `grep` reporting "binary file" exposed it. | Use the editor tooling for source files. A self-consistent corruption survives the test suite. |
| 8 | **`TODO.md` and `about.md` are gitignored.** The roadmap-of-record and the AI handover brief exist on one machine. | Any decision recorded only there is lost to a clone, a collaborator, or a new session. |
| 9 | **`[*]` draws as an ordinary participant box.** PlantUML uses a marker glyph. | Cosmetic, honest, unresolved. A design decision nobody has made. |
| 10 | **A `✅` cited a test that never runs.** `WHY.md` claim 6 listed `DerivationStabilityForeignRepoTest` as demonstrated evidence. It reports 3 tests, 3 skipped, **0 executed** on any plain `./gradlew test` — it gates on `-Ddisc.stability.repo`. The governance predicate rejected `@Tag("eval")` and let this straight through, despite its own javadoc promising to reject "evidence that `./gradlew test` skips". | The second time a check shipped with the defect it exists to catch. Now distinguished mechanically: a skip gated on `System.getProperty` is opt-in and its cell must say so; a toolchain skip (node absent) is not, because CI guarantees the toolchain. |
| 11 | **A stale compiled class reported a red test as green — twice.** `./gradlew test --tests …`, and then the same with `--rerun-tasks`, both printed `BUILD SUCCESSFUL` while running a class compiled 13 minutes earlier. The result XML was never regenerated. Only comparing the `.class` mtime against the source exposed it. | The same "a mechanism existed and did not run" pattern, now in the build tool. **What saved it was rule 3** — insisting on seeing the check fail first. Without that, a governance check that checks nothing would have shipped, and `WHY.md` would have been called honest on the strength of a stale artifact. For a verification run that decides something, force the compile and confirm the class is fresh. CI is unaffected: fresh checkout, no daemon. |
| 12 | **The first fail-open fix introduced a fail-closed trap.** Blocking on a failed derive, while caching the failure, meant the banner replayed on every later visit, the fetch was never retried, and no affordance released it — sign-off locked for the session on one transient error. Found by an adversarial pass over the fix, not by the tests written for it. | A false block that cannot be cleared is how people learn to click past a gate, which `WHY.md` names as worse than a missing one. Only successes are cached now. **Review the fix, not just the defect.** |
| 13 | **`cd` inside a compound shell command persists across later commands.** Several verification runs executed against a temporary export copy instead of the repo, and reported green from the wrong tree. | Two independent "false green" mechanisms in one sitting, with finding 11. Run verification in a subshell, and print `pwd` with the result. |
| 14 | **A fourth resolution released the gate wrongly — fixed 2026-08-05.** `proposedCallSet()` resolved the sequence itself and omitted the caller check `resolveSteps()` applies, so a step whose caller did not resolve emitted **no arrow** while the gate still counted the call as proposed: the design lost a call silently and the gate reported nothing. It now reads the shared selection. `ReviewGateTest.aCallTheDesignDoesNotEmitCountsAsDropped` | A **false release** in the gate built to catch exactly that. The fourth independent walk over the sequence, after the three `resolveSteps()` unified — each one found only by going looking. |
| 15 | **Gradle did not re-run tests when a JS driver changed.** `FrontendChainTest`, `DesignAgreementTest`, `ReviewGateTest` and `CaptureGapDisclosureTest` shell out to `node src/test/js/*.js`, which Gradle cannot see — `ProcessBuilder` reads them from the project directory, not the classpath. A content change left `:test` UP-TO-DATE, reusing the previous results. Proved by removing the fix and re-testing. The same held for `TESTING.md` and `WHY.md`, which `CoverageGovernanceTest` parses at runtime — so editing a claim left the check that polices claims switched off. `build.gradle` now declares both as task inputs | Stale-green as a structural property of the build, not an accident. The third false-green mechanism in two sittings, after 11 and 13 — and the only one that would have persisted forever. |