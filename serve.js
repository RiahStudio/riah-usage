#!/usr/bin/env node
/**
 * Local live desk — serves the UI and re-collects meters on a timer.
 * Zero deps. Open http://127.0.0.1:8775/
 * (8765 is Riah Studio’s generation service — don’t collide.)
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, exec } = require('child_process');

const ROOT = __dirname;
const PORT = Number(process.env.RIAH_USAGE_PORT) || 8775;
const REFRESH_MS = Number(process.env.RIAH_USAGE_REFRESH_MS) || 5 * 60 * 1000;
const HOST = '127.0.0.1';
const BACKGROUND = process.env.RIAH_USAGE_BACKGROUND === '1';
const PID_FILE = path.join(ROOT, 'scratch', 'desk.pid');

let collecting = false;
let lastCollectAt = null;
let lastCollectOk = null;

function writePid() {
  try {
    fs.mkdirSync(path.dirname(PID_FILE), { recursive: true });
    fs.writeFileSync(PID_FILE, String(process.pid), 'utf8');
  } catch (_) {}
}

function clearPid() {
  try {
    if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE);
  } catch (_) {}
}

function collect() {
  if (collecting) return Promise.resolve(false);
  collecting = true;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'collect-usage.js')], {
      cwd: ROOT,
      windowsHide: true,
    });
    let out = '';
    child.stdout.on('data', (d) => {
      out += d;
      process.stdout.write(d);
    });
    child.stderr.on('data', (d) => process.stderr.write(d));
    child.on('close', (code) => {
      collecting = false;
      lastCollectAt = new Date().toISOString();
      lastCollectOk = code === 0;
      if (code !== 0) console.error('Collect exited', code);
      resolve(code === 0);
    });
    child.on('error', (err) => {
      collecting = false;
      lastCollectOk = false;
      console.error(err);
      resolve(false);
    });
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function send(res, code, body, type) {
  res.writeHead(code, {
    'Content-Type': type || 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function serveFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      send(res, 404, 'Not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    send(res, 200, data, MIME[ext] || 'application/octet-stream');
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * The guest list. Only these origins may talk to the local API.
 *
 * SECURITY (Riah Security RS-036, 2026-07-20): this allowlist used to be
 * consulted ONLY on the CORS preflight. A POST sent with
 * `Content-Type: text/plain` is a CORS *simple request* and never preflights,
 * so any website could skip the check entirely — and the POST handler then
 * reflected `Access-Control-Allow-Origin: <whatever origin asked>`. Anything
 * it pushed was persisted and later rendered into the dashboard's HTML.
 *
 * The allowlist itself was always correct. It just wasn't being asked.
 * Now every /api/ handler calls it FIRST, before doing any work.
 */
const ALLOWED_ORIGINS = [
  'https://gemini.google.com',
  `http://127.0.0.1:${PORT}`,
  `http://localhost:${PORT}`,
];

/**
 * @param {string} origin        the request's Origin header ('' when absent)
 * @param {boolean} allowMissing whether a MISSING Origin is acceptable.
 *   Pass false on anything that changes state — every /api/ POST here does.
 *   A same-origin fetch from our own page always sends Origin, so requiring
 *   it costs us nothing and closes the "no header = no check" bypass.
 */
function corsOk(origin, allowMissing) {
  if (!origin) return !!allowMissing;
  return ALLOWED_ORIGINS.includes(origin);
}

/** Set CORS response headers for an origin we've ALREADY validated. */
function corsHeaders(res, origin) {
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  // Chrome/Brave: allow the Gemini usage page → localhost desk. Only ever sent
  // alongside an approved Allow-Origin, so it is not a blanket invitation.
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
}

/** Refuse a request whose Origin isn't on the guest list. */
function denyOrigin(res) {
  res.writeHead(403, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify({ ok: false, error: 'bad_origin' }));
}

/**
 * Require a real JSON content type on state-changing POSTs.
 *
 * This is the second half of the RS-036 fix: `application/json` is NOT a
 * CORS simple-request type, so requiring it forces a preflight, which forces
 * the browser to consult the allowlist above before the request is ever sent.
 */
