/* Plain-English connect guides — safe to commit.
   Every entry here is ready to connect (live meters). */
window.RIAH_USAGE_SETUP = [
  {
    id: "Claude",
    title: "Claude",
    blurb: "Claude Code login — 5-hour, weekly, and Fable meters",
    ready: true,
    installLabel: "Claude Code docs",
    installUrl: "https://docs.anthropic.com/en/docs/claude-code/overview",
    steps: [
      { text: "Install Claude Code if you don’t have it yet (docs link above)." },
      { text: "Open a terminal and start Claude:" },
      { cmd: "claude" },
      { text: "Inside Claude, run this and finish the browser login:" },
      { cmd: "/login" },
      { text: "When you’re signed in, tap Continue — we’ll pick up the meters." },
    ],
  },
  {
    id: "Cursor",
    title: "Cursor",
    blurb: "Uses the Cursor desktop app you’re already signed into",
    ready: true,
    installLabel: "Get Cursor",
    installUrl: "https://cursor.com/",
    steps: [
      { text: "Install the Cursor app and open it." },
      { text: "Sign in (Settings → Account) with the account you pay for." },
      { text: "Leave Cursor installed — we read the login from this computer." },
      { text: "Tap Continue when you’re signed in." },
    ],
  },
  {
    id: "Codex",
    title: "ChatGPT / Codex",
    blurb: "Codex CLI login (ChatGPT subscription meters)",
    ready: true,
    installLabel: "Codex CLI",
    installUrl: "https://developers.openai.com/codex/cli",
    steps: [
      { text: "Install the Codex CLI (see OpenAI’s docs)." },
      { text: "In a terminal, sign in with ChatGPT:" },
      { cmd: "codex login" },
      { text: "Finish the browser flow, then tap Continue." },
    ],
  },
  {
    id: "Grok",
    title: "Grok",
    blurb: "Grok Build CLI login",
    ready: true,
    installLabel: "Grok Build",
    installUrl: "https://x.ai/cli",
    steps: [
      { text: "Install the Grok Build CLI from xAI." },
      { text: "A grok.com browser login alone is not enough — this desk needs the CLI login on this computer." },
      { text: "Sign in from a terminal (also do this again if the card says Reconnect):" },
      { cmd: "grok login" },
      { text: "Finish sign-in, then tap Continue." },
    ],
  },
  {
    id: "Gemini",
    title: "Gemini",
    blurb: "One click — reads the Usage page from your own browser",
    ready: true,
    installLabel: "Gemini CLI (Workspace only)",
    installUrl: "https://github.com/google-gemini/gemini-cli",
    action: "sync-gemini",
    actionLabel: "Sync Gemini",
    steps: [
      {
        text: "Tap Sync Gemini below — your browser opens Google’s Usage page and the desk reads the meters from this computer.",
      },
      {
        text: "Sign into Google if it asks (pick the account you pay on). It finishes by itself — this card flips to connected.",
      },
      {
        text: "Already signed into the Gemini CLI (Workspace account, or a login from before mid-2026)? That still works — tap “I use the CLI — Continue” instead. Google no longer accepts new CLI sign-ins for individual accounts.",
      },
    ],
  },
  {
    id: "Copilot",
    title: "GitHub Copilot",
    blurb: "Uses the Copilot login already on this computer (VS Code / JetBrains / gh)",
    ready: true,
    installLabel: "GitHub Copilot",
    installUrl: "https://github.com/features/copilot",
    steps: [
      {
        text: "Sign into GitHub Copilot in VS Code, JetBrains, or Neovim — or use the GitHub CLI:",
      },
      { cmd: "gh auth login" },
      {
        text: "Pick GitHub.com, finish the browser login, then tap Continue. We read the token Copilot already saved — no passwords here.",
      },
    ],
  },
];
