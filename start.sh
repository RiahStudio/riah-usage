#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
# Start in the background — no terminal left open. Open the desk in your browser.
exec node start-background.js
