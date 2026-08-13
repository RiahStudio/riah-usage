/* Public config — safe to commit. */
window.RIAH_USAGE_CONFIG = {
  // Set your real page when ready, e.g. "https://buymeacoffee.com/yourhandle"
  // Tip link stays hidden until this is a real URL (no YOUR_HANDLE placeholder).
  // Heads up if you fork: the guard only rejects the literal YOUR_HANDLE
  // placeholder. Any other string renders, working page or not — so open your
  // URL once in a browser after you set it. Ours was checked 2026-07-29.
  buyMeACoffeeUrl: "https://buymeacoffee.com/riahstudio",

  // How often the open page checks for a fresher snapshot (ms). Server recollects every ~5 min.
  pollMs: 15000,

  // INTERNAL PREVIEW — Claude card only: show the 5-hour window’s local clock
  // time (e.g. "resets 5:10 AM") instead of the relative "resets in 3h".
  // build-public.js forces this false so the public product stays unchanged
  // until Captain says the preview is ready to ship.
  previewFiveHourResetLine: false,
};
