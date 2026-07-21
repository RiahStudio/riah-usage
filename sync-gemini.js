#!/usr/bin/env node
/**
 * One-click Gemini sync for Riah Usage.
 *
 * Opens gemini.google.com/usage in YOUR real default browser (already logged in),
 * then reads Google cookies from that machine (any installed browser)
 * and pulls the meters. No blank Playwright profile — no fresh sign-in window.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = __dirname;
const BRIDGE = path.join(ROOT, 'scratch', 'gemini-bridge.json');
const STATUS = path.join(ROOT, 'scratch', 'gemini-sync-status.json');
const USAGE_URL = 'https://gemini.google.com/usage';
const PULL = path.join(ROOT, 'lib', 'pull-gemini.py');

function say(msg) {
  console.log(msg);
}

function writeStatus(partial) {
  try {
    fs.mkdirSync(path.dirname(STATUS), { recursive: true });
    let prev = {};
    try {
      prev = JSON.parse(fs.readFileSync(STATUS, 'utf8'));
    } catch (_) {}
    fs.writeFileSync(
      STATUS,
      JSON.stringify(
        {
          running: true,
          ok: null,
          error: null,
          ...prev,
          ...partial,
          at: new Date().toISOString(),
        },
        null,
        2
      ),
      'utf8'
    );
  } catch (_) {}
}

function openRealBrowser(url) {
  // Always the user's own default browser. We used to force-launch Brave here
  // because that is where the studio's paid Google account happened to live --
  // that is one person's setup, not a product. Overriding someone's chosen
  // browser is the wrong default, and naming a browser they may not have
  // installed is worse. If the account is wrong, that is a sign-in problem the
  // user can see and fix, not something to paper over by picking for them.
  if (process.platform === 'win32') {
    spawn('cmd', ['/c', 'start', '', url], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    }).unref();
    return 'default';
  }
  if (process.platform === 'darwin') {
    spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    return 'open';
  }
  spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  return 'xdg';
}

// Same trap as collect-usage.js: macOS and most Linux ship only "python3".
let PY = null;
function pythonCmd() {
  if (PY) return PY;
  const candidates = process.platform === 'win32'
    ? ['python', 'python3', 'py']
    : ['python3', 'python'];
  for (const c of candidates) {
    try {
      const r = spawnSync(c, ['--version'], { encoding: 'utf8', timeout: 8000, windowsHide: true });
      if (r.status === 0 || /Python\s+3/i.test((r.stdout || '') + (r.stderr || ''))) {
        PY = c;
        return PY;
      }
    } catch {}
  }
  PY = candidates[0];
  return PY;
}

function pullOnce() {
  const r = spawnSync(pythonCmd(), [PULL], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 45000,
    windowsHide: true,
  });
  const line = String(r.stdout || '')
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .pop();
  if (!line) return { ok: false, error: 'no_pull_output' };
  try {
    return JSON.parse(line);
  } catch {
    return { ok: false, error: 'bad_pull_json' };
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  say('');
  say('Riah Usage - Sync Gemini');
  say('Opening the Gemini Usage page in your browser.');
  say('If you see your Google accounts, pick the Plus one. We will read the meters from this computer.');
  say('');

  fs.mkdirSync(path.dirname(BRIDGE), { recursive: true });
  writeStatus({ running: true, ok: null, error: null, phase: 'open_browser' });

  const browser = openRealBrowser(USAGE_URL);
  writeStatus({ running: true, phase: 'open_browser', browser });

  function readFreshBridge() {
    try {
      if (!fs.existsSync(BRIDGE)) return null;
      const data = JSON.parse(fs.readFileSync(BRIDGE, 'utf8'));
      if (!data || !data.ok || !data.meters || !data.meters.length) return null;
      const at = Date.parse(data.receivedAt || data.at || 0);
      if (at && Date.now() - at > 15 * 60 * 1000) return null;
      return data;
    } catch (_) {
      return null;
    }
  }

  function acceptResult(result, via) {
    const payload = {
      ok: true,
      plan: result.plan || null,
      meters: result.meters.map((m) => ({
        label: m.label,
        usedPercent: Math.round(Number(m.usedPercent)),
        resetsAt: m.resetsAt || null,
      })),
      source: result.source || via || 'sync',
      href: USAGE_URL,
      receivedAt: new Date().toISOString(),
    };
    fs.writeFileSync(BRIDGE, JSON.stringify(payload, null, 2), 'utf8');
    say(
      'Saved: ' +
        (payload.plan || 'Gemini') +
        ' - ' +
        payload.meters.map((m) => m.label + ' ' + m.usedPercent + '%').join(', ')
    );
    const collect = spawnSync(process.execPath, [path.join(ROOT, 'collect-usage.js')], {
      cwd: ROOT,
      encoding: 'utf8',
      windowsHide: true,
    });
    if (collect.stdout) process.stdout.write(collect.stdout);
    writeStatus({ running: false, ok: true, error: null, phase: 'done', via });
    say('Done. Gemini meters are updated.');
  }

  // Quick try first — cookies may already be enough without waiting.
  let result = pullOnce();
  if (result.ok && result.meters && result.meters.length && !/free/i.test(String(result.plan || ''))) {
    say('Already signed in — meters found.');
    acceptResult(result, result.source);
    return;
  }
  if (result.ok && result.meters && result.meters.length) {
    // Keep a Free hit as fallback, but keep looking for a paid session.
    say('Found a free Google session — still looking for your paid one…');
  } else {
    say('Waiting for Google login / Usage page (up to a few minutes)...');
  }

  writeStatus({ running: true, phase: 'waiting_login' });
  // Open the one-click page-capture helper (Brave locks cookies while open).
  try {
    openRealBrowser('http://127.0.0.1:8775/gemini-capture.html');
  } catch (_) {}

  const deadline = Date.now() + 5 * 60 * 1000;
  let fallbackFree = result.ok && result.meters && result.meters.length ? result : null;
  while (Date.now() < deadline) {
    await sleep(3000);
    const bridge = readFreshBridge();
    if (bridge && String(bridge.source || '').includes('page')) {
      say('Got meters from the Gemini page.');
      acceptResult(bridge, 'page-sync');
      return;
    }
    result = pullOnce();
    if (result.ok && result.meters && result.meters.length) {
      if (!/free/i.test(String(result.plan || ''))) {
        acceptResult(result, result.source);
        return;
      }
      fallbackFree = result;
    }
    const err = (result && result.error) || 'waiting';
    writeStatus({
      running: true,
      phase: 'waiting_login',
      lastError: err,
      hint: 'page_capture',
    });
  }

  if (fallbackFree) {
    say('Using the free session we found — the paid one was locked by your browser.');
    acceptResult(fallbackFree, fallbackFree.source);
    return;
  }

  say('Could not read the meters from your browser (most browsers lock the login while open).');
  say('On the Gemini Usage tab, use the “Send to Riah Usage” bookmark from the capture page.');
  writeStatus({
    running: false,
    ok: false,
    error: 'need_page_capture',
    phase: 'need_page_capture',
    captureUrl: 'http://127.0.0.1:8775/gemini-capture.html',
  });
  process.exitCode = 2;
}

main().catch((err) => {
  console.error(err && err.message ? err.message : err);
  writeStatus({
    running: false,
    ok: false,
    error: 'sync_failed',
    phase: 'failed',
  });
  say('Sync failed. Open Gemini Usage in your normal browser while signed in, then try Sync again.');
  process.exit(1);
});
