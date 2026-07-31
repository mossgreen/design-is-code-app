#!/usr/bin/env bash
#
# measure.sh — compute the pre-registered metrics for one repo state.
#
#   measure.sh --repo <path> --out <metrics.json> [--since <git-ref>]
#
# Emits a single JSON document. Every number comes from PMD 7.26.0 (pinned),
# git, or surefire — nothing is hand-computed, because the author of DisC does
# not get to write the ruler for his own claim.
#
# --since <ref> adds change-cost figures (lines modified in files that already
# existed at <ref>), which is the money metric for ticket 2.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PMD_HOME="${PMD_HOME:-$HERE/.tools/pmd-bin-7.26.0}"
PMD="$PMD_HOME/bin/pmd"
RULESET="$HERE/ruleset.xml"

REPO="" OUT="" SINCE="" SCOPE=""
while [ $# -gt 0 ]; do
    case "$1" in
        --repo)        REPO="$2"; shift 2 ;;
        --out)         OUT="$2"; shift 2 ;;
        --since)       SINCE="$2"; shift 2 ;;
        --scope-since) SCOPE="$2"; shift 2 ;;
        *) echo "unknown arg: $1" >&2; exit 2 ;;
    esac
done

[ -n "$REPO" ] && [ -d "$REPO" ] || { echo "usage: measure.sh --repo <path> --out <file> [--since <ref>]" >&2; exit 2; }
[ -n "$OUT" ] || { echo "measure.sh: --out is required" >&2; exit 2; }
[ -x "$PMD" ] || { echo "measure.sh: PMD not found at $PMD (set PMD_HOME)" >&2; exit 3; }

MAIN="$REPO/src/main/java"
TEST="$REPO/src/test/java"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# --- PMD over production code only -------------------------------------------
# PMD exits 4 when it reports violations. Here a "violation" IS the measurement,
# so a non-zero exit is the normal case and must not kill the script.
run_pmd () {  # run_pmd <target-dir-or-filelist-flag> <out.json>
    if "$PMD" check "$@" -R "$RULESET" -f json --no-progress >"$TMP/out.json" 2>"$TMP/pmd.err"; then :; fi
    cat "$TMP/out.json"
}

if [ -d "$MAIN" ]; then
    "$PMD" check -d "$MAIN" -R "$RULESET" -f json --no-progress >"$TMP/pmd.json" 2>"$TMP/pmd.err" || true
else
    echo '{"files":[]}' >"$TMP/pmd.json"
fi

# --- ticket-scoped PMD --------------------------------------------------------
# Whole-repo numbers are dominated by ~800 lines of untouched PetClinic that
# both arms share, which dilutes the signal. --scope-since restricts the same
# measurement to production files the ticket actually added or modified.
# Reported ALONGSIDE the whole-repo figure, never instead of it.
echo '{"files":[]}' >"$TMP/pmd-scoped.json"
SCOPED_FILE_COUNT=0
if [ -n "$SCOPE" ] && [ -d "$MAIN" ]; then
    # Tracked changes AND untracked new files. Omitting the latter would hide
    # every class an arm newly created — which for the DisC arm is the whole
    # point of the comparison.
    ( cd "$REPO"
      git diff --name-only --diff-filter=AMR "$SCOPE" -- 'src/main/java' 2>/dev/null || true
      git ls-files --others --exclude-standard -- 'src/main/java' 2>/dev/null || true
    ) | sort -u > "$TMP/scoped-rel.txt"
    : > "$TMP/scoped-abs.txt"
    while IFS= read -r rel; do
        [ -n "$rel" ] || continue
        [ -f "$REPO/$rel" ] && printf '%s\n' "$REPO/$rel" >> "$TMP/scoped-abs.txt"
    done < "$TMP/scoped-rel.txt"
    SCOPED_FILE_COUNT=$(wc -l < "$TMP/scoped-abs.txt" | tr -d ' ')
    if [ "$SCOPED_FILE_COUNT" -gt 0 ]; then
        "$PMD" check --file-list "$TMP/scoped-abs.txt" -R "$RULESET" -f json --no-progress \
            >"$TMP/pmd-scoped.json" 2>>"$TMP/pmd.err" || true
        jq -e . "$TMP/pmd-scoped.json" >/dev/null 2>&1 || echo '{"files":[]}' >"$TMP/pmd-scoped.json"
    fi
fi

if ! jq -e . "$TMP/pmd.json" >/dev/null 2>&1; then
    echo "measure.sh: PMD produced no parseable JSON. stderr:" >&2
    cat "$TMP/pmd.err" >&2
    exit 4
fi

# Parse "has an NPath complexity of N" / "has a cyclomatic complexity of N" /
# "A value of N may denote a high amount of coupling".
jq -f "$HERE/parse-pmd.jq" "$TMP/pmd.json"        >"$TMP/parsed.json"
jq -f "$HERE/parse-pmd.jq" "$TMP/pmd-scoped.json" >"$TMP/parsed-scoped.json"

# --- size ---------------------------------------------------------------------
count_files () { [ -d "$1" ] && find "$1" -name '*.java' | wc -l | tr -d ' ' || echo 0; }
count_lines () { [ -d "$1" ] && { find "$1" -name '*.java' -exec cat {} + | wc -l | tr -d ' '; } || echo 0; }

MAIN_FILES=$(count_files "$MAIN"); MAIN_LOC=$(count_lines "$MAIN")
TEST_FILES=$(count_files "$TEST"); TEST_LOC=$(count_lines "$TEST")

