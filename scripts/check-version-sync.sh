#!/usr/bin/env bash
# Fails if VERSION, sw.js's CACHE_NAME, and index.html's footer don't all
# report the same version. They're three separate hand-edited strings with
# no shared source of truth, and letting sw.js's CACHE_NAME drift behind the
# others is what silently strands installed PWAs on stale cached content —
# the browser only reinstalls a service worker when sw.js's bytes change,
# so an unbumped CACHE_NAME means no update is ever detected (this has
# happened twice already: v1.25.6 and v1.28.0/v1.29.2).
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION_FILE=$(tr -d ' \n' < VERSION)
SW_VERSION=$(grep -oP "CACHE_NAME = 'nsnvc-tracker-v\K[0-9.]+(?=')" sw.js || true)
FOOTER_VERSION=$(grep -oP 'Village Council · v\K[0-9.]+(?=</footer>)' index.html || true)

fail=0

if [ -z "$SW_VERSION" ]; then
  echo "::error file=sw.js::Could not find CACHE_NAME version string (expected format: const CACHE_NAME = 'nsnvc-tracker-vX.Y.Z';)"
  fail=1
fi
if [ -z "$FOOTER_VERSION" ]; then
  echo "::error file=index.html::Could not find footer version string (expected format: ...Village Council · vX.Y.Z</footer>)"
  fail=1
fi

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
  echo "All three must match on every version bump."
  exit 1
fi

echo "Version sync check passed: $VERSION_FILE"
