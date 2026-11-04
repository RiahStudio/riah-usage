#!/usr/bin/env node
/**
 * Riah Usage — refresh live meters into usage-data.js.
 * Each provider carries meters[] (all numbers). Empty providers omitted.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const os = require('os');
const dns = require('dns');
const { spawnSync, execFile } = require('child_process');
const { parseGrokBilling } = require('./lib/parse-grok-billing');
const { parseSandWeeklyUsage } = require('./lib/parse-sand-usage');
const { prettyPlan, planPrice, inferGrokPlan } = require('./lib/plan-labels');

const ROOT = __dirname;
const OUT_JS = path.join(ROOT, 'usage-data.js');
const HOME = os.homedir();

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

// One more try for a dropped connection or a vendor 5xx. The Wi-Fi here drops
// a request now and then, and a single miss used to leave a card on its old
// reading until the next collect, 3 minutes later (2026-10-21). GET only: a
// POST such as a token refresh must never be sent twice.
async function requestJson(url, opts = {}) {
  const first = await requestJsonOnce(url, opts);
  if ((opts.method && opts.method !== 'GET') || (first.status !== 0 && first.status < 500)) return first;
  await new Promise((r) => setTimeout(r, 1500));
  return requestJsonOnce(url, opts);
}

function requestJsonOnce(url, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve) => {
    let u;
    try {
      u = new URL(url);
    } catch {
      resolve({ ok: false, status: 0 });
      return;
    }
    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        port: u.port || (u.protocol === 'http:' ? 80 : 443),
        method,
        headers,
        timeout: 20000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          let json = null;
          try {
            json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch {
            /* ignore */
          }
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            json,
          });
        });
      }
    );
    req.on('error', () => resolve({ ok: false, status: 0 }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, status: 0 });
    });
    if (body) req.write(body);
    req.end();
  });
}

// Which Python to call. Windows normally has "python"; macOS and most Linux
// distros ship ONLY "python3" and have no "python" at all. Calling the bare
// name killed four meters at once (Claude, Cursor, Copilot, Gemini) on any
// non-Windows machine, while working perfectly on the author's. Resolve it once
// and remember it.
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
  PY = candidates[0]; // nothing answered; try the usual one and let it fail loudly
  return PY;
}

// One collect = one fresh process, so this cache lives exactly one cycle. It
// serves two jobs: prefetchPulls() fills it in parallel, and a script asked for
// twice in one cycle (Cursor and Copilot each were) runs once.
const PULL_CACHE = new Map();

function parsePull(stdout) {
  if (!stdout) return null;
  try {
    return JSON.parse(String(stdout).trim().split(/\r?\n/).filter(Boolean).pop());
  } catch {
    return null;
  }
}

function pyPull(scriptName) {
  if (PULL_CACHE.has(scriptName)) return PULL_CACHE.get(scriptName);
  const script = path.join(ROOT, 'lib', scriptName);
  if (!fs.existsSync(script)) return null;
  const r = spawnSync(pythonCmd(), [script], {
    encoding: 'utf8',
    timeout: 45000,
    windowsHide: true,
  });
  const out = parsePull(r.stdout);
  PULL_CACHE.set(scriptName, out);
  return out;
}

function pyPullAsync(scriptName) {
  const script = path.join(ROOT, 'lib', scriptName);
  if (!fs.existsSync(script)) {
    PULL_CACHE.set(scriptName, null);
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    execFile(
      pythonCmd(),
      [script],
      { encoding: 'utf8', timeout: 45000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (_err, stdout) => {
        const out = parsePull(stdout);
        PULL_CACHE.set(scriptName, out);
        resolve(out);
      }
    );
  });
}

/**
 * Run the Python readers side by side (three at a time -- this machine is
 * also somebody's desktop) instead of one after another. Sequential, a collect
 * took ~52s, which put a floor under how fresh the numbers could ever be.
 * The slow Gemini browser fallback only runs if the Gemini CLI login fails,
 * exactly as pullGemini() decides.
 */
async function prefetchPulls() {
  pythonCmd(); // resolve the interpreter once, before anything runs beside it
  const tasks = [
    async () => {
      const cli = await pyPullAsync('pull-gemini-cli.py');
      if (!cli?.ok) await pyPullAsync('pull-gemini.py');
    },
    () => pyPullAsync('pull-cursor.py'),
    () => pyPullAsync('pull-kimi.py'),
    () => pyPullAsync('pull-copilot.py'),
    () => pyPullAsync('pull-claude.py'),
  ];
  const lane = async () => {
    while (tasks.length) {
      const next = tasks.shift();
      try {
        await next();
      } catch {}
    }
  };
  await Promise.all([lane(), lane(), lane()]);
}

function provider(shortName, meters, href, plan, livePrice, status) {
  const clean = (meters || [])
    .filter((m) => m && m.usedPercent != null && !Number.isNaN(Number(m.usedPercent)))
    .map((m) => ({
      label: m.label,
      usedPercent: Math.round(Number(m.usedPercent)),
      resetsAt: m.resetsAt || null,
    }));
  if (!clean.length && status !== 'reconnect') return null;
  const planLabel = prettyPlan(plan, shortName);
  return {
    shortName,
    plan: planLabel,
    price: planPrice(shortName, planLabel, livePrice),
    meters: clean,
    status: status || 'live',
    links: href ? [{ label: 'Open', href }] : [],
  };
}

