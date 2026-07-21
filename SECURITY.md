# Security

Riah Usage is a **local** tool. The optional live desk binds to
`127.0.0.1` only (not the public internet) and does not send your data to the
author.

## What it touches

- Reads existing CLI/app logins on your machine (Claude Code, Cursor, Codex, Grok). Gemini uses a local Sync helper that opens a browser window on your machine (sign into Google only if asked) and stores percentages + plan only.
- Calls each provider’s **own** usage/billing API with those tokens — the same class of call the official apps make. Gemini reads the same Usage limits data as gemini.google.com/usage.
- Writes a local snapshot to `usage-data.js` (gitignored) with percentages and plan labels only.

## What it never does

- Print, log, or embed access tokens, refresh tokens, or API keys.
- Upload meters or credentials to a third-party backend.
- Require an account for this dashboard itself.

## Other websites and the local API

Binding to `127.0.0.1` keeps the desk off the public internet, but on its own it
does **not** stop a web page you have open in another tab from talking to it —
browsers can reach `localhost`. So the local API is explicitly gated:

- Every `/api/` endpoint checks the request's `Origin` against a fixed
  allowlist (this dashboard, and the Gemini usage page that pushes meters).
  Anything else gets a `403`, before any work is done.
- State-changing endpoints also refuse a **missing** `Origin`, and require a
  real `application/json` content type — which forces the browser to run a
  preflight, so the allowlist is always consulted.
- The local meter snapshot is refused when a browser reports it as a
  cross-site subresource load, so another site can't pull it in with a
  `<script>` tag and read which services you use.
- Values that arrive from a provider API or the sync bridge are HTML-escaped
  before they're displayed, so a hostile label can't become markup.

*(These gates were added 2026-07-20 after an internal review. Earlier public
releases checked the allowlist only on the CORS preflight, which a
`text/plain` POST skips — if you are running a build from before that date,
update.)*

## If you fork or publish

- Keep `usage-data.js` and `scratch/` out of git (see `.gitignore`).
- Do not commit credential dumps, OAuth client secrets extracted from binaries, or personal email screenshots.
- Report vulnerabilities privately if you find a token leak path — open an issue without pasting secrets.
