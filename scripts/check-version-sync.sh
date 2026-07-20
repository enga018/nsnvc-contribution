#!/usr/bin/env bash
# Fails if VERSION, sw.js's CACHE_NAME, and index.html's footer don't all
# report the same version. They're three separate hand-edited strings with
# no shared source of truth, and letting sw.js's CACHE_NAME drift behind the
# others is what silently strands installed PWAs on stale cached content —
# the browser only reinstalls a service worker when sw.js's bytes change,
# so an unbumped CACHE_NAME means no update is ever detected (this has
# happened repeatedly: v1.25.6, v1.28.0/v1.29.2, and a stray-\r corruption
# from a buggy sync script around v1.29.10-11).
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION_FILE=$(tr -d ' \r\n' < VERSION)
SW_LINE=$(grep -m1 "CACHE_NAME = 'nsnvc-tracker-v" sw.js || true)
FOOTER_LINE=$(grep -m1 '<footer>' index.html || true)

SW_VERSION=$(printf '%s' "$SW_LINE" | grep -oP "CACHE_NAME = 'nsnvc-tracker-v\K[0-9.]+(?=')" || true)
FOOTER_VERSION=$(printf '%s' "$FOOTER_LINE" | grep -oP 'Village Council · v\K[0-9.]+(?=</footer>)' || true)

fail=0

# Reports not just "couldn't find it" but shows the raw line with control
# characters made visible (cat -A), so a future stray-\r-style corruption
# is obvious in the CI log instead of requiring someone to dig it out by
# hand the way this had to be diagnosed the first time.
check_extracted() {
  local label="$1" line="$2" extracted="$3"
  if [ -n "$extracted" ]; then
    return 0
  fi
  if [ -z "$line" ]; then
    echo "::error::$label: could not find a version string at all — has the surrounding text changed?"
  else
    echo "::error::$label: found the line but couldn't cleanly extract a version from it — there's likely stray whitespace or a control character (e.g. an embedded \\r) right after the version digits. Raw line (cat -A): $(printf '%s' "$line" | cat -A)"
  fi
  fail=1
}

check_extracted "sw.js CACHE_NAME" "$SW_LINE" "$SW_VERSION"
check_extracted "index.html footer" "$FOOTER_LINE" "$FOOTER_VERSION"

if [ "$fail" -eq 0 ]; then
  if [ "$VERSION_FILE" != "$SW_VERSION" ]; then
    echo "::error file=sw.js::sw.js CACHE_NAME version ($SW_VERSION) does not match VERSION ($VERSION_FILE). Installed PWAs won't detect this deploy as an update until CACHE_NAME is bumped to match."
    fail=1
  fi
  if [ "$VERSION_FILE" != "$FOOTER_VERSION" ]; then
    echo "::error file=index.html::index.html footer version ($FOOTER_VERSION) does not match VERSION ($VERSION_FILE)."
    fail=1
  fi
fi

if [ "$fail" -ne 0 ]; then
  echo ""
  echo "VERSION file: $VERSION_FILE"
  echo "sw.js CACHE_NAME: ${SW_VERSION:-<not found>}"
  echo "index.html footer: ${FOOTER_VERSION:-<not found>}"
  echo ""
  echo "All three must match on every version bump, with no stray characters."
  exit 1
fi

echo "Version sync check passed: $VERSION_FILE"
