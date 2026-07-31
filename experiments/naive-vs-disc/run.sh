#!/usr/bin/env bash
#
# run.sh — drive one chain (ticket 1 → ticket 2) of one arm, and measure it.
#
#   run.sh --arm naive --chain 1 [--model claude-opus-4-8]
#   run.sh --arm disc  --chain 1
#
# A chain is a single clean PetClinic clone that receives ticket 1, gets
# measured, then receives ticket 2 on top of its own ticket-1 output. Ticket 2
# is where the claim lives, so it must build on whatever that arm actually
# produced — not on a fixture.
#
# Arm `naive` needs nothing but the claude CLI.
# Arm `disc` additionally needs DisC Studio running (./gradlew bootRun) and,
# for ticket 1, the Playwright wizard driver — greenfield .puml assembly lives
# in the frontend, so there is no server-only path to a design.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_ROOT="$(cd "$HERE/../.." && pwd)"
CACHE="$HERE/.cache"
RESULTS="$HERE/results"
M2="$CACHE/m2"                       # shared maven repo: don't re-download per chain
UPSTREAM="https://github.com/spring-projects/spring-petclinic.git"
PIN="${PETCLINIC_PIN:-}"             # empty = record whatever HEAD is at clone time

ARM="" CHAIN="" MODEL="claude-opus-4-8" SKIP_TESTS=""
while [ $# -gt 0 ]; do
    case "$1" in
        --arm)        ARM="$2"; shift 2 ;;
        --chain)      CHAIN="$2"; shift 2 ;;
        --model)      MODEL="$2"; shift 2 ;;
        --skip-tests) SKIP_TESTS=1; shift ;;
        *) echo "unknown arg: $1" >&2; exit 2 ;;
    esac
done
case "$ARM" in naive|disc) ;; *) echo "usage: run.sh --arm naive|disc --chain N" >&2; exit 2 ;; esac
[ -n "$CHAIN" ] || { echo "run.sh: --chain is required" >&2; exit 2; }

command -v claude >/dev/null || { echo "run.sh: claude CLI not on PATH" >&2; exit 3; }

RUN_DIR="$RESULTS/$ARM-chain$CHAIN"
REPO="$RUN_DIR/repo"
LOGS="$RUN_DIR/logs"
mkdir -p "$LOGS" "$M2"

say () { printf '\n\033[1m== %s\033[0m\n' "$*"; }

# --- clean clone --------------------------------------------------------------
say "chain $CHAIN / arm $ARM — preparing clean clone"
mkdir -p "$CACHE"
if [ ! -d "$CACHE/petclinic.git" ]; then
    git clone --quiet --bare "$UPSTREAM" "$CACHE/petclinic.git"
fi
rm -rf "$REPO"
git clone --quiet "$CACHE/petclinic.git" "$REPO"
if [ -n "$PIN" ]; then ( cd "$REPO" && git checkout --quiet "$PIN" ); fi
PETCLINIC_SHA=$( cd "$REPO" && git rev-parse HEAD )

# A local identity so the harness can commit checkpoints without touching
# global git config.
( cd "$REPO" && git config user.email "experiment@local" && git config user.name "disc-experiment" )
BASE=$( cd "$REPO" && git rev-parse HEAD )
echo "  petclinic @ $PETCLINIC_SHA"

# --- helpers ------------------------------------------------------------------
mvn_test () {  # returns 0/1 into TEST_STATUS, never aborts the chain
    local label="$1"
    if [ -n "$SKIP_TESTS" ]; then TEST_STATUS="skipped"; return 0; fi
    # PetClinic runs spring-javaformat:validate in the build, which FAILS the
    # whole run on a formatting nit before a single test executes (TODO.md:202).
    # Normalise formatting first, identically for both arms — it changes layout,
    # never structure, so no NPath/CBO figure moves.
    say "formatting ($label)"
    ( cd "$REPO" && ./mvnw -q -Dmaven.repo.local="$M2" spring-javaformat:apply \
        >"$LOGS/format-$label.log" 2>&1 ) || echo "  javaformat:apply reported an issue (continuing)"
    say "running tests ($label)"
    if ( cd "$REPO" && ./mvnw -q -Dmaven.repo.local="$M2" test >"$LOGS/mvn-$label.log" 2>&1 ); then
        TEST_STATUS="pass"
    else
        TEST_STATUS="fail"
        echo "  tests FAILED — see $LOGS/mvn-$label.log (chain continues; this is data)"
    fi
}

