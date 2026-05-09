# Release runbook (for the AI agent)

You are reading this because the user said something like *"release it,"* *"release this properly,"* or *"cut a release."* You have no prior context. Follow this end-to-end.

This doc is written **for you** (the agent). The user will not read it during the release; they expect you to drive. Show your work as you go.

---

## Standing rules

1. **Ask before every operation that touches origin or rewrites history.** That means: `git commit`, `git push`, `git tag`, `git push <tag>`, `git push --delete`, `gh release create`, anything `--force`, anything `--no-verify`. Local-only work (reading files, running tests, drafting text) needs no confirmation.
2. **Never invent the version number.** Read the previous tag, look at what changed, propose a bump, and confirm.
3. **Never publish a CHANGELOG entry without showing it to the user first.** Draft → show → wait for explicit approval → commit.
4. **Default to `main`.** Don't create feature branches unless the user asks. Don't open PRs unless the user asks.
5. **No throwaway runbook artifacts.** Do not create `RELEASE_vX.Y.Z.md` files; the changelog is the release notes source.
6. **If `gh auth login` device flow gets stuck**, abandon it and use the GitHub web UI URL (Step 5).
7. **If something is unclear or risky, stop and ask.** Better one extra question than one wrong tag.

---

## Step 1 — Discover state

Run these read-only commands and report findings to the user in one short message before proceeding.

```sh
git rev-parse --abbrev-ref HEAD                         # current branch
git status --short                                      # uncommitted changes
git fetch --tags origin                                 # sync tags
git describe --tags --abbrev=0 2>/dev/null              # last release tag (may be empty for first release)
git log $(git describe --tags --abbrev=0)..HEAD --oneline   # commits since last tag
git remote get-url origin                               # confirms repo for gh / web URL
```

**Decide based on output:**

| Situation | Do this |
|---|---|
| Current branch is not `main` | Ask user: switch to main, or release from this branch? |
| Working tree dirty | Show `git status` to user. Ask: commit these as part of the release, discard, or stash? Don't proceed with a dirty tree. |
| `git log <last-tag>..HEAD` is empty AND tree is clean | **Bail.** Tell the user: "Nothing to release — no commits since `<last-tag>`." Do not invent a no-op release. |
| First-ever release (no tags) | Skip the diff; treat all current `main` commits as the release content. Propose `v0.1.0` unless user says otherwise. |
| Otherwise | Proceed to Step 2. |

---

## Step 2 — Decide the version

Look at `git log <last-tag>..HEAD` (with `--stat` if helpful). Categorise the commits into:

- **Breaking change** — removed/renamed an HTTP endpoint, removed a CLI flag, broke a documented file format, deleted a public class/method. → **MAJOR** bump.
- **New user-visible capability** — new endpoint, new wizard step, new fragment type, new CLI option, new feature flag. → **MINOR** bump.
- **Bug fix or internal-only change** — fix to existing behavior, refactor without API change, doc/tests only. → **PATCH** bump.

The highest category wins. Pre-1.0 (`v0.x.y`), it is acceptable for a MINOR to include a small breaking change — but **call it out explicitly** in the changelog under a `### Breaking` heading and confirm with user.

**Show the user:**

> Last tag: `<v…>`
> Commits since: `<N>` (paste 3–5 most relevant `git log --oneline` lines)
> Proposed bump: **MINOR** (`<v0.x.y>` → `<v0.x+1.0>`)
> Reason: `<one sentence>`

Wait for confirmation or override before continuing.

---

## Step 3 — Draft the CHANGELOG entry

Open `CHANGELOG.md`. Mirror the existing entry format (look at the most recent `## [vX.Y.Z]` section as a template — heading shape, sub-sections, link footer).

Build the entry from the commit list:

- **First line under the heading:** one sentence answering "what changed for someone running this." Not for someone reading commits.
- **Sub-sections** (`### Added` / `### Changed` / `### Fixed` / `### Breaking`) — only include the ones that apply.
- **User-facing language.** "Added foreach fragment to the wizard" — not "Refactored STEP_KIND enum to support foreach."
- **Link footer:** match the existing pattern (almost certainly `[vX.Y.Z]: https://github.com/<owner>/<repo>/releases/tag/vX.Y.Z`). Pull `<owner>/<repo>` from `git remote get-url origin`.

Show the full draft to the user. Wait for "go" / changes / approval. Iterate if asked.

---

## Step 4 — Apply changes & commit

When the changelog draft is approved:

