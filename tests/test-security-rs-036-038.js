#!/usr/bin/env node
/**
 * Pin-tests for Riah Security RS-036 / RS-037 / RS-038 (applied 2026-07-20).
 *
 * These re-run the EXACT attacks from the Break Report against the real
 * serve.js, in a throwaway directory with the child processes stubbed out, and
 * assert they now fail. If someone later loosens the origin checks or drops the
 * escaping, these go red.
 *
 * Run:  node tests/test-security-rs-036-038.js
 * Exit: 0 = all green, 1 = a hole reopened.
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.join(__dirname, '..');
const PORT = 8913;
const BASE = `http://127.0.0.1:${PORT}`;
const HOSTILE = 'https://evil.example.com';

let failures = 0;
function check(name, pass, detail) {
  if (pass) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`);
  }
}

/** Build a throwaway copy of the desk: real serve.js, inert children. */
function makeSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'riah-usage-sec-'));
  fs.mkdirSync(path.join(dir, 'scratch'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'tray'), { recursive: true });
  fs.copyFileSync(path.join(REPO, 'serve.js'), path.join(dir, 'serve.js'));
  // Stubs — nothing real is called, no provider API, no browser window.
  fs.writeFileSync(path.join(dir, 'collect-usage.js'), 'process.exit(0);');
  fs.writeFileSync(path.join(dir, 'sync-gemini.js'), 'process.exit(0);');
  fs.writeFileSync(path.join(dir, 'tray', 'launch-tray.js'), 'module.exports.maybeStartTray=function(){};');
  fs.writeFileSync(path.join(dir, 'index.html'), '<h1>test</h1>');
  fs.writeFileSync(path.join(dir, 'usage-data.js'), 'window.USAGE_DATA={"providers":[]};');
  return dir;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const dir = makeSandbox();
  const server = spawn(process.execPath, [path.join(dir, 'serve.js')], {
    cwd: dir,
    env: {
      ...process.env,
      RIAH_USAGE_PORT: String(PORT),
      RIAH_USAGE_NO_BROWSER: '1',
      RIAH_USAGE_BACKGROUND: '1',
      RIAH_USAGE_NO_TRAY: '1',
    },
    stdio: 'ignore',
  });

  try {
    // Wait for the port to answer.
    let up = false;
    for (let i = 0; i < 40 && !up; i++) {
      await sleep(150);
      try {
        await fetch(`${BASE}/api/status`);
        up = true;
      } catch (_) {}
    }
    if (!up) throw new Error('test server never came up');

    console.log('\nRS-036 — a hostile site must not be able to push data in');

    // The original attack: text/plain makes it a CORS "simple request", which
    // never preflights, so the allowlist used to be skipped entirely.
    let r = await fetch(`${BASE}/api/gemini-usage`, {
      method: 'POST',
      headers: { Origin: HOSTILE, 'Content-Type': 'text/plain' },
      body: JSON.stringify({
        plan: 'PWNED',
        meters: [{ label: '<img src=x onerror=alert(1)>', usedPercent: 99 }],
      }),
    });
    check('hostile origin + text/plain is refused', r.status === 403, `got ${r.status}`);
    check(
      'refusal does not reflect the hostile origin',
      r.headers.get('access-control-allow-origin') !== HOSTILE,
      `got ${r.headers.get('access-control-allow-origin')}`
    );

    // Even declaring JSON must not help if the origin is wrong.
    r = await fetch(`${BASE}/api/gemini-usage`, {
      method: 'POST',
      headers: { Origin: HOSTILE, 'Content-Type': 'application/json' },
      body: '{"meters":[{"label":"x","usedPercent":1}]}',
    });
    check('hostile origin + application/json is refused', r.status === 403, `got ${r.status}`);

    // An allowed origin must still be rejected if it uses the preflight-dodging
    // content type — that is what forces the browser to consult the allowlist.
    r = await fetch(`${BASE}/api/gemini-usage`, {
      method: 'POST',
      headers: { Origin: 'https://gemini.google.com', 'Content-Type': 'text/plain' },
      body: '{"meters":[{"label":"x","usedPercent":1}]}',
    });
    check('allowed origin still rejected without a JSON content type', r.status === 415, `got ${r.status}`);

    // Nothing above should have written anything to disk.
    check(
      'no payload reached the bridge file',
      !fs.existsSync(path.join(dir, 'scratch', 'gemini-bridge.json')),
      'gemini-bridge.json was written by a refused request'
    );

    // The preflight must refuse a hostile origin too.
    r = await fetch(`${BASE}/api/gemini-usage`, {
      method: 'OPTIONS',
      headers: { Origin: HOSTILE },
    });
    check('preflight refuses a hostile origin', r.status === 403, `got ${r.status}`);
    r = await fetch(`${BASE}/api/gemini-usage`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://gemini.google.com' },
    });
    check('preflight still allows the Gemini usage page', r.status === 204, `got ${r.status}`);

    console.log('\nRS-037 — the two unprotected endpoints');

    r = await fetch(`${BASE}/api/refresh`, {
      method: 'POST',
      headers: { Origin: HOSTILE, 'Content-Type': 'text/plain' },
    });
    check('cross-site /api/refresh is refused', r.status === 403, `got ${r.status}`);

    r = await fetch(`${BASE}/api/sync-gemini`, {
      method: 'POST',
      headers: { Origin: HOSTILE, 'Content-Type': 'text/plain' },
    });
    check('cross-site /api/sync-gemini is refused', r.status === 403, `got ${r.status}`);
    check(
      'no sync process was started',
      !fs.existsSync(path.join(dir, 'scratch', 'gemini-sync-status.json')),
      'the refused request still spawned the sync'
    );

    r = await fetch(`${BASE}/api/hidden`, {
      method: 'POST',
      headers: { Origin: HOSTILE, 'Content-Type': 'application/json' },
      body: JSON.stringify(['Claude']),
    });
    check('cross-site /api/hidden is refused', r.status === 403, `got ${r.status}`);
    check(
      'hostile hide list was not written',
      !fs.existsSync(path.join(dir, 'scratch', 'hidden.json')),
      'scratch/hidden.json appeared after a refused request'
    );

    r = await fetch(`${BASE}/api/hidden`, {
      method: 'POST',
      headers: { Origin: BASE, 'Content-Type': 'application/json' },
      body: JSON.stringify(['Gemini']),
    });
    check('same-origin /api/hidden still works', r.status === 200, `got ${r.status}`);
    check(
      'same-origin hide list was written',
      fs.existsSync(path.join(dir, 'scratch', 'hidden.json')) &&
        JSON.parse(fs.readFileSync(path.join(dir, 'scratch', 'hidden.json'), 'utf8')).includes(
          'Gemini'
        ),
      'scratch/hidden.json missing or wrong'
    );

    // A missing Origin must not be a way around the check on state-changing calls.
    r = await fetch(`${BASE}/api/refresh`, { method: 'POST' });
    check('missing Origin is refused on a state-changing POST', r.status === 403, `got ${r.status}`);

    console.log('\nRS-038 — the snapshot must not be readable by another site');

    r = await fetch(`${BASE}/usage-data.js`, {
      headers: { Origin: HOSTILE, 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Dest': 'script' },
    });
    check('cross-site <script> include of the snapshot is refused', r.status === 403, `got ${r.status}`);

    console.log('\nThe desk must still work for its own page');

    r = await fetch(`${BASE}/usage-data.js`, {
      headers: { Origin: BASE, 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Dest': 'script' },
    });
    check('same-origin load of the snapshot still works', r.status === 200, `got ${r.status}`);

    r = await fetch(`${BASE}/`);
    check('the dashboard page still loads', r.status === 200, `got ${r.status}`);

    r = await fetch(`${BASE}/api/gemini-usage`, {
      method: 'POST',
      headers: { Origin: 'https://gemini.google.com', 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan: 'Pro', meters: [{ label: 'Weekly', usedPercent: 42 }] }),
    });
    check('the real Gemini usage page can still push meters', r.status === 200, `got ${r.status}`);

    console.log('\nRS-036 render half — the escape helper must be wired in, not just present');

    const appjs = fs.readFileSync(path.join(REPO, 'app.js'), 'utf8');
    check('meter label is escaped', /esc\(label\)/.test(appjs));
    check('provider name is escaped', /esc\(p\.shortName\)/.test(appjs));
    check('plan is escaped', /esc\(String\(p\.plan\)/.test(appjs));
    check('price is escaped', /esc\(p\.price\)/.test(appjs));
    check('reconnect hint is escaped', /esc\(hint\)/.test(appjs));
    check('link targets are restricted to http(s)', /safeUrl\(/.test(appjs));
    check(
      'no raw label concatenation survives',
      !/'<div class="ru-meter"><div class="lab">'\s*\+\s*label\b/.test(appjs)
    );
  } finally {
    server.kill();
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (_) {}
  }

  console.log(
    failures === 0
      ? '\nAll security pin-tests passed.\n'
      : `\n${failures} security pin-test(s) FAILED — a hole may have reopened.\n`
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