function stubReconnect(shortName, href) {
  return provider(shortName, [], href, null, null, 'reconnect');
}

/** Refresh expired Grok OIDC access token using refresh_token; updates ~/.grok/auth.json. */
async function refreshGrokAuth() {
  const authPath = path.join(HOME, '.grok', 'auth.json');
  const auth = readJson(authPath);
  if (!auth || typeof auth !== 'object') return null;
  const id = Object.keys(auth)[0];
  const entry = auth[id];
  if (!entry?.refresh_token || !entry?.oidc_issuer || !entry?.oidc_client_id) return null;
  const issuer = String(entry.oidc_issuer).replace(/\/$/, '');
  const confRes = await requestJson(
    issuer + '/.well-known/openid-configuration'
  );
  const tokenUrl = confRes.json?.token_endpoint;
  if (!tokenUrl) return null;
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: entry.refresh_token,
    client_id: entry.oidc_client_id,
  }).toString();
  const tokRes = await new Promise((resolve) => {
    let u;
    try {
      u = new URL(tokenUrl);
    } catch {
      resolve({ ok: false });
      return;
    }
    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        port: u.port || (u.protocol === 'http:' ? 80 : 443),
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
          Accept: 'application/json',
        },
        timeout: 20000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          let json = null;
          try {
            json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch {
            /* ignore */
          }
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            json,
          });
        });
      }
    );
    req.on('error', () => resolve({ ok: false }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false });
    });
    req.write(body);
    req.end();
  });
  if (!tokRes.ok || !tokRes.json?.access_token) return null;
  entry.key = tokRes.json.access_token;
  if (tokRes.json.refresh_token) entry.refresh_token = tokRes.json.refresh_token;
  if (tokRes.json.expires_in) {
    entry.expires_at = new Date(
      Date.now() + Number(tokRes.json.expires_in) * 1000
    ).toISOString();
  }
  auth[id] = entry;
  try {
    fs.writeFileSync(authPath, JSON.stringify(auth, null, 2), 'utf8');
  } catch {
    /* still return token for this run */
  }
  return entry.key;
}

async function pullCodex() {
  const auth = readJson(path.join(HOME, '.codex', 'auth.json'));
  if (!auth) {
    lastError.Codex = 'no_token';
    return null;
  }
  const token = auth.tokens?.access_token || auth.access_token || null;
  const accountId =
    auth.tokens?.account_id || auth.account_id || auth.account?.id || null;
  if (!token) {
    lastError.Codex = 'no_token';
    return null;
  }
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
  };
  if (accountId) headers['ChatGPT-Account-Id'] = accountId;
  const res = await requestJson('https://chatgpt.com/backend-api/wham/usage', {
    headers,
  });
  if (!res.ok || !res.json) {
    lastError.Codex = res && res.status ? 'http_' + res.status : 'no_answer';
    return null;
  }
  const meters = [];
  const pushWin = (win, fallbackLabel) => {
    if (!win || win.used_percent == null) return;
    const secs = win.limit_window_seconds || 0;
    const label =
      secs >= 500000 ? 'Weekly' : secs >= 14000 ? '5-hour' : fallbackLabel;
    meters.push({
      label,
      usedPercent: win.used_percent,
      resetsAt: win.reset_at
        ? new Date(
            (win.reset_at > 1e12 ? win.reset_at : win.reset_at * 1000)
          ).toISOString()
        : null,
    });
  };
  pushWin(res.json.rate_limit?.primary_window, 'Session');
  pushWin(res.json.rate_limit?.secondary_window, 'Second');
  return provider(
    'Codex',
    meters,
    'https://chatgpt.com/#settings',
    res.json.plan_type,
    null
  );
}

async function pullGrokOnce(token) {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
  };
  const [res, userRes, billRes] = await Promise.all([
    requestJson('https://cli-chat-proxy.grok.com/v1/billing?format=credits', {
      headers,
    }),
    requestJson('https://cli-chat-proxy.grok.com/v1/user', { headers }),
    requestJson('https://cli-chat-proxy.grok.com/v1/billing', { headers }),
  ]);
  return { res, userRes, billRes };
}