checkpoint () {  # commit current state so the next ticket can diff against it
    ( cd "$REPO" && git add -A && git commit --quiet -m "$1" --allow-empty )
    ( cd "$REPO" && git rev-parse HEAD )
}

# The naive prompt, verbatim from PROTOCOL.md. Deliberately fair: it asks for
# project conventions and tests, and steers toward no particular structure.
naive_prompt () {
    cat "$HERE/tickets/$1.md"
    cat <<'EOF'

Implement this in the existing Spring PetClinic codebase.

- Follow the conventions and style already used in this project.
- Write tests covering every acceptance criterion.
- Make sure the full test suite passes before you finish.
EOF
}

run_naive () {  # run_naive <ticket>
    local ticket="$1"
    say "arm naive / $ticket — invoking claude"
    naive_prompt "$ticket" >"$LOGS/prompt-$ticket.txt"
    # bypassPermissions, not acceptEdits. The prompt tells the naive arm to make
    # the suite pass; acceptEdits blocks Bash, so it cannot run Maven and cannot
    # iterate to green. That handicap would bias the comparison IN DISC'S FAVOUR
    # by leaving the naive arm with failing tests it would otherwise have fixed.
    # The clone is disposable, and full tool access is what a developer using
    # Claude Code actually has.
    ( cd "$REPO" && claude -p "$(cat "$LOGS/prompt-$ticket.txt")" \
        --model "$MODEL" \
        --permission-mode bypassPermissions \
        >"$LOGS/claude-$ticket.log" 2>&1 ) || echo "  claude exited non-zero (see log); continuing"
}

# The analyzer names participants nondeterministically across runs
# (about.md records VisitCanceller vs VisitCancellation for the same story), so
# act2's entry point cannot be hardcoded. Recover it from act1's own design:
# the DisC grammar defines the SUT as the participant the [*] arrow enters.
discover_entry () {
    local puml sut method impl
    puml=$(find "$REPO/design" -maxdepth 1 -name '*.puml' | sort | head -1)
    [ -n "$puml" ] || { echo "discover_entry: no .puml under $REPO/design" >&2; return 1; }

    # [*] -> CancelVisitService : cancel(ownerId, petId, visitId, initiator)
    sut=$(grep -oE '^\[\*\][[:space:]]*->[[:space:]]*[A-Za-z0-9_]+' "$puml" \
          | head -1 | awk '{print $NF}')
    method=$(grep -E '^\[\*\][[:space:]]*->' "$puml" | head -1 \
             | sed -n 's/.*:[[:space:]]*\([A-Za-z0-9_]*\)(.*/\1/p')
    [ -n "$sut" ] && [ -n "$method" ] || { echo "discover_entry: could not parse [*] arrow in $puml" >&2; return 1; }

    # Stage A must derive from a class with a BODY. If the participant resolved
    # to an interface, prefer the Default<Name> implementation the profile emits.
    for cand in "Default$sut" "$sut"; do
        if find "$REPO/src/main/java" -name "$cand.java" | grep -q .; then
            if grep -qE '(class)[[:space:]]+'"$cand"'\b' "$(find "$REPO/src/main/java" -name "$cand.java" | head -1)"; then
                impl="$cand"; break
            fi
        fi
    done
    [ -n "$impl" ] || { echo "discover_entry: no concrete class for participant '$sut'" >&2; return 1; }
    echo "$impl#$method"
}

