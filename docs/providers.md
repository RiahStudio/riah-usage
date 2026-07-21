# Providers & onboarding

How each meter is pulled. Tokens never leave your machine except to that
provider’s own usage API (same as the official CLI/app).

The desk’s **Connect** screen walks people through these steps with copy buttons.

| Provider | Connect once | What we show |
|----------|--------------|--------------|
| **Claude** | Claude Code → `claude` → `/login` | 5-hour, Weekly, Fable / scoped windows |
| **Cursor** | Cursor desktop signed in | Plan / Auto / API % |
| **Codex** | `codex login` | Weekly (+ 5-hour when returned) |
| **Grok** | `grok login` | Weekly + product splits |
| **Gemini** | **Sync Gemini** in Connect (one click, your browser) | Current usage · Weekly limit |
| **Copilot** | Copilot in an editor, or `gh auth login` | Credits / Chat / Completions (plan-dependent) |

Only providers with a live meter appear on the board. No empty cards. The Connect
list only shows AIs we can actually pull today.

## Every provider works the same way

Each one reads a login that some CLI or desktop app **already put on this
machine**, then asks that vendor's own usage API. No browser is needed, nothing
has to stay open, and the desk never asks anyone for a password or an API key.

Gemini is the exception again. The CLI path (`pull-gemini-cli.py`, reading
`~/.gemini/oauth_creds.json`) was the plan — but **on 2026-07-21 Google closed
new CLI sign-ins for individual accounts** ("this client is no longer supported
for Gemini Code Assist for individuals — migrate to Antigravity"). Existing CLI
logins and Workspace accounts still read fine and are still tried first, but
**Sync Gemini (the browser path) is the supported way in for individuals**,
which is why Connect leads with it.

**Adding a provider means answering one question first:** which app on this
computer already holds a login for it? If the answer is "none," the provider is
going to be painful — say so out loud rather than reaching for browser tricks.

Note on Gemini's number: this is the **Code Assist / Gemini CLI** quota, not the
consumer Gemini app's usage page. They are different meters.

## Security

- Pull scripts print JSON meters only — never access tokens.
- `usage-data.js` is generated locally and gitignored.
- Do not commit `scratch/`, credential files, or auth dumps.
