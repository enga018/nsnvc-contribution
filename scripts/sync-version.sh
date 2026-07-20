#!/usr/bin/env bash
# Syncs index.html footer and sw.js CACHE_NAME to match the VERSION file.
# Run automatically by the pre-commit hook so version drift never gets committed.
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION_FILE="VERSION"
if [ ! -f "$VERSION_FILE" ]; then
  echo "VERSION file not found"
  exit 0
fi

CURRENT_VERSION=$(tr -d ' \r\n' < "$VERSION_FILE")

# Update footer in index.html if needed. Consumes any trailing junk up to
# the next '<' too (not just the digits), so stray characters accidentally
# introduced by a previous buggy run get cleaned up instead of preserved.
sed -i "s/Village Council · v[0-9]\+\.[0-9]\+\.[0-9]\+[^<]*/Village Council · v${CURRENT_VERSION}/g" index.html

# Update CACHE_NAME in sw.js if needed. Same trailing-junk cleanup, up to
# the closing quote.
sed -i "s/nsnvc-tracker-v[0-9]\+\.[0-9]\+\.[0-9]\+[^']*/nsnvc-tracker-v${CURRENT_VERSION}/g" sw.js
