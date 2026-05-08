# v0.2.0 release runbook

This file is a one-time release artifact — once v0.2.0 is shipped you can delete it.

## What's prepped (already on the branch)

- `build.gradle` version bumped `0.1.0` → `0.2.0`
- `CHANGELOG.md` has a `[v0.2.0] - 2026-05-09` entry at the top
- The release notes (below) are ready to paste into the GitHub Release form

## Step-by-step (what to run)

### 1. Commit the version bump + changelog on the feature branch

```sh
cd /Users/mossgu/Documents/projects/design-is-code-app
git add build.gradle CHANGELOG.md
git commit -m "Release v0.2.0 — bump gradle version, add CHANGELOG entry"
git push
```

### 2. Open + merge the PR

```sh
gh pr create --base main --head feat/design-refresh-and-control-flow \
  --title "v0.2.0 — control-flow fragments + visual refresh" \
  --body "See CHANGELOG.md and RELEASE_v0.2.0.md for details. Closes the design-handoff round; no breaking changes."
```

Open the PR URL gh prints. Review, then merge from the GitHub UI (or with `gh pr merge --squash --admin` if you want to squash from the CLI).

### 3. Pull main, tag, push the tag

```sh
git checkout main
git pull
git tag -a v0.2.0 -m "v0.2.0"
git push origin v0.2.0
```

### 4. Create the GitHub Release

```sh
gh release create v0.2.0 --title "v0.2.0 — Branching, visual refresh, e2e tests" --notes-file RELEASE_v0.2.0.md
```

Or paste the **Release notes** section below into the GitHub UI manually at <https://github.com/mossgreen/design-is-code-app/releases/new?tag=v0.2.0>.

### 5. Clean up

```sh
git branch -d feat/design-refresh-and-control-flow
git push origin --delete feat/design-refresh-and-control-flow
rm RELEASE_v0.2.0.md
git add RELEASE_v0.2.0.md
git commit -m "Remove v0.2.0 release runbook"
git push
```

---

## Release notes (paste into the GitHub Release body)

> # v0.2.0 — Branching, visual refresh, e2e tests
>
> Sequences can now express the full PlantUML control-flow family — if/else, while, for-each, optional, and parallel branches — not just plain loops. Plus a flatter visual identity and a real end-to-end test suite.
>
> ## Highlights
>
> ### Branching in the wizard
>
> The Step 2 composer grew a new **flow control** strip:
>
> | Button | Emits | Has `else`? |
> |---|---|---|
> | `+ loop` | `loop <label> … end` | — |
> | `+ while` | `loop while <cond> … end` | — |
> | `+ for-each` | `loop for each <expr> … end` | — |
> | `+ if/else` | `alt <cond> … else <cond?> … end` | yes |
> | `+ opt` | `opt <cond> … end` | — |
> | `+ par` | `par <branch> … else <branch> … end` | yes |
>
> Each fragment renders as a colored bracket in the live SVG (indigo for loops, teal for alt, violet for opt, cyan for par) with dashed `else` divider lines inside alt/par.
>
> ### Visual refresh
>
> New design-token block, Inter + JetBrains Mono, deep blue accent (`#1e40af`), tighter Linear/Vercel-flat surfaces and 13px base size. ![Step 2 with fragments](https://github.com/mossgreen/design-is-code-app/raw/main/e2e/screenshots/14-step2-fragments.png)
>
> ### End-to-end tests
>
> A Playwright suite in [`e2e/`](./e2e/) — 14 tests covering page load, step navigation, the participant modal, every fragment-add button, and the emitted PlantUML for each fragment type. Run with `cd e2e && npx playwright test` against a running app. Failure artifacts include screenshots + traces.
>
> ## Compatibility
>
> No breaking changes for users of v0.1.0:
>
> - The legacy `LOOP_START` / `LOOP_END` step kinds are preserved as aliases for `FRAG_START` (fragType: `'loop'`) / `FRAG_END`. Existing diagrams in `design/` folders render and emit identically.
> - The `/api/scan`, `/api/design`, and `/api/run-disc` endpoints behave the same.
>
> ## Requirements
>
> - **Java 21+** (unchanged from v0.1.0).
> - Optional, for the "Run it for me" button: the `claude` CLI on `PATH` plus the `design-is-code` plugin.
>
> ## Run
>
> ```sh
> ./gradlew bootRun
> # then open http://localhost:8080
> ```
>
> See [README](./README.md) for the full walkthrough, including the testing section.