async function pullGrok() {
  const auth = readJson(path.join(HOME, '.grok', 'auth.json'));
  if (!auth) {
    lastError.Grok = 'no_token';
    return null;
  }
  const entry = Object.values(auth)[0];
  let token = entry?.key || entry?.access_token || null;
  if (!token && entry?.refresh_token) token = await refreshGrokAuth();
  if (!token) {
    lastError.Grok = 'no_token';
    return null;
  }

  let { res, userRes, billRes } = await pullGrokOnce(token);
  // Only a refused token is a sign-in problem. Refreshing on a dropped
  // connection rotated the Grok CLI's refresh token for nothing.
  if ((res.status === 401 || res.status === 403) && entry?.refresh_token) {
    const fresh = await refreshGrokAuth();
    if (fresh) {
      token = fresh;
      ({ res, userRes, billRes } = await pullGrokOnce(token));
    }
  }
  if (!res.ok || !res.json) {
    lastError.Grok = res && res.status ? 'http_' + res.status : 'no_answer';
    // Keep the last reading, marked old, like every other card. A reconnect
    // card here counted as a fresh reading, so one dropped request wiped Grok
    // off the board until a later read happened to land (2026-10-21).
    return null;
  }

  const bill = billRes.ok ? billRes.json : null;
  const meters = parseGrokBilling(res.json, bill);
  if (!meters.length) {
    lastError.Grok = 'no_meters';
    return null;
  }
  const user = userRes.ok ? userRes.json : null;
  const billCfg = bill?.config || bill;
  const creditsCfg = (res.json && (res.json.config || res.json)) || {};
  const plan = inferGrokPlan(user, billCfg, {
    credits: creditsCfg,
    override: readPlanOverrides().Grok,
  });
  return provider('Grok', meters, 'https://grok.com/', plan, null);
}

