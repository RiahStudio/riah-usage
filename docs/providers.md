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
| **Kimi** | `kimi login` (device-code flow) | Kimi for Coding windows (needs an active plan) |

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

## The popular ones, and where each stands (checked 2026-07-21)

Captain's ask: add every popular AI meter we can. The question for each is the
one above — which app on this computer already holds a login? — and it sorts
the whole field. Checked against a real machine, not guessed:

| AI | Who holds a login on disk? | Verdict |
|----|----------------------------|---------|
| **Kimi (Moonshot)** | Kimi Code CLI — `~/.kimi-code/credentials/` | **Pulled — live on this desk.** Token refresh is native and rotation-safe; meters need an active Kimi for Coding plan (a plain "no plan on this account" state shows otherwise). |
| **Antigravity** (Google's IDE, where individual Gemini quota moved) | Login sits inside the IDE's encrypted storage — no token file anywhere under `~/.gemini/antigravity*` | No honest pull today. Gemini quota still shows via **Sync Gemini**. Revisit if Antigravity ever writes a file login. |
| **Qwen Code** | Its CLI caches OAuth like the old Gemini CLI (`~/.qwen/`) | Recipe should mirror `pull-gemini-cli.py`, but no login here to prove it on. PR welcome — the bar is a pull that ran against a real account. |
| **Windsurf** | The editor keeps its login; usage API unverified | Not yet — needs a machine with a real login to map honestly. PR welcome. |
| **Perplexity · Midjourney · Suno · ElevenLabs · Runway · v0 · Lovable · Replit** | Nothing — web subscriptions leave no login file on disk | Would need the Sync-page pattern (like Gemini), one usage page mapped per product. Candidates; deliberately not shipped as guesses. |
| **OpenRouter · DeepSeek · Mistral (API)** | API keys only | Out on purpose — this desk never asks for an API key. |
| **Ollama · LM Studio** | Local and unmetered | Nothing to meter. |

## Security

- Pull scripts print JSON meters only — never access tokens.
- `usage-data.js` is generated locally and gitignored.
- Do not commit `scratch/`, credential files, or auth dumps.