function jsonContentType(req) {
  const ct = String(req.headers['content-type'] || '').toLowerCase();
  return ct.startsWith('application/json');
}

function saveGeminiBridge(payload) {
  const scratch = path.join(ROOT, 'scratch');
  fs.mkdirSync(scratch, { recursive: true });
  const meters = Array.isArray(payload.meters)
    ? payload.meters
        .filter((m) => m && m.label != null && m.usedPercent != null)
        .map((m) => ({
          label: String(m.label),
          usedPercent: Math.round(Number(m.usedPercent)),
          resetsAt: m.resetsAt || null,
        }))
    : [];
  if (!meters.length) return { ok: false, error: 'no_meters' };
  const data = {
    ok: true,
    plan: payload.plan || null,
    meters,
    source: 'page-sync',
    href: 'https://gemini.google.com/usage',
    receivedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(scratch, 'gemini-bridge.json'), JSON.stringify(data, null, 2), 'utf8');
  return { ok: true };
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${HOST}:${PORT}`);
  const p = url.pathname;
  const origin = req.headers.origin || '';

  if (p === '/api/gemini-usage' && req.method === 'OPTIONS') {
    // Only echo CORS approval to an origin that's actually on the list.
    if (!corsOk(origin, true)) {
      res.writeHead(403);
      res.end();
      return;
    }
    corsHeaders(res, origin);
    res.writeHead(204);
    res.end();
    return;
  }

  if (p === '/api/gemini-usage' && req.method === 'POST') {
    // RS-036: check the guest list BEFORE doing any work, and refuse a
    // missing Origin — this endpoint changes state and triggers a collect.
    if (!corsOk(origin, false)) {
      denyOrigin(res);
      return;
    }
    if (!jsonContentType(req)) {
      res.writeHead(415, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify({ ok: false, error: 'expected_application_json' }));
      return;
    }
    readBody(req)
      .then((buf) => {
        let payload;
        try {
          payload = JSON.parse(buf.toString('utf8') || '{}');
        } catch (e) {
          res.writeHead(400, {
            'Content-Type': 'application/json; charset=utf-8',
            // origin is validated above — never reflect an unchecked value.
            'Access-Control-Allow-Origin': origin,
            'Cache-Control': 'no-store',
          });
          res.end(JSON.stringify({ ok: false, error: 'bad_json' }));
          return;
        }
        const saved = saveGeminiBridge(payload);
        if (!saved.ok) {
          res.writeHead(400, {
            'Content-Type': 'application/json; charset=utf-8',
            // origin is validated above — never reflect an unchecked value.
            'Access-Control-Allow-Origin': origin,
            'Cache-Control': 'no-store',
          });
          res.end(JSON.stringify(saved));
          return;
        }
        collect().then((ok) => {
          res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            // origin is validated above — never reflect an unchecked value.
            'Access-Control-Allow-Origin': origin,
            'Cache-Control': 'no-store',
          });
          res.end(JSON.stringify({ ok: true, collected: ok, lastCollectAt }));
        });
      })
      .catch(() => {
        res.writeHead(500, {
          'Content-Type': 'application/json; charset=utf-8',
          // origin is validated above — never reflect an unchecked value.
          'Access-Control-Allow-Origin': origin,
          'Cache-Control': 'no-store',
        });
        res.end(JSON.stringify({ ok: false, error: 'read_failed' }));
      });
    return;
  }

  if (p === '/api/status') {
    send(
      res,
      200,
      JSON.stringify({
        lastCollectAt,
        lastCollectOk,
        collecting,
        refreshMs: REFRESH_MS,
      }),
      'application/json; charset=utf-8'
    );
    return;
  }

  // Clean a name list from the page (order / hidden). Same shape, same caps.
  function cleanNameList(raw) {
    if (!Array.isArray(raw)) throw new Error('not an array');
    return raw
      .filter((n) => typeof n === 'string')
      .map((n) => String(n).slice(0, 40))
      .slice(0, 24);
  }

  // Patch the live usage-data.js so the tray picks up prefs without waiting
  // for the next 5-minute collect. Keeps meters intact; only touches `hidden`.
  function patchUsageHidden(hiddenNames) {
    const outJs = path.join(ROOT, 'usage-data.js');
    if (!fs.existsSync(outJs)) return;
    try {
      const raw = fs.readFileSync(outJs, 'utf8');
      const i = raw.indexOf('{');
      const j = raw.lastIndexOf('}');
      if (i < 0 || j <= i) return;
      const data = JSON.parse(raw.slice(i, j + 1));
      data.hidden = hiddenNames;
      const payload =
        '/* auto-generated — do not hand-edit */\nwindow.USAGE_DATA = ' +
        JSON.stringify(data, null, 2) +
        ';\n';
      const tmp = path.join(ROOT, 'scratch', 'usage-data.js.tmp');
      fs.mkdirSync(path.join(ROOT, 'scratch'), { recursive: true });
      fs.writeFileSync(tmp, payload, 'utf8');
      try {
        fs.renameSync(tmp, outJs);
      } catch (_) {
        fs.writeFileSync(outJs, payload, 'utf8');
      }
    } catch (_) {}
  }

  // Card order, so the tray and the page agree. The page used to keep the
  // dragged order in browser localStorage only -- which the tray icon can never
  // read, so the two showed different orders and the order died with the
  // browser profile. Saving it here makes the data file the single truth.
  if (p === '/api/order' && req.method === 'POST') {
    if (!corsOk(origin, false)) {
      denyOrigin(res);
      return;
    }
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 4096) req.destroy();
    });
    req.on('end', () => {
      try {
        const clean = cleanNameList(JSON.parse(body));
        fs.mkdirSync(path.join(ROOT, 'scratch'), { recursive: true });
        fs.writeFileSync(
          path.join(ROOT, 'scratch', 'order.json'),
          JSON.stringify(clean),
          'utf8'
        );
        send(res, 200, JSON.stringify({ ok: true }), 'application/json; charset=utf-8');
      } catch (e) {
        send(res, 400, JSON.stringify({ ok: false }), 'application/json; charset=utf-8');
      }
    });
    return;
  }

  // "Shown on the board" checkboxes — same story as order. localStorage alone
  // hid a provider on the web page but the tray hover still listed it
  // (Captain, 2026-07-21: Gemini stayed on the hover after uncheck).
  if (p === '/api/hidden' && req.method === 'POST') {
    if (!corsOk(origin, false)) {
      denyOrigin(res);
      return;
    }
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 4096) req.destroy();
    });
    req.on('end', () => {
      try {
        const clean = cleanNameList(JSON.parse(body));
        fs.mkdirSync(path.join(ROOT, 'scratch'), { recursive: true });
        fs.writeFileSync(
          path.join(ROOT, 'scratch', 'hidden.json'),
          JSON.stringify(clean),
          'utf8'
        );
        patchUsageHidden(clean);
        send(res, 200, JSON.stringify({ ok: true }), 'application/json; charset=utf-8');
      } catch (e) {
        send(res, 400, JSON.stringify({ ok: false }), 'application/json; charset=utf-8');
      }
    });
    return;
  }

  // One-click sign-in. The card offers a button; this opens a terminal already
  // running the right command, so nobody has to be told to "open PowerShell and
  // type this". The command is chosen HERE from a fixed list keyed by provider
  // id -- the browser never sends a command, only a name, so a poisoned page
  // cannot make this run anything of its own.
  if (p === '/api/relogin' && req.method === 'POST') {
    if (!corsOk(origin, false)) {
      denyOrigin(res);
      return;
    }
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 512) req.destroy();
    });
    req.on('end', () => {
      let id = '';
      try {
        id = String((JSON.parse(body) || {}).id || '').toLowerCase();
      } catch {}
      const RECIPES = {
        claude: { cmd: 'claude', note: 'Then type /login inside Claude Code.' },
        codex: { cmd: 'codex login', note: 'Finish the browser sign-in.' },
        grok: { cmd: 'grok login', note: 'Finish the browser sign-in.' },
        gemini: { cmd: null, note: 'Use Connect → Gemini → Sync Gemini.' },
        copilot: { cmd: 'gh auth login', note: 'Follow the prompts.' },
        cursor: { cmd: null, note: 'Open the Cursor app and sign in.' },
        kimi: { cmd: 'kimi login', note: 'Finish the browser sign-in.' },
      };
      const r = RECIPES[id];
      if (!r) {
        send(res, 400, JSON.stringify({ ok: false }), 'application/json; charset=utf-8');
        return;
      }
      if (!r.cmd) {
        send(res, 200, JSON.stringify({ ok: true, note: r.note }), 'application/json; charset=utf-8');
        return;
      }
      try {
        if (process.platform === 'win32') {
          // A VISIBLE window on purpose: the sign-in is interactive, and a
          // hidden one is how "Start desk" appeared to do nothing for a day.
          spawn('cmd.exe', ['/c', 'start', '', 'cmd', '/k', r.cmd], {
            detached: true,
            stdio: 'ignore',
          }).unref();
        } else {
          spawn('sh', ['-c', r.cmd], { detached: true, stdio: 'ignore' }).unref();
        }
        send(res, 200, JSON.stringify({ ok: true, note: r.note }), 'application/json; charset=utf-8');
      } catch (e) {
        send(res, 500, JSON.stringify({ ok: false, note: r.note }), 'application/json; charset=utf-8');
      }
    });
    return;
  }

  if (p === '/api/refresh' && req.method === 'POST') {
    // RS-037: this had NO origin check at all — any website could force a
    // full provider re-collect (CPU, and hammering the provider APIs with
    // Captain's own tokens). State-changing, so a missing Origin is refused.
    if (!corsOk(origin, false)) {
      denyOrigin(res);
      return;
    }
    collect().then((ok) => {
      send(
        res,
        200,
        JSON.stringify({ ok, lastCollectAt, lastCollectOk }),
        'application/json; charset=utf-8'
      );
    });
    return;
  }

  if (p === '/api/sync-gemini' && req.method === 'POST') {
    // RS-037: this had NO origin check either, and it SPAWNS A DETACHED
    // PROCESS that opens a browser window. Any site could make the machine
    // pop Google tabs on repeat — and an open Gemini tab locks the browser's
    // cookie DB, which helps create the failing-cookie-pull state RS-036
    // needed. Closing this closes that assist too.
    if (!corsOk(origin, false)) {
      denyOrigin(res);
      return;
    }
    try {
      const statusPath = path.join(ROOT, 'scratch', 'gemini-sync-status.json');
      fs.mkdirSync(path.dirname(statusPath), { recursive: true });
      fs.writeFileSync(
        statusPath,
        JSON.stringify({ running: true, ok: null, error: null, at: new Date().toISOString() }),
        'utf8'
      );
      // Browser window only — no terminal left open. Same Node as the desk.
      const child = spawn(process.execPath, [path.join(ROOT, 'sync-gemini.js')], {
        cwd: ROOT,
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: { ...process.env, RIAH_USAGE_SYNC: '1' },
      });
      child.on('error', (err) => {
        console.error('sync-gemini spawn', err);
        try {
          fs.writeFileSync(
            statusPath,
            JSON.stringify({
              running: false,
              ok: false,
              error: 'spawn_failed',
              at: new Date().toISOString(),
            }),
            'utf8'
          );
        } catch (_) {}
      });
      child.on('exit', (code) => {
        try {
          fs.writeFileSync(
            statusPath,
            JSON.stringify({
              running: false,
              ok: code === 0,
              error: code === 0 ? null : 'sync_failed',
              at: new Date().toISOString(),
            }),
            'utf8'
          );
        } catch (_) {}
        collect();
      });
      child.unref();
      send(res, 200, JSON.stringify({ ok: true, started: true }), 'application/json; charset=utf-8');
    } catch (e) {
      console.error(e);
      send(
        res,
        500,
        JSON.stringify({ ok: false, error: 'spawn_failed' }),
        'application/json; charset=utf-8'
      );
    }
    return;
  }

  if (p === '/api/sync-gemini' && req.method === 'GET') {
    let st = { running: false, ok: null, error: null };
    try {
      st = JSON.parse(
        fs.readFileSync(path.join(ROOT, 'scratch', 'gemini-sync-status.json'), 'utf8')
      );
    } catch (_) {}
    send(res, 200, JSON.stringify(st), 'application/json; charset=utf-8');
    return;
  }

  let rel = p === '/' ? '/index.html' : p;
  rel = path.normalize(rel).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(ROOT, rel);
  if (!filePath.startsWith(ROOT)) {
    send(res, 403, 'Forbidden');
    return;
  }

  /**
   * RS-038: `usage-data.js` is a bare `window.USAGE_DATA = {...}` assignment,
   * so ANY website could read it with `<script src="http://127.0.0.1:8775/
   * usage-data.js">` — CORS does not apply to <script> tags. That leaks which
   * AI products you pay for, at what tier, what they cost, and how hard you're
   * using them, plus it fingerprints "this visitor runs Riah Usage".
   *
   * Fix: refuse when the browser tells us this is a CROSS-SITE subresource
   * load. `Sec-Fetch-Site` is set by the browser and cannot be forged by page
   * JS. Same-origin loads (our own index.html) send `same-origin` and are
   * unaffected, and opening the file straight off disk (file://) never touches
   * this server at all — so no legitimate use breaks.
   */
  const fetchSite = String(req.headers['sec-fetch-site'] || '').toLowerCase();
  if (fetchSite === 'cross-site' && !corsOk(origin, false)) {
    send(res, 403, 'Forbidden');
    return;
  }

  serveFile(res, filePath);
});