/** Local plan pins (gitignored). xAI's CLI omits Heavy vs Super. */
function readPlanOverrides() {
  try {
    const raw = readJson(path.join(ROOT, 'scratch', 'plan-overrides.json'));
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

// Remembers why the newest attempt failed, so a kept-back reading can say what
// is wrong instead of just getting older. Filled by the pullers below.
const lastError = {};

// Turn a machine error into something a CUSTOMER can act on. Nobody should have
// to read "no_claude_code_oauth", and nobody should have to be told to open a
// terminal. Each entry is a plain sentence plus the single action that fixes
// it -- the desk offers that action as a button. (Captain, 2026-07-20:
// "This is something that's for customers, so they should be able to fix this
// at a click.")
// "Re-sign in", not "sign in". Anyone looking at a Claude meter is already a
// Claude customer -- telling them they are not signed in is both wrong and
// slightly insulting. What actually happened is that a session lapsed.
// (Captain, 2026-07-20.)
const FIXES = {
  Claude: { verb: 'Re-sign in', id: 'claude' },
  Codex: { verb: 'Re-sign in', id: 'codex' },
  Grok: { verb: 'Re-sign in', id: 'grok' },
  Gemini: { verb: 'Re-sign in', id: 'gemini' },
  Copilot: { verb: 'Re-sign in', id: 'copilot' },
  Cursor: { verb: 'Open Cursor', id: 'cursor' },
  'Grok Bot': { verb: 'Open Cursor', id: 'cursor' },
  Kimi: { verb: 'Re-sign in', id: 'kimi' },
};

function plainReason(name, raw) {
  const s = String(raw || '').toLowerCase();
  if (s === 'offline') {
    return 'No internet right now. This is the last reading.';
  }
  if (!s) return 'Lost the connection.';
  if (s.includes('no_claude_code_oauth') || s.includes('no_token') || s.includes('no_gemini_cli_login') || s.includes('no_kimi_login')) {
    return 'Sign-in needs renewing.';
  }
  if (s.includes('borrowed_login_idle')) {
    return "Borrowing Claude Code's sign-in, and it's idle. Re-sign in gives Riah Usage its own.";
  }
  if (name === 'Claude' && s.includes('http_429')) {
    return 'Claude returned HTTP 429 for its usage read. Riah Usage will retry automatically.';
  }
  if (s.includes('no_subscription')) {
    return 'Signed in, but this account has no Kimi for Coding plan.';
  }
  if (s.includes('refresh') || s.includes('401') || s.includes('403') || s.includes('expired')) {
    return 'Sign-in expired.';
  }
  if (s.includes('not_google_login')) {
    return 'Set to an API key, not a Google sign-in.';
  }
  if (s.includes('no_project')) {
    return 'Google retired this quota for personal accounts.';
  }
  if (s.includes('timeout') || s.includes('econn') || s.includes('enotfound')) {
    return name + ' did not answer — it may be down, or you are offline.';
  }
  if (s.includes('no_meters') || s.includes('no_answer')) {
    return 'Signed in, but no usage came back just now.';
  }
  if (s.includes('could not run')) {
    return 'Could not run the reader on this computer.';
  }
  return 'Lost the connection.';
}

function pullClaude() {
  const j = pyPull('pull-claude.py');
  if (!j?.ok) {
    // The reason used to die right here, which is how a card sat at "54m old"
    // with nothing anywhere explaining that the sign-in had expired.
    lastError.Claude = (j && (j.error || j.hint)) || 'could not run the Claude reader';
    const err = String((j && j.error) || '');
    if (
      err === 'no_claude_code_oauth' ||
      err === 'no_access_token' ||
      err === 'refresh_failed' ||
      /^http_401/.test(err) ||
      /^http_403/.test(err)
    ) {
      const stub = stubReconnect('Claude', 'https://claude.ai/settings/usage');
      if (stub) stub.reconnectHint = 'Tap to re-sign in';
      return stub;
    }
    return null;
  }
  return provider('Claude', j.meters, j.href, j.plan, null);
}

function pullGemini() {
  // Preferred path: the Gemini CLI's own Google login, already on disk. Same
  // shape as Claude/Codex/Grok/Copilot -- no browser, no cookies, nothing left
  // open. Reports Code Assist quota.
  const cli = pyPull('pull-gemini-cli.py');
  if (cli?.ok) {
    return provider(
      'Gemini',
      cli.meters,
      cli.href || 'https://gemini.google.com/',
      cli.plan,
      null
    );
  }
  // Fallback: read the Usage page from a signed-in browser. Kept for anyone who
  // does not want the CLI, but it is the weaker of the two.
  const j = pyPull('pull-gemini.py');
  if (!j?.ok) {
    const err = String(j?.error || '');
    const cliErr = String(cli?.error || '');
    // If the CLI simply is not signed in, say THAT -- it is the fix we want
    // people to reach for, and it is one command.
    const cliFixable =
      cliErr === 'no_gemini_cli_login' ||
      cliErr === 'not_google_login' ||
      cliErr === 'no_oauth_client' ||
      cliErr.startsWith('refresh_') ||
      cliErr.startsWith('http_401') ||
      cliErr.startsWith('http_403');
    if (
      cliFixable ||
      (j &&
        (err.includes('cookies_locked') ||
          err.includes('login_required') ||
          err.includes('no_google_auth') ||
          err.includes('no_browser_cookies') ||
          err.startsWith('http_401') ||
          err.startsWith('http_403')))
    ) {
      const stub = stubReconnect('Gemini', 'https://gemini.google.com/');
      if (stub) {
        // 2026-07-21: Google closed new CLI sign-ins for individual accounts,
        // so the browser sync is the fix regardless of which path failed.
        stub.reconnectHint = 'Tap Sync Gemini';
      }
      return stub;
    }
    return null;
  }
  return provider('Gemini', j.meters, j.href || 'https://gemini.google.com/usage', j.plan, null);
}

function pullCopilot() {
  return pullCopilotFrom(pyPull('pull-copilot.py'));
}

function pullCopilotFrom(j) {
  if (!j?.ok || !j.meters?.length) {
    lastError.Copilot = (j && (j.error || j.hint)) || 'no_meters';
    return null;
  }
  return provider(
    'Copilot',
    j.meters,
    'https://github.com/settings/copilot',
    j.plan,
    null
  );
}

function pullKimiFrom(j) {
  if (!j?.ok || !j.meters?.length) {
    lastError.Kimi = (j && (j.error || j.hint)) || 'no_meters';
    return null;
  }
  return provider('Kimi', j.meters, j.href || 'https://www.kimi.com/code', j.plan, null);
}

function cursorBillingEnd(j) {
  const s = (j && j.sources) || {};
  const candidates = [
    s.period?.billingCycleEnd,
    s.period?.billingCycleEndMs,
    s.period?.planUsage?.billingCycleEnd,
    s.plan_info?.planInfo?.billingCycleEnd,
    s.plan_info?.billingCycleEnd,
    s.usage_summary?.billingCycleEnd,
    s.usage_summary?.individualUsage?.plan?.billingCycleEnd,
    s.auth_usage?.endOfMonth,
    s.auth_usage?.startOfMonth, // last resort: next month from start
  ];
  for (const raw of candidates) {
    if (raw == null || raw === '') continue;
    // startOfMonth → approximate next cycle (same day next month) only if it's the startOfMonth key
    let n = Number(raw);
    if (!Number.isNaN(n) && n > 0) {
      if (n < 1e12) n *= 1000;
      return new Date(n).toISOString();
    }
    const d = new Date(raw);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  // If we only have startOfMonth, bump +1 calendar month as a soft estimate
  const start = s.auth_usage?.startOfMonth;
  if (start) {
    const d = new Date(start);
    if (!Number.isNaN(d.getTime())) {
      d.setMonth(d.getMonth() + 1);
      return d.toISOString();
    }
  }
  return null;
}

function stampCursorResets(meters, resetsAt) {
  if (!resetsAt || !meters?.length) return meters;
  return meters.map((m) =>
    m.resetsAt ? m : { ...m, resetsAt }
  );
}

function cursorProviderFromPull(j) {
  if (!j?.ok) {
    lastError.Cursor = (j && (j.error || j.hint)) || 'no_db';
    return null;
  }
  const plan =
    j.plan ||
    j.sources?.plan_info?.planInfo?.planName ||
    null;
  const livePrice = j.sources?.plan_info?.planInfo?.price || null;
  const resetsAt = cursorBillingEnd(j);
  if (Array.isArray(j.meters) && j.meters.length) {
    return provider(
      'Cursor',
      stampCursorResets(j.meters, resetsAt),
      'https://cursor.com/dashboard/usage',
      plan,
      livePrice
    );
  }
  const s = j.sources || {};
  const meters = [];
  const period = s.period;
  if (period) {
    const auto = period.autoPercentUsed ?? period.planUsage?.autoPercentUsed;
    const api = period.apiPercentUsed ?? period.planUsage?.apiPercentUsed;
    const total =
      period.totalPercentUsed ??
      period.percentUsed ??
      period.planUsage?.totalPercentUsed;
    if (total != null) meters.push({ label: 'Plan', usedPercent: total });
    if (auto != null) meters.push({ label: 'Auto', usedPercent: auto });
    if (api != null) meters.push({ label: 'API', usedPercent: api });
    const pu = period.planUsage || period;
    const spend = pu.totalSpendCents ?? pu.includedSpendCents ?? pu.spendCents;
    const limit = pu.limitCents ?? pu.includedLimitCents ?? pu.allowanceCents;
    if (!meters.length && spend != null && limit) {
      meters.push({
        label: 'Plan',
        usedPercent: (Number(spend) / Number(limit)) * 100,
      });
    }
  }
  const summary = s.usage_summary;
  if (!meters.length && summary) {
    const ind = summary.individualUsage?.plan || summary.plan || summary;
    const pct =
      ind.percentUsed ??
      ind.totalPercentUsed ??
      ind.autoPercentUsed ??
      summary.percentUsed;
    if (pct != null) meters.push({ label: 'Plan', usedPercent: pct });
  }
  const auth = s.auth_usage;
  if (!meters.length && auth && typeof auth === 'object') {
    let bestUsed = null;
    let bestMax = null;
    for (const v of Object.values(auth)) {
      if (!v || typeof v !== 'object') continue;
      const n = v.numRequests ?? v.requests ?? v.used;
      const m = v.maxRequestUsage ?? v.maxRequests ?? v.limit;
      if (n != null && m && (bestMax == null || Number(m) > bestMax)) {
        bestUsed = Number(n);
        bestMax = Number(m);
      }
    }
    if (bestUsed != null && bestMax) {
      meters.push({
        label: 'Requests',
        usedPercent: (bestUsed / bestMax) * 100,
      });
    }
  }
  return provider(
    'Cursor',
    stampCursorResets(meters, resetsAt),
    'https://cursor.com/dashboard/usage',
    plan,
    livePrice
  );
}

/** Grok Bot weekly is Cursor-metered. Same login, separate card. */
function grokBotProviderFromPull(j) {
  if (!j?.ok) {
    lastError['Grok Bot'] = (j && (j.error || j.hint)) || 'no_db';
    return null;
  }
  const sand = j.sources?.sand_usage;
  if (!sand) {
    lastError['Grok Bot'] = j.sources?.sand_usage_error || 'no_meters';
    return null;
  }
  const meters = parseSandWeeklyUsage(sand);
  if (!meters.length) {
    lastError['Grok Bot'] = 'no_meters';
    return null;
  }
  return provider(
    'Grok Bot',
    meters,
    'https://cursor.com/dashboard/usage',
    null,
    null
  );
}

function pullCursor() {
  return cursorProviderFromPull(pyPull('pull-cursor.py'));
}

/** Last good meters from the previous snapshot — used when a pull glitches. */
function readPreviousProviders() {
  try {
    const raw = fs.readFileSync(path.join(ROOT, 'usage-data.js'), 'utf8');
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start < 0 || end < start) return {};
    const data = JSON.parse(raw.slice(start, end + 1));
    const map = {};
    for (const p of data.providers || []) {
      // Remember WHEN this reading was taken, so a kept-back number can say
      // how old it is instead of pretending to be current.
      if (p && p.shortName) {
        map[p.shortName] = Object.assign({}, p, {
          readAt: p.readAt || data.generatedAt || null,
        });
      }
    }
    // A reconnect card has no meters. Keep the last actual Claude reading
    // across restarts and repeated API failures, clearly marked stale below.
    if (!map.Claude || map.Claude.status === 'reconnect' || !map.Claude.meters?.length) {
      const saved = readJson(path.join(ROOT, 'scratch', 'claude-last-good.json'));
      if (saved?.shortName === 'Claude' && Array.isArray(saved.meters) && saved.meters.length) {
        map.Claude = saved;
      }
    }
    return map;
  } catch {
    return {};
  }
}

function keepProvider(name, next, prevByName) {
  // A fresh reading always wins, and is stamped with the time it was taken.
  if (next) {
    const fresh = Object.assign({}, next, { readAt: new Date().toISOString(), stale: false });
    if (name === 'Claude' && fresh.meters.length && fresh.status !== 'reconnect') {
      try {
        fs.mkdirSync(path.join(ROOT, 'scratch'), { recursive: true });
        fs.writeFileSync(path.join(ROOT, 'scratch', 'claude-last-good.json'), JSON.stringify(fresh), 'utf8');
      } catch (_) {}
    }
    return fresh;
  }

  // No fresh reading. We can still show the last one -- an old number beats a
  // card that vanishes -- but it MUST be labelled. Handing back yesterday's
  // figure unmarked, under a green LIVE dot, is worse than showing nothing:
  // the app becomes confidently wrong and the user has no way to know.
  // (Captain, 2026-07-20: Claude weekly read 79% when it was really 91%.)
  const prev = prevByName[name];
  if (prev && Array.isArray(prev.meters) && prev.meters.length && prev.status !== 'reconnect') {
    return Object.assign({}, prev, {
      stale: true,
      readAt: prev.readAt || null,
      staleReason: plainReason(name, lastError[name]),
      // Signing in again fixes neither of these.
      fix: (name === 'Claude' && String(lastError[name] || '').includes('http_429')) ||
        lastError[name] === 'offline'
        ? null : FIXES[name] || null,
    });
  }
  return null;
}

/** Login present on disk (even if usage API glitched). Never reads token values into output. */
function authHints() {
  // Riah Usage's own Claude login first (lib/pull-claude.py), then Claude Code's.
  const claudeCred =
    readJson(path.join(HOME, '.riah-usage', 'claude', '.credentials.json')) ||
    readJson(path.join(HOME, '.claude', '.credentials.json'));
  const claudeO =
    (claudeCred && claudeCred.claudeAiOauth) || claudeCred || null;
  const codexAuth = readJson(path.join(HOME, '.codex', 'auth.json'));
  const grokAuth = readJson(path.join(HOME, '.grok', 'auth.json'));
  const grokEntry =
    grokAuth && typeof grokAuth === 'object'
      ? Object.values(grokAuth)[0]
      : null;
  return {
    Claude: !!(
      claudeO &&
      (claudeO.accessToken ||
        claudeO.refreshToken ||
        claudeO.access_token ||
        claudeO.refresh_token)
    ),
    // Cursor: filled from pull-cursor.py (ok means desktop login token present)
    Cursor: false,
    Codex: !!(
      codexAuth &&
      (codexAuth.tokens?.access_token || codexAuth.access_token)
    ),
    Grok: !!(grokEntry && (grokEntry.key || grokEntry.access_token)),
    'Grok Bot': false,
    // Gemini: the Gemini CLI's Google login, same as the others -- a real
    // on-disk hint at last, instead of the old "we cannot tell" false.
    Gemini: fs.existsSync(
      path.join(os.homedir(), '.gemini', 'oauth_creds.json')
    ),
    // Copilot: filled from pull-copilot.py when a GitHub/Copilot token is on disk
    Copilot: false,
    // Kimi: the Kimi Code CLI's device-flow login file
    Kimi: fs.existsSync(
      path.join(os.homedir(), '.kimi-code', 'credentials', 'kimi-code.json')
    ),
  };
}

function writeSnapshot(data) {
  // Atomic write — avoids Google Drive / antivirus lock crashes on direct open.
  fs.mkdirSync(path.join(ROOT, 'scratch'), { recursive: true });
  // Pure ASCII on purpose: the tray reads this with Windows PowerShell 5.1,
  // which decodes a BOM-less file as the system codepage. Claude's plan label
  // "Max 5×" turned into garbage there, the parse failed, and the tray froze
  // on old numbers with "Claude: no meters yet". (2026-10-19.) Escaped, the
  // same text reads identically in JSON and in the browser.
  const asciiJson = JSON.stringify(data, null, 2).replace(
    /[\u007f-￿]/g,
    (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')
  );
  const payload =
    '/* auto-generated - do not hand-edit */\nwindow.USAGE_DATA = ' +
    asciiJson +
    ';\n';
  const tmpJs = path.join(ROOT, 'scratch', 'usage-data.js.tmp');
  fs.writeFileSync(tmpJs, payload, 'utf8');
  try {
    fs.renameSync(tmpJs, OUT_JS);
  } catch (_) {
    // Rename can fail across locks; fall back to overwrite, then leave last good file.
    try {
      fs.writeFileSync(OUT_JS, payload, 'utf8');
    } catch (e2) {
      console.error('usage-data.js write skipped (file busy):', e2.code || e2.message);
    }
  }
  try {
    fs.writeFileSync(
      path.join(ROOT, 'scratch', 'last-usage.json'),
      JSON.stringify(data, null, 2),
      'utf8'
    );
  } catch (_) {}
}

// --claude-only: the desk's one-minute Claude watcher. Re-reads Claude alone
// and carries every other card over exactly as the last full collect left it,
// so the Claude card stays live without polling seven other vendors each
// minute. (Captain, 2026-10-19: "useless unless it's updated every minute or
// so -- it should be an automatic watcher.")
const CLAUDE_ONLY = process.argv.includes('--claude-only');

function readPreviousData() {
  try {
    const raw = fs.readFileSync(OUT_JS, 'utf8');
    return JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
  } catch {
    return null;
  }
}

// Can this PC reach the internet at all? After a wake from sleep the Wi-Fi or
// DNS can stay down for a while (2026-10-21: DNS timed out for every site for
// 20 minutes). Every vendor read then waited out its own timeout, a collect ran
// over a minute, and the board said Live over a page of old numbers while
// Refresh appeared to do nothing. Two lookups answer the question up front.
const NET_HOSTS = ['api.anthropic.com', 'chatgpt.com'];

function canReachInternet(ms = 5000) {
  const one = (host) =>
    new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), ms);
      dns.lookup(host, (err) => {
        clearTimeout(t);
        resolve(!err);
      });
    });
  return Promise.all(NET_HOSTS.map(one)).then((up) => up.some(Boolean));
}