# --- surefire (present only after a test run) ---------------------------------
SUREFIRE="$REPO/target/surefire-reports"
sum_attr () {  # sum one XML attribute across all surefire testsuite files
    local attr="$1" total=0 n
    [ -d "$SUREFIRE" ] || { echo 0; return; }
    while read -r n; do total=$((total + n)); done < <(
        grep -ho "<testsuite [^>]*${attr}=\"[0-9]*\"" "$SUREFIRE"/*.xml 2>/dev/null \
          | grep -o "${attr}=\"[0-9]*\"" | grep -o '[0-9]*'
    )
    echo "$total"
}
TESTS=$(sum_attr tests); FAILS=$(sum_attr failures)
ERRS=$(sum_attr errors); SKIPPED=$(sum_attr skipped)

# --- change cost vs a previous state ------------------------------------------
# "Existing" = the file was already tracked at <ref>. Lines added to a brand-new
# file are not change cost; lines added to a file that already existed are.
CHANGE='null'
if [ -n "$SINCE" ]; then
    (
        cd "$REPO"
        git diff --numstat "$SINCE" -- 'src/main/java' 'src/test/java' >"$TMP/numstat.txt" 2>/dev/null || : >"$TMP/numstat.txt"
        # Untracked files carry no numstat line; synthesise one so newly created
        # classes are counted as new rather than dropped.
        while IFS= read -r u; do
            [ -n "$u" ] && [ -f "$u" ] && printf '%s\t0\t%s\n' "$(wc -l < "$u" | tr -d ' ')" "$u" >>"$TMP/numstat.txt"
        done < <(git ls-files --others --exclude-standard -- 'src/main/java' 'src/test/java' 2>/dev/null || true)
        git ls-tree -r --name-only "$SINCE" >"$TMP/existing.txt" 2>/dev/null || : >"$TMP/existing.txt"
    )
    CHANGE=$(awk -v existing="$TMP/existing.txt" '
        BEGIN { while ((getline l < existing) > 0) was[l] = 1 }
        {
            add = ($1 == "-") ? 0 : $1; del = ($2 == "-") ? 0 : $2; path = $3
            isTest = (path ~ /src\/test\/java/)
            if (path in was) {
                if (isTest) { tModAdd += add; tModDel += del; tModFiles++ }
                else        { pModAdd += add; pModDel += del; pModFiles++ }
            } else {
                if (isTest) { tNewAdd += add; tNewFiles++ }
                else        { pNewAdd += add; pNewFiles++ }
            }
        }
        END {
            printf "{\"prod_existing_files_modified\":%d,\"prod_existing_lines_added\":%d,\"prod_existing_lines_deleted\":%d,", pModFiles+0, pModAdd+0, pModDel+0
            printf "\"test_existing_files_modified\":%d,\"test_existing_lines_added\":%d,\"test_existing_lines_deleted\":%d,", tModFiles+0, tModAdd+0, tModDel+0
            printf "\"prod_new_files\":%d,\"prod_new_lines\":%d,\"test_new_files\":%d,\"test_new_lines\":%d}", pNewFiles+0, pNewAdd+0, tNewFiles+0, tNewAdd+0
        }' "$TMP/numstat.txt")
fi

# --- assemble ------------------------------------------------------------------
mkdir -p "$(dirname "$OUT")"
jq -n \
  --slurpfile parsed "$TMP/parsed.json" \
  --slurpfile scoped "$TMP/parsed-scoped.json" \
  --argjson change  "$CHANGE" \
  --argjson mainFiles "$MAIN_FILES" --argjson mainLoc "$MAIN_LOC" \
  --argjson testFiles "$TEST_FILES" --argjson testLoc "$TEST_LOC" \
  --argjson scopedFiles "${SCOPED_FILE_COUNT:-0}" \
  --argjson tests "${TESTS:-0}" --argjson fails "${FAILS:-0}" \
  --argjson errs "${ERRS:-0}" --argjson skipped "${SKIPPED:-0}" \
  --arg pmd "7.26.0" \
  'def summarize($p):
     ($p.npath) as $n | ($p.cyclo) as $c | ($p.cbo) as $b |
     ($n | map(.npath)) as $ns |
     {
       npath: {
         max:    (if ($ns|length) > 0 then ($ns|max) else 0 end),
         mean:   (if ($ns|length) > 0 then (($ns|add) / ($ns|length) * 100 | round / 100) else 0 end),
         total:  ($ns|add // 0),
         methods_measured: ($ns|length),
         methods_above_1:  ($n | map(select(.npath > 1)) | length),
         all: ($n | sort_by(-.npath))
       },
       cyclomatic: {
         max:  (if ($c|length) > 0 then ($c | map(.cyclo) | max) else 0 end),
         mean: (if ($c|length) > 0 then (($c | map(.cyclo) | add) / ($c|length) * 100 | round / 100) else 0 end),
         top:  ($c | sort_by(-.cyclo) | .[0:10])
       },
       coupling: {
         max: (if ($b|length) > 0 then ($b | map(.cbo) | max) else 0 end),
         classes_measured: ($b|length),
         all: ($b | sort_by(-.cbo))
       }
     };
   {
     pmd_version: $pmd,
     whole_repo: summarize($parsed[0]),
     ticket_scoped: (summarize($scoped[0]) + { files_measured: $scopedFiles }),
     size: {
       main_files: $mainFiles, main_loc: $mainLoc,
       test_files: $testFiles, test_loc: $testLoc
     },
     tests: { total: $tests, failures: $fails, errors: $errs, skipped: $skipped },
     change_cost: $change
   }' > "$OUT"

echo "measure.sh: wrote $OUT"
jq -c '{scoped_npath_max: .ticket_scoped.npath.max,
        scoped_files: .ticket_scoped.files_measured,
        repo_npath_max: .whole_repo.npath.max,
        main_files: .size.main_files, main_loc: .size.main_loc,
        tests: .tests.total, failures: .tests.failures}' "$OUT"