1. **Bump the version.** Edit `build.gradle` (or whatever build manifest lives at the repo root — check `ls *.gradle pom.xml package.json` first). Change the line `version = '<old>'` to `version = '<new>'`. Do not script this with `sed` — just edit the file with the Edit tool, less brittle.
2. **Insert the changelog entry** at the top of `CHANGELOG.md`, immediately after the header preamble and before the previous entry.
3. **Show the user `git diff`** of both files. Confirm.
4. **Ask before commit.** Then:
   ```sh
   git add <build-file> CHANGELOG.md
   git commit -m "Release <vX.Y.Z> — <one-line summary>"
   ```
   The summary is the first line of the changelog entry, trimmed.
5. **Ask before push.** Then `git push origin main` (or current branch if user chose otherwise in Step 1).

---

## Step 5 — Tag and publish

1. **Verify the tag doesn't already exist** locally or remotely:
   ```sh
   git tag --list <vX.Y.Z>
   git ls-remote --tags origin <vX.Y.Z>
   ```
   If either is non-empty, **stop**. Tell the user the tag exists; ask whether to pick a different version or delete the old tag (the latter needs explicit user say-so since it rewrites public state).
2. **Ask before tagging.** Then:
   ```sh
   git tag -a <vX.Y.Z> -m "<vX.Y.Z>"
   ```
3. **Ask before pushing the tag.** Then `git push origin <vX.Y.Z>`.
4. **Create the GitHub Release.** Two paths — try the first; if it fails, fall back.

   **Path A — `gh` CLI:**
   ```sh
   gh auth status        # check first
   ```
   If logged in, draft the body by reading the changelog section for this version (everything from `## [vX.Y.Z]` to the next `## [`, exclusive). Then ask before publishing:
   ```sh
   gh release create <vX.Y.Z> \
     --title "<vX.Y.Z> — <headline from changelog>" \
     --notes "<changelog section body>"
   ```

   **Path B — web UI (use when `gh` not logged in or device flow stuck):**
   Tell the user: open this URL, paste the title and the changelog section into the form, click Publish. URL pattern (substitute owner/repo from `git remote get-url origin`):
   ```
   https://github.com/<owner>/<repo>/releases/new?tag=<vX.Y.Z>
   ```
   Wait for user to confirm published.

---

## Step 6 — Verify

Run:

```sh
git fetch --tags origin
git ls-remote --tags origin <vX.Y.Z>          # tag is on origin
gh release view <vX.Y.Z> 2>/dev/null || true  # release page exists (skip silently if gh not authed)
git log -1 --pretty=format:'%h %s' main       # last commit is the release commit
```

Report the outcome to the user in 2-3 lines max:

> Released `<vX.Y.Z>`. Tag pushed, GitHub release published, `main` at `<sha>`.

Done. **Do not** delete branches, remove "runbook" files, or do any cleanup unless the user asks.

---

## Failure modes

| Symptom | Action |
|---|---|
| Pre-commit / pre-push hook fails | Surface the hook output. Investigate root cause. **Do not bypass with `--no-verify`** unless user explicitly says to. |
| `git push` rejected (non-fast-forward) | Someone else pushed. Run `git pull --rebase`, re-show diff to user, ask before re-pushing. |
| Tag already exists | Stop. Ask user: pick a different version, or delete the existing tag (needs explicit user say-so — destructive). |
| `gh auth login` hangs on device code | Abandon `gh`. Use Path B (web UI) for release publishing. |
| `gh release create` rejects body too long | Trim the changelog section, or upload as `--notes-file` from a tempfile. |
| User wants a pre-release | Add `--prerelease` to the `gh release create` command, or check the "Set as a pre-release" box in the web UI. Tag format suggestion: `vX.Y.Z-rc.1`. |
| Just-published release is wrong | **Fix forward** — bump patch, write a new changelog entry explaining the fix, do another release. Do not delete or edit the published release unless user asks (it's already visible). |
| Need to rollback a bad release | Tell the user: revert the offending commits on `main`, release a new patch version. The bad release stays in history with a note in the next release's changelog. |

---

## What this doc deliberately omits

- **Pre-release testing.** Assume the user ran tests before saying "release it." If you suspect they didn't, ask once; don't gate the release on it.
- **Build artifacts (jar, dockerfile, etc).** This project doesn't ship binaries — Gradle build is the user's local concern.
- **CI / signing / notarization.** None apply.
- **Communication / announcements.** None for this project.

If the user asks for any of the above during a release, ask them to clarify what they want and add a section to this doc afterward so future-you knows.