run_disc () {  # run_disc <ticket>
    local ticket="$1"
    curl -sf http://localhost:8080/api/generator/status >/dev/null 2>&1 || {
        echo "run.sh: DisC Studio not reachable on :8080 — start it with ./gradlew bootRun" >&2
        exit 4
    }
    if [ "$ticket" = "act1" ]; then
        # Greenfield: the design is assembled in the frontend, so the wizard
        # must be driven through a browser. e2e-wizard.js already does exactly
        # this chain (scan → analyze → sequence → gate → .puml).
        say "arm disc / act1 — wizard (scan → analyze → sequence → design)"
        ( cd "$APP_ROOT" && node src/test/js/e2e-wizard.js \
            --repo "$REPO" --model "$MODEL" --out "$LOGS/wizard" \
            >"$LOGS/wizard-$ticket.log" 2>&1 ) || {
                echo "  wizard failed — see $LOGS/wizard-$ticket.log" >&2; return 1; }
    else
        # Variance over existing code: fully CLI-driven.
        local entry
        entry=$(discover_entry) || return 1
        say "arm disc / act2 — derive → diff → apply (entry: $entry)"
        echo "$entry" >"$LOGS/act2-entry.txt"
        ( cd "$APP_ROOT" && DISC_OUT="$LOGS/disc-out" scripts/disc-diff \
            --repo "$REPO" \
            --entry "$entry" \
            --discriminator initiator \
            --callee CancellationFeePolicy \
            --new-variant ClinicInitiatedFee \
            --mapping "owner=StandardCancellationFee,clinic=ClinicInitiatedFee" \
            >"$LOGS/disc-diff-$ticket.log" 2>&1 ) || {
                echo "  disc-diff failed — see $LOGS/disc-diff-$ticket.log" >&2; return 1; }
        ( cd "$APP_ROOT" && DISC_OUT="$LOGS/disc-out" scripts/disc-apply --repo "$REPO" \
            >"$LOGS/disc-apply-$ticket.log" 2>&1 ) || {
                echo "  disc-apply failed — see $LOGS/disc-apply-$ticket.log" >&2; return 1; }
    fi

    say "arm disc / $ticket — generate"
    local puml
    puml=$(find "$REPO/design" -maxdepth 1 -name '*.puml' | sort | tail -1)
    ( cd "$APP_ROOT" && scripts/disc-generate --repo "$REPO" --file "$puml" --model "$MODEL" \
        >"$LOGS/disc-generate-$ticket.log" 2>&1 ) || {
            echo "  disc-generate failed — see $LOGS/disc-generate-$ticket.log" >&2; return 1; }
}

run_arm () { if [ "$ARM" = naive ]; then run_naive "$1"; else run_disc "$1"; fi; }

# --- ticket 1 -----------------------------------------------------------------
run_arm act1 || echo "  act1 generation reported failure; measuring whatever landed"
mvn_test act1; T1_TESTS="$TEST_STATUS"
"$HERE/measure.sh" --repo "$REPO" --out "$RUN_DIR/metrics-act1.json" \
    --since "$BASE" --scope-since "$BASE"
T1=$(checkpoint "act1: $ARM")

# --- ticket 2 -----------------------------------------------------------------
run_arm act2 || echo "  act2 generation reported failure; measuring whatever landed"
mvn_test act2; T2_TESTS="$TEST_STATUS"
"$HERE/measure.sh" --repo "$REPO" --out "$RUN_DIR/metrics-act2.json" \
    --since "$T1" --scope-since "$T1"
T2=$(checkpoint "act2: $ARM")

# --- chain metadata -----------------------------------------------------------
( cd "$REPO" && git diff "$T1" "$T2" -- src/ ) >"$RUN_DIR/act2.diff"
( cd "$REPO" && git diff "$BASE" "$T1" -- src/ ) >"$RUN_DIR/act1.diff"

jq -n --arg arm "$ARM" --arg chain "$CHAIN" --arg model "$MODEL" \
      --arg sha "$PETCLINIC_SHA" --arg base "$BASE" --arg t1 "$T1" --arg t2 "$T2" \
      --arg t1t "$T1_TESTS" --arg t2t "$T2_TESTS" \
  '{arm:$arm, chain:$chain, model:$model, petclinic_sha:$sha,
    refs:{base:$base, after_act1:$t1, after_act2:$t2},
    tests:{act1:$t1t, act2:$t2t},
    naive_extracted_strategy:null,
    note:"naive_extracted_strategy is filled in by hand after reading act2.diff; see PROTOCOL.md"}' \
  >"$RUN_DIR/meta.json"

say "chain complete → $RUN_DIR"
jq -c '{act1_scoped_npath_max: .ticket_scoped.npath.max}' "$RUN_DIR/metrics-act1.json"
jq -c '{act2_scoped_npath_max: .ticket_scoped.npath.max, change_cost: .change_cost}' "$RUN_DIR/metrics-act2.json"
