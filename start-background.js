#!/usr/bin/env node
/**
 * Customer launcher: start the desk in the background (no terminal left open),
 * then open the browser. If already running, just open the browser.
 */
'use strict';

const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn, spawnSync, exec } = require('child_process');

const ROOT = __dirname;
const PORT = Number(process.env.RIAH_USAGE_PORT) || 8775;
const HOST = '127.0.0.1';
const URL = `http://${HOST}:${PORT}/`;
const SCRATCH = path.join(ROOT, 'scratch');
const PID_FILE = path.join(SCRATCH, 'desk.pid');
const LOG_FILE = path.join(SCRATCH, 'desk.log');

function isUp() {
  return new Promise((resolve) => {
    const s = net.connect({ host: HOST, port: PORT }, () => {
      s.end();
      resolve(true);
    });
    s.on('error', () => resolve(false));
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function openBrowser(url) {
  if (process.env.RIAH_USAGE_NO_BROWSER === '1') return;
  const plat = process.platform;
  if (plat === 'win32') exec(`start "" "${url}"`);
  else if (plat === 'darwin') exec(`open "${url}"`);
  else exec(`xdg-open "${url}"`);
}

async function waitUntilUp(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await isUp()) return true;
    await sleep(400);
  }
  return false;
}

function ensureDeps() {
  const marker = path.join(ROOT, 'node_modules', 'playwright-core', 'package.json');
  if (fs.existsSync(marker)) return true;
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const r = spawnSync(npmCmd, ['install', '--omit=dev'], {
    cwd: ROOT,
    stdio: 'ignore',
    windowsHide: true,
    shell: process.platform === 'win32',
  });
  return r.status === 0 && fs.existsSync(marker);
}

async function main() {
  if (!(await isUp())) {
    try {
      ensureDeps();
    } catch (_) {}
  }

  if (await isUp()) {
    // Desk already running — make sure the tray icon is up too (Windows).
    try {
      require('./tray/launch-tray.js').maybeStartTray(ROOT);
    } catch (_) {}
    openBrowser(URL);
    return;
  }

  fs.mkdirSync(SCRATCH, { recursive: true });
  const out = fs.openSync(LOG_FILE, 'a');
  fs.writeSync(out, `\n--- start ${new Date().toISOString()} ---\n`);

  const child = spawn(process.execPath, [path.join(ROOT, 'serve.js')], {
    cwd: ROOT,
    detached: true,
    stdio: ['ignore', out, out],
    windowsHide: true,
    env: {
      ...process.env,
      RIAH_USAGE_BACKGROUND: '1',
      RIAH_USAGE_PORT: String(PORT),
    },
  });

  fs.writeFileSync(PID_FILE, String(child.pid), 'utf8');
  child.unref();

  const ready = await waitUntilUp(90 * 1000);
  if (!ready) {
    // Still open the URL so the user sees a clear browser error if something failed.
    openBrowser(URL);
    process.exitCode = 1;
    return;
  }
  // Tray is also started from serve.js; this covers cases where that spawn was missed.
  try {
    require('./tray/launch-tray.js').maybeStartTray(ROOT);
  } catch (_) {}
  openBrowser(URL);
}

main().catch((e) => {
  try {
    fs.appendFileSync(LOG_FILE, String(e && e.stack ? e.stack : e) + '\n');
  } catch (_) {}
  process.exit(1);
});
