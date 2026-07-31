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
| 1 | You approve a **change** at design altitude, before code exists | derived before/after diff + the variance reasons behind it | ✅ shipped |
| 2 | The tool **refuses** designs that cannot be built or tested well | Step-1 refusal protocol, 2-axis budget, boundary bracketing pairs, data-flow gate | ✅ shipped, mechanical |
| 3 | So structure is **bounded, uniform, and testable** — every branch gets an address and a receipt | orchestrator stays linear; resolver variance lives in table rows; leaf variance is table-pinned | ✅ by construction |
| 4 | Which keeps **NPath complexity low** and change cost flat | branches are *placed*, not accumulated | 🟡 measuring — 1 of 6 chains |
| 5 | And the reviewer **already understands** the code, having approved its shape | sign-off precedes generation | ⛔ mechanism sound, never tested on anyone outside the project |
| 6 | **Drift cannot return**, because design is derived and never stored | on-demand projection from code | ✅ definitional |
| 7 | And you can **check all of it in 30 seconds** | arrow count equals `verify()` count | ✅ shipped |

**Claims 2 and 6 carry the pitch.** They are the two that do not decay when the
next model ships. Claims 4 and 5 are *consequences* — worth measuring, worth
stating, but not the reason to adopt: "our generated code is better" is a race
against every frontier-model release, and a race DisC does not need to win.

## What DisC does not claim

The limits are part of the argument. A tool that names them is one you can
check.

- **It does not produce good abstractions.** The grammar yields *uniform,
  bounded, testable* structure. Clean is not the same as simple. The
  decomposition itself is still proposed by a model and judged by a human.
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

## How to check these yourself

| Claim | How to check |
|---|---|
| 1, 7 | Open [PR #1](https://github.com/mossgreen/spring-petclinic/pull/1) and [PR #2](https://github.com/mossgreen/spring-petclinic/pull/2) — each opens with a design-only commit. Count the arrows, then count the `verify()` calls in the generated tests. |
| 2 | Hand a malformed design to the plugin: a sealed family with one permit, or a declared boundary without its bracketing pair. It refuses and says why. |
| 3 | Read any generated orchestrator. There is no `if` or `switch` in it. |
| 4 | `experiments/naive-vs-disc/` — pre-registered, PMD-measured, in progress. Predictions were committed before any result existed; see `PROTOCOL.md`. |
| 5 | Not checkable yet. This is the gap. |
| 6 | Derive the same slice twice from unchanged code; the output is byte-identical. Change one line; one arrow changes. |

## Where the evidence lives

- `experiments/naive-vs-disc/PROTOCOL.md` — the pre-registration for claim 4,
  frozen before results, including the outcome that would falsify it.
- `CHANGELOG.md` — what shipped when.
- The plugin's `SKILL.md` and `java_spring.md` — the canonical rules behind
  claims 2, 3 and 7.