// No internet: skip every vendor read and keep the last numbers, each card
// marked with how old it is. serve.js sees `offline` and looks again in 20s.
function writeOffline(prevByName) {
  const prev = readPreviousData();
  if (!prev) return;
  for (const name of Object.keys(FIXES)) lastError[name] = 'offline';
  const providers = (prev.providers || []).map((p) => keepProvider(p.shortName, null, prevByName) || p);
  writeSnapshot(Object.assign({}, prev, { generatedAt: new Date().toISOString(), providers, offline: true }));
  console.log('No internet: kept the last readings, looking again shortly.');
}

async function main() {
  const prevByName = readPreviousProviders();
  const prevData = CLAUDE_ONLY ? readPreviousData() : null;
  if (CLAUDE_ONLY && !prevData) return; // nothing to carry over yet; the full collect will run
  if (!(await canReachInternet())) return writeOffline(prevByName);
  const [codex, grok] = CLAUDE_ONLY
    ? [null, null]
    : await Promise.all([pullCodex(), pullGrok(), prefetchPulls()]);
  const claude = pullClaude();
  const gemini = CLAUDE_ONLY ? null : pullGemini();
  const copilotRaw = CLAUDE_ONLY ? null : pyPull('pull-copilot.py');
  const copilot = CLAUDE_ONLY ? null : pullCopilotFrom(copilotRaw);
  const cursorRaw = CLAUDE_ONLY ? null : pyPull('pull-cursor.py');
  const cursor = CLAUDE_ONLY ? null : cursorProviderFromPull(cursorRaw);
  const grokBot = CLAUDE_ONLY ? null : grokBotProviderFromPull(cursorRaw);
  const kimi = CLAUDE_ONLY ? null : pullKimiFrom(pyPull('pull-kimi.py'));
  if (CLAUDE_ONLY) {
    // Other cards: exactly what the last full collect wrote, untouched.
    const keep = (name, next) =>
      name === 'Claude' ? keepProvider(name, next, prevByName) : prevByName[name] || null;
    const claudeCard = keep('Claude', claude);
    const providers = (prevData.providers || [])
      .map((p) => (p.shortName === 'Claude' ? claudeCard : keep(p.shortName)))
      .filter(Boolean);
    if (claudeCard && !providers.some((p) => p.shortName === 'Claude')) providers.unshift(claudeCard);
    const live = !!(claudeCard && claudeCard.meters && claudeCard.meters.length && claudeCard.status !== 'reconnect');
    const data = Object.assign({}, prevData, {
      generatedAt: new Date().toISOString(),
      offline: undefined, // reached the internet just now
      providers,
      connections: (prevData.connections || []).map((c) =>
        c.id === 'Claude' ? { id: 'Claude', connected: live || !!authHints().Claude } : c
      ),
      missing: (prevData.missing || []).filter((m) => m.name !== 'Claude' || !live),
    });
    writeSnapshot(data);
    if (claudeCard) {
      console.log(`Claude: ${claudeCard.meters.map((m) => `${m.label} ${m.usedPercent}%`).join(' · ') || claudeCard.reconnectHint || claudeCard.staleReason || 'no meters yet'}`);
    }
    return;
  }

  // Glance order — never drop a working meter just because one refresh glitched.
  //
  // This is only the DEFAULT: drag-to-reorder on the page writes scratch/order.json
  // and wins below. But the default is what every new install sees on its first
  // run, so it leads with the ones people actually pay for — Claude, Cursor,
  // Codex — and puts Gemini last. Gemini used to sit second here purely because
  // of how this desk grew up; Google has since retired Code Assist for personal
  // accounts, so for most people it is the card least likely to report anything.
  const providers = [
    keepProvider('Claude', claude, prevByName),
    keepProvider('Cursor', cursor, prevByName),
    keepProvider('Codex', codex, prevByName),
    keepProvider('Grok', grok, prevByName),
    keepProvider('Grok Bot', grokBot, prevByName),
    keepProvider('Kimi', kimi, prevByName),
    keepProvider('Copilot', copilot, prevByName),
    keepProvider('Gemini', gemini, prevByName),
  ].filter(Boolean);
  const live = new Set(providers.map((p) => p.shortName));
  const hints = authHints();
  if (cursorRaw?.ok) hints.Cursor = true;
  if (cursorRaw?.ok && cursorRaw.sources?.sand_usage) hints['Grok Bot'] = true;
  if (copilotRaw?.ok || (copilotRaw && copilotRaw.error !== 'no_token')) {
    // Token found (even if org seat has no percent meters)
    if (copilotRaw && copilotRaw.error !== 'no_token') hints.Copilot = true;
  }
  if (copilot) hints.Copilot = true;
  const allIds = ['Claude', 'Cursor', 'Codex', 'Grok', 'Grok Bot', 'Gemini', 'Copilot', 'Kimi'];
  const connections = allIds.map((name) => ({
    id: name,
    connected: live.has(name) || !!hints[name],
  }));

  // Why a meter is not on the board. Every provider used to get the same
  // shrug ("open Connect in the desk") and the page then threw it away, so a
  // provider that needed one command looked identical to one that was broken.
  // Two states matter, and they need different words:
  //   no login on disk   -> tell them the exact command to run
  //   login but no meter -> the sign-in is stale, or the vendor said no
  const HOWTO = {
    Claude: 'Run `claude`, then `/login` inside it.',
    Cursor: 'Open the Cursor app and sign in.',
    Codex: 'Run `codex login` in a terminal.',
    Grok: 'Run `grok login` in a terminal.',
    'Grok Bot': 'Open Cursor or Grok Bot and sign in with the same account.',
    Gemini: 'In the desk: Connect → Gemini → Sync Gemini.',
    Copilot: 'Sign in to Copilot in your editor, or run `gh auth login`.',
    Kimi: 'Run `kimi login` in a terminal.',
  };

  const missing = allIds
    .filter((name) => !live.has(name))
    .map((name) => {
      const signedIn = !!hints[name];
      if (!signedIn) {
        return {
          name,
          state: 'not-connected',
          reason: 'Not connected yet.',
          action: HOWTO[name] || null,
        };
      }
      return {
        name,
        state: 'stale',
        reason: name === 'Claude' && String(lastError.Claude || '').includes('http_429')
          ? plainReason(name, lastError.Claude)
          : 'Signed in, but no usage came back just now.',
        action:
          name === 'Claude' && String(lastError.Claude || '').includes('http_429')
            ? 'Retrying automatically when Claude allows another check.'
            : name === 'Gemini'
            ? 'Google retired Gemini Code Assist for personal accounts, so this one may not report at all.'
            : name === 'Kimi' && String(lastError.Kimi || '').includes('no_subscription')
            ? 'The login works — meters need an active Kimi for Coding plan (kimi.com/code).'
            : name === 'Grok Bot'
            ? 'Weekly Grok Bot usage is on the Cursor account. Open Cursor or Grok Bot, then Refresh.'
            : (HOWTO[name] || null) + ' Signing in again usually fixes it.',
      };
    });

  // Honour the order Captain dragged on the page, so the tray icon shows the
  // same order as the site. Anything not in the saved order keeps its natural
  // position after the ones that are.
  let ordered = providers;
  try {
    const orderPath = path.join(ROOT, 'scratch', 'order.json');
    if (fs.existsSync(orderPath)) {
      const want = JSON.parse(fs.readFileSync(orderPath, 'utf8'));
      if (Array.isArray(want) && want.length) {
        const rank = new Map(want.map((n, i) => [String(n).toLowerCase(), i]));
        ordered = providers
          .map((p, i) => ({ p, i }))
          .sort((a, b) => {
            const ra = rank.has(a.p.shortName.toLowerCase())
              ? rank.get(a.p.shortName.toLowerCase())
              : 900 + a.i;
            const rb = rank.has(b.p.shortName.toLowerCase())
              ? rank.get(b.p.shortName.toLowerCase())
              : 900 + b.i;
            return ra - rb;
          })
          .map((x) => x.p);
      }
    }
  } catch {}

  // Providers unchecked under "Shown on the board" — kept in the data file so
  // Connect can still offer them, but listed here so the tray (and anyone else
  // reading the snapshot) can skip them the same way the web board does.
  let hidden = [];
  try {
    const hiddenPath = path.join(ROOT, 'scratch', 'hidden.json');
    if (fs.existsSync(hiddenPath)) {
      const raw = JSON.parse(fs.readFileSync(hiddenPath, 'utf8'));
      if (Array.isArray(raw)) {
        hidden = raw.filter((n) => typeof n === 'string').map(String).slice(0, 24);
      }
    }
  } catch {}

  const data = {
    generatedAt: new Date().toISOString(),
    providers: ordered,
    connections,
    missing,
    hidden,
  };

  writeSnapshot(data);

  // Phone board on riahstudio.com/usage — best-effort push, never fails the collect.
  // push-phone.js is an optional local extra, so most copies of the desk simply
  // do not have it. Require it only when it is there: an unconditional require
  // printed "Cannot find module './push-phone'" plus a require stack as the very
  // first thing every other user saw on first run. A feature you don't have is
  // not an error. A feature you do have that breaks still gets reported below.
  if (fs.existsSync(path.join(ROOT, 'push-phone.js'))) {
    try {
      const { pushOnce } = require('./push-phone');
      await pushOnce().then((result) => {
        if (result && result.skipped) return;
        if (result && result.ok) {
          console.log(`Phone board updated (${result.providers || '?'} providers).`);
        } else if (result) {
          console.warn('Phone board push failed:', result.status || '', result.body || result.reason || '');
        }
      });
    } catch (e) {
      console.warn('Phone board push error:', e && e.message ? e.message : e);
    }
  }

  for (const p of providers) {
    const bits = p.meters
      .map((m) => `${m.label} ${m.usedPercent}%`)
      .join(' · ');
    const planBit = p.plan
      ? ` [${p.plan}${p.price ? ` · ${p.price}` : ''}]`
      : '';
    // A provider that came back with no meters used to print a bare "Gemini: "
    // — a dangling colon reads as broken. Say what it's actually waiting for.
    // A kept-back card says why, so the log shows which read missed.
    const keptBit = p.stale ? ` (last reading kept: ${lastError[p.shortName] || 'no answer'})` : '';
    console.log(
      `${p.shortName}${planBit}: ${bits || p.reconnectHint || p.staleReason || 'no meters yet'}${keptBit}`
    );
  }
  const offline = connections.filter((c) => !c.connected).map((c) => c.id);
  if (offline.length) console.log('Not connected:', offline.join(', '));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
