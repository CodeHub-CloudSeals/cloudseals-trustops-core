#!/bin/sh
# Starts only a dedicated browser/profile for the local TrustOps REA test application.
set -eu
repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
browser_bin=${TRUSTOPS_REA_BROWSER:-"$repo_dir/../work/playwright-browsers/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"}
if [ ! -x "$browser_bin" ]; then
  echo 'Set TRUSTOPS_REA_BROWSER to your Chrome/Chromium executable.' >&2
  exit 1
fi
exec "$browser_bin" --remote-debugging-address=127.0.0.1 --remote-debugging-port=9227 \
  --user-data-dir=/private/tmp/trustops-rea-client-profile --no-first-run --no-default-browser-check \
  http://127.0.0.1:8033
