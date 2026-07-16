#!/usr/bin/env bash
# Shared helpers for the disc-* CLI wrappers. Requires: curl, jq.
# The wrappers drive the local DisC Studio server (./gradlew bootRun).

set -euo pipefail

DISC_URL="${DISC_URL:-http://localhost:8080}"
OUT_DIR="${DISC_OUT:-disc-out}"

require_tools() {
  for t in curl jq; do
    command -v "$t" >/dev/null || { echo "error: '$t' is required" >&2; exit 1; }
  done
}

require_server() {
  curl -sf "$DISC_URL/api/generator/status" >/dev/null 2>&1 || {
    echo "error: DisC Studio not reachable at $DISC_URL — start it with ./gradlew bootRun" >&2
    exit 1
  }
}

# sources_json <file...>  →  JSON array of file contents on stdout
sources_json() {
  for f in "$@"; do
    [ -f "$f" ] || { echo "error: no such file: $f" >&2; exit 1; }
    jq -Rs . <"$f"
  done | jq -s .
}

# default_sources <repo>  →  newline-separated *.java under src/main/java
default_sources() {
  find "$1/src/main/java" -name '*.java' -type f | sort
}

# split "Class#method" into ENTRY_CLASS / ENTRY_METHOD
parse_entry() {
  ENTRY_CLASS="${1%%#*}"
  ENTRY_METHOD="${1##*#}"
  [ -n "$ENTRY_CLASS" ] && [ -n "$ENTRY_METHOD" ] && [ "$ENTRY_CLASS" != "$1" ] || {
    echo "error: --entry must be Class#method, got '$1'" >&2; exit 1;
  }
}

# post <path> <json-body>  →  response body on stdout (fails on HTTP error)
post() {
  curl -sf -X POST "$DISC_URL$1" -H 'Content-Type: application/json' -d "$2" || {
    echo "error: POST $1 failed — re-run with DISC_DEBUG=1 to see the body" >&2
    [ -n "${DISC_DEBUG:-}" ] && curl -s -X POST "$DISC_URL$1" -H 'Content-Type: application/json' -d "$2" >&2
    exit 1
  }
}
