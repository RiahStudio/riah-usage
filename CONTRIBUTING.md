# Adding a provider

Work in this folder. It is the source of truth.

Do not hand-copy files into the public or private GitHub mirrors (`_public-repos/riah-usage`, `_private-repos/riah-usage-internal`). Those copies are generated.

## Where it goes

Ask first: which app on this computer already holds a login? If the answer is none, stop. This desk never asks for API keys or passwords. [docs/providers.md](docs/providers.md) has the current map.

Then:

1. **Pull** — add `lib/pull-<name>.py` (or a small parser in `lib/` if it is JavaScript). Print JSON meters only. Never print tokens.
2. **Wire** — call it from `collect-usage.js`. Providers with no meters stay off the board.
3. **Connect** — add a block in `setup.js` so the Connect screen can walk someone through that existing login.
4. **Note it** on `docs/providers.md`.

Provider strings from vendor APIs are untrusted. Escape them before any HTML.

## Do not touch

- Live snapshot and scratch stay out of git: `usage-data.js` and `scratch/` are gitignored. Do not commit them.
- Do not loosen the local API origin checks in `serve.js` (`ALLOWED_ORIGINS` on every `/api/` response, not just OPTIONS).
- Do not restyle the board or the tray. The look is locked.
- Do not put a browser profile in the tree (`*-sync-profile*/`).
