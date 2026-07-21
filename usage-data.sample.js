/* Sample snapshot — copy to usage-data.js or run: npm start / npm run once */
window.USAGE_DATA = {
  generatedAt: new Date().toISOString(),
  providers: [],
  connections: [
    { id: "Claude", connected: false },
    { id: "Cursor", connected: false },
    { id: "Codex", connected: false },
    { id: "Grok", connected: false },
    { id: "Gemini", connected: false },
  ],
  missing: [
    {
      name: "Setup",
      reason: "Open Connect in the desk, sign in once per AI, then tap Check again.",
    },
  ],
};