function openBrowser(url) {
  if (process.env.RIAH_USAGE_NO_BROWSER === '1' || BACKGROUND) return;
  const plat = process.platform;
  if (plat === 'win32') exec(`start "" "${url}"`);
  else if (plat === 'darwin') exec(`open "${url}"`);
  else exec(`xdg-open "${url}"`);
}

async function main() {
  // Survive collect glitches / Drive file locks — never exit the desk for those.
  process.on('uncaughtException', (err) => {
    console.error('uncaughtException (desk stays up):', err && err.message ? err.message : err);
  });
  process.on('unhandledRejection', (err) => {
    console.error('unhandledRejection (desk stays up):', err && err.message ? err.message : err);
  });
  process.on('exit', clearPid);
  process.on('SIGINT', () => {
    clearPid();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    clearPid();
    process.exit(0);
  });

  if (!BACKGROUND) console.log('Riah Usage — collecting once…');
  try {
    await collect();
  } catch (e) {
    console.error('initial collect failed (desk still starting):', e && e.message ? e.message : e);
  }

  server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
      console.error(`Port ${PORT} already in use — another Riah Usage is probably already running.`);
      process.exit(0);
      return;
    }
    console.error('server error:', err);
    process.exit(1);
  });

  server.listen(PORT, HOST, () => {
    const url = `http://${HOST}:${PORT}/`;
    writePid();
    // Windows: show the tray icon (hover = meters at a glance). Best-effort,
    // singleton-guarded inside the tray script. Opt out: RIAH_USAGE_NO_TRAY=1
    try {
      require('./tray/launch-tray.js').maybeStartTray(ROOT);
    } catch (_) {}
    if (!BACKGROUND) {
      console.log(`Live at ${url}`);
      console.log(
        'Auto-refresh every ' +
          Math.round(REFRESH_MS / 60000) +
          ' min. Prefer Start Riah Usage.bat (background - no terminal left open).'
      );
      openBrowser(url);
    }
  });

  setInterval(() => {
    collect().catch((e) => {
      console.error('refresh collect failed:', e && e.message ? e.message : e);
    });
  }, REFRESH_MS);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
