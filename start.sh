#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
# Start in the background — no terminal left open. No browser popup by default.
exec node start-background.js
