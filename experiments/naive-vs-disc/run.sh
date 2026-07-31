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

ARM="" CHAIN="" MODEL="claude-opus-4-8" SKIP_TESTS="" TICKET_ARG="act1,act2"
while [ $# -gt 0 ]; do
    case "$1" in
        --arm)        ARM="$2"; shift 2 ;;
        --chain)      CHAIN="$2"; shift 2 ;;
        --model)      MODEL="$2"; shift 2 ;;
        --tickets)    TICKET_ARG="$2"; shift 2 ;;
        --skip-tests) SKIP_TESTS=1; shift ;;
        *) echo "unknown arg: $1" >&2; exit 2 ;;
    esac
done
# Ordered ticket list; each runs on top of the previous one's output. Defaults to
# PROTOCOL.md's two; PROTOCOL-2.md extends it to four to test whether change cost
# stays flat.
IFS=',' read -r -a TICKETS <<< "$TICKET_ARG"
[ "${#TICKETS[@]}" -gt 0 ] || { echo "run.sh: --tickets must name at least one" >&2; exit 2; }
for t in "${TICKETS[@]}"; do
    [ -f "$HERE/tickets/$t.md" ] || { echo "run.sh: no tickets/$t.md" >&2; exit 2; }
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

# The variance request the human supplies when running disc-diff: which callee
# varies, what the new variant is called, and how discriminator values map to
# strategies. Mappings are CUMULATIVE — by act4 every initiator value must still
# resolve, or the resolver would silently drop a case.
#
# This is Arm D's human contribution, and it is information Arm N does not get.
# That asymmetry is real and disclosed (PROTOCOL.md, "Arms"): the experiment
# measures output structure, not effort. It is written here as data so a reader
# can see exactly what was supplied rather than take it on trust.
variant_spec () {  # variant_spec <ticket> -> "callee|newVariant|mapping"
    case "$1" in
        act2) echo "CancellationFeePolicy|ClinicInitiatedFee|owner=StandardCancellationFee,clinic=ClinicInitiatedFee" ;;
        act3) echo "CancellationFeePolicy|InsurerInitiatedFee|owner=StandardCancellationFee,clinic=ClinicInitiatedFee,insurer=InsurerInitiatedFee" ;;
        act4) echo "CancellationFeePolicy|TrainingCancellationFee|owner=StandardCancellationFee,clinic=ClinicInitiatedFee,insurer=InsurerInitiatedFee,training=TrainingCancellationFee" ;;
        *) echo "" ;;
    esac
}

run_disc () {  # run_disc <ticket>
    local ticket="$1"
    curl -sf http://localhost:8080/api/generator/status >/dev/null 2>&1 || {
        echo "run.sh: DisC Studio not reachable on :8080 — start it with ./gradlew bootRun" >&2
        exit 4
    }
    if [ "$ticket" = "${TICKETS[0]}" ]; then
        # The FIRST ticket is greenfield: no prior flow to derive from, and the
        # design is assembled in the frontend, so the wizard must be driven
        # through a browser. e2e-wizard.js already does that chain (scan →
        # analyze → sequence → gate → .puml). Every later ticket is a variance
        # change over the previous ticket's own output, which the CLI handles.
        say "arm disc / $ticket — wizard (scan → analyze → sequence → design)"
        ( cd "$APP_ROOT" && node src/test/js/e2e-wizard.js \
            --repo "$REPO" --model "$MODEL" --out "$LOGS/wizard" \
            >"$LOGS/wizard-$ticket.log" 2>&1 ) || {
                echo "  wizard failed — see $LOGS/wizard-$ticket.log" >&2; return 1; }
    else
        # Variance over existing code: fully CLI-driven.
        local entry spec callee newvariant mapping
        entry=$(discover_entry) || return 1
        spec=$(variant_spec "$ticket")
        [ -n "$spec" ] || { echo "  no variant_spec for $ticket — add one before running it" >&2; return 1; }
        callee=${spec%%|*}
        newvariant=$(echo "$spec" | cut -d'|' -f2)
        mapping=${spec##*|}
        say "arm disc / $ticket — derive → diff → apply (entry: $entry, new: $newvariant)"
        printf 'entry=%s\ncallee=%s\nnewVariant=%s\nmapping=%s\n' \
            "$entry" "$callee" "$newvariant" "$mapping" >"$LOGS/$ticket-variant-request.txt"
        ( cd "$APP_ROOT" && DISC_OUT="$LOGS/disc-out" scripts/disc-diff \
            --repo "$REPO" \
            --entry "$entry" \
            --discriminator initiator \
            --callee "$callee" \
            --new-variant "$newvariant" \
            --mapping "$mapping" \
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

# --- run each ticket in order ------------------------------------------------
# Each ticket is measured against the state the PREVIOUS ticket left behind, so
# "existing lines modified" means existing as of the last ticket — which is the
# change-cost number PROTOCOL-2.md predicts stays flat for DisC and climbs for
# the naive arm.
PREV="$BASE"
TEST_SUMMARY="{}"
for ticket in "${TICKETS[@]}"; do
    run_arm "$ticket" || echo "  $ticket generation reported failure; measuring whatever landed"
    mvn_test "$ticket"
    "$HERE/measure.sh" --repo "$REPO" --out "$RUN_DIR/metrics-$ticket.json" \
        --since "$PREV" --scope-since "$PREV"
    NEXT=$(checkpoint "$ticket: $ARM")
    ( cd "$REPO" && git diff "$PREV" "$NEXT" -- src/ ) >"$RUN_DIR/$ticket.diff"
    TEST_SUMMARY=$(echo "$TEST_SUMMARY" | jq --arg t "$ticket" --arg s "$TEST_STATUS" '. + {($t): $s}')
    REFS=$(echo "${REFS:-\{\}}" | jq --arg t "$ticket" --arg r "$NEXT" '. + {($t): $r}')
    PREV="$NEXT"
done

# --- chain metadata -----------------------------------------------------------
jq -n --arg arm "$ARM" --arg chain "$CHAIN" --arg model "$MODEL" \
      --arg sha "$PETCLINIC_SHA" --arg base "$BASE" \
      --argjson refs "${REFS:-\{\}}" --argjson tests "$TEST_SUMMARY" \
      --arg tickets "$(IFS=,; echo "${TICKETS[*]}")" \
  '{arm:$arm, chain:$chain, model:$model, petclinic_sha:$sha, tickets:$tickets,
    refs:({base:$base} + $refs),
    tests:$tests,
    naive_extracted_strategy:null,
    note:"naive_extracted_strategy is filled in by hand after reading the diffs; see PROTOCOL.md"}' \
  >"$RUN_DIR/meta.json"

say "chain complete → $RUN_DIR"
# The change-cost-per-ticket line: flat for DisC, climbing for naive, is the
# whole prediction of PROTOCOL-2.md.
for ticket in "${TICKETS[@]}"; do
    printf '  %-6s ' "$ticket"
    jq -c '{npath: .ticket_scoped.npath.max,
            existing_prod_lines: (.change_cost.prod_existing_lines_added // 0),
            existing_test_lines: (.change_cost.test_existing_lines_added // 0),
            new_files: (.change_cost.prod_new_files // 0),
            tests: .tests.total}' "$RUN_DIR/metrics-$ticket.json"
done
