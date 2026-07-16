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

CURRENT_VERSION=$(tr -d ' \n' < "$VERSION_FILE")

# Update footer in index.html if needed
sed -i "s/Village Council · v[0-9]\+\.[0-9]\+\.[0-9]\+/Village Council · v${CURRENT_VERSION}/g" index.html

# Update CACHE_NAME in sw.js if needed
sed -i "s/nsnvc-tracker-v[0-9]\+\.[0-9]\+\.[0-9]\+/nsnvc-tracker-v${CURRENT_VERSION}/g" sw.js
