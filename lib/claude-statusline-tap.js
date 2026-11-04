#!/usr/bin/env node
// Claude Code status line that also feeds Riah Usage.
//
// Claude Code hands every status-line command a JSON blob on stdin, and since
// v2.1.80 that blob carries `rate_limits` (5-hour and weekly used_percentage
// and resets_at) -- the same numbers as Anthropic's usage endpoint, already
// fetched by Claude Code itself. Saving them here costs Anthropic nothing, so
// the Claude card stays filled even while the usage endpoint is handing out
// hour-long 429s. (Captain, 2026-10-19: "get Claude back on Riah Usage, and
// make it permanent.")
//
// Must never break Claude Code's footer: every failure is swallowed, and the
// line it prints is short.
'use strict';

const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'scratch', 'claude-statusline.json');

function pct(w) {
  if (!w || typeof w !== 'object') return null;
  const v = w.used_percentage ?? w.utilization;
  return typeof v === 'number' && isFinite(v) ? Math.round(v) : null;
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  let j = {};
  try {
    j = JSON.parse(raw || '{}');
  } catch (_) {}
  const rl = j && j.rate_limits;
  try {
    // Heartbeat: proves Claude Code is calling the tap even before the first
    // reply brings rate_limits.
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(
      OUT.replace(/\.json$/, '-seen.json'),
      JSON.stringify({ at: Date.now(), hasRateLimits: !!rl, keys: Object.keys(j || {}) }),
      'utf8'
    );
  } catch (_) {}
  if (rl && typeof rl === 'object' && (rl.five_hour || rl.seven_day)) {
    try {
      fs.mkdirSync(path.dirname(OUT), { recursive: true });
      const tmp = OUT + '.' + process.pid + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ at: Date.now(), rate_limits: rl }), 'utf8');
      fs.renameSync(tmp, OUT);
    } catch (_) {}
  }
  const bits = [];
  const model = j && j.model && (j.model.display_name || j.model.id);
  if (model) bits.push(model);
  const h5 = rl && pct(rl.five_hour);
  const wk = rl && pct(rl.seven_day);
  if (h5 != null) bits.push(`5h ${h5}%`);
  if (wk != null) bits.push(`week ${wk}%`);
  process.stdout.write(bits.join(' · '));
});
