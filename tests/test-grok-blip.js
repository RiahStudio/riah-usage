#!/usr/bin/env node
/**
 * One dropped request (2026-10-21): Grok's read missed once and the collector
 * wrote an empty reconnect card as if it were a fresh reading, so Grok fell
 * off the board, and the miss also refreshed (rotated) the Grok CLI's token.
 * Pin it: a dropped read is tried once more, a miss keeps the last reading
 * marked old, and only a refused token (401/403) refreshes the sign-in.
 *
 * Runs collect-usage.js from a temp copy with a fake home and https stubbed,
 * so it never touches the real snapshot, the real login, or the network.
 *
 * Run:  node tests/test-grok-blip.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

let failures = 0;
function check(name, pass, detail) {
  if (pass) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`);
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'riah-usage-grok-blip-'));
fs.mkdirSync(path.join(tmp, 'lib'));
fs.copyFileSync(path.join(ROOT, 'collect-usage.js'), path.join(tmp, 'collect-usage.js'));
for (const f of fs.readdirSync(path.join(ROOT, 'lib'))) {
  if (f.endsWith('.js')) fs.copyFileSync(path.join(ROOT, 'lib', f), path.join(tmp, 'lib', f));
}

const home = path.join(tmp, 'home');
fs.mkdirSync(path.join(home, '.grok'), { recursive: true });
fs.writeFileSync(
  path.join(home, '.grok', 'auth.json'),
  JSON.stringify({
    test: {
      key: 'fake-key',
      refresh_token: 'fake-refresh',
      oidc_issuer: 'https://auth.example.test',
      oidc_client_id: 'fake-client',
    },
  })
);

// DNS answers (so the collect is "online"); every https call is logged, and
// answered per GROK_STUB: "drop" resets the connection, "401" refuses the
// token and lets the refresh fail.
const stub = path.join(tmp, 'stub-net.js');
const log = path.join(tmp, 'requests.log');
fs.writeFileSync(
  stub,
  `
const { EventEmitter } = require('events');
const fs = require('fs');
require('dns').lookup = (host, opts, cb) => (typeof opts === 'function' ? opts : cb)(null, '127.0.0.1', 4);
require('https').request = (o, cb) => {
  const req = new EventEmitter();
  req.write = () => {};
  req.destroy = () => {};
  req.end = () => setImmediate(() => {
    fs.appendFileSync(${JSON.stringify(log)}, (o.method || 'GET') + ' ' + o.hostname + o.path + '\\n');
    const answer = (status, body) => {
      const res = new EventEmitter();
      res.statusCode = status;
      cb(res);
      res.emit('data', Buffer.from(JSON.stringify(body)));
      res.emit('end');
    };
    if (process.env.GROK_STUB === 'drop') {
      return req.emit('error', Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }));
    }
    if (o.hostname === 'auth.example.test' && o.path.includes('openid-configuration')) {
      return answer(200, { token_endpoint: 'https://auth.example.test/token' });
    }
    if (o.hostname === 'auth.example.test') return answer(400, { error: 'invalid_grant' });
    return answer(401, {});
  });
  return req;
};
`
);

const readAt = '2026-10-21T08:48:55.980Z';
function run(mode) {
  const snap = {
    generatedAt: readAt,
    providers: [
      {
        shortName: 'Grok',
        plan: 'Heavy',
        meters: [{ label: 'Weekly', usedPercent: 42, resetsAt: null }],
        status: 'live',
        links: [{ label: 'Open', href: 'https://grok.com/' }],
        readAt,
        stale: false,
      },
    ],
    connections: [],
    missing: [],
    hidden: [],
  };
  fs.writeFileSync(path.join(tmp, 'usage-data.js'), 'window.USAGE_DATA = ' + JSON.stringify(snap) + ';\n');
  fs.rmSync(log, { force: true });
  const r = spawnSync(process.execPath, ['-r', stub, path.join(tmp, 'collect-usage.js')], {
    cwd: tmp,
    encoding: 'utf8',
    timeout: 30000,
    windowsHide: true,
    env: Object.assign({}, process.env, { HOME: home, USERPROFILE: home, GROK_STUB: mode }),
  });
  const raw = fs.readFileSync(path.join(tmp, 'usage-data.js'), 'utf8');
  const data = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
  const requests = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : [];
  return { r, grok: data.providers.find((p) => p.shortName === 'Grok'), requests };
}

console.log('\nGrok read drops (connection reset)');
{
  const { r, grok, requests } = run('drop');
  const grokReads = requests.filter((q) => q.includes('cli-chat-proxy.grok.com'));
  check('exits cleanly', r.status === 0, r.stderr || String(r.error || ''));
  check('each Grok read tried twice', grokReads.length === 6, grokReads.length + ' reads');
  check('no sign-in refresh for a dropped connection', !requests.some((q) => q.includes('auth.example.test')));
  check('Grok card stays on the board', !!grok);
  check('last reading kept', grok && grok.meters.length === 1 && grok.meters[0].usedPercent === 42);
  check('marked old, with when', grok && grok.stale === true && grok.readAt === readAt);
  check('not turned into a reconnect card', grok && grok.status !== 'reconnect', grok && grok.status);
}

console.log('\nGrok refuses the token (401)');
{
  const { r, grok, requests } = run('401');
  const posts = requests.filter((q) => q.startsWith('POST '));
  check('exits cleanly', r.status === 0, r.stderr || String(r.error || ''));
  check('a refused token is not retried as a drop', requests.filter((q) => q.includes('/v1/billing?format=credits')).length === 1);
  check('sign-in refresh tried exactly once', posts.length === 1, posts.join(' | '));
  check('last reading kept', grok && grok.meters.length === 1 && grok.meters[0].usedPercent === 42 && grok.stale === true);
  check('says the sign-in expired, with Re-sign in', grok && /expired/i.test(grok.staleReason || '') && grok.fix && grok.fix.id === 'grok',
    JSON.stringify(grok && { staleReason: grok.staleReason, fix: grok.fix }));
}

console.log('\nWiring');
const serve = fs.readFileSync(path.join(ROOT, 'serve.js'), 'utf8');
check('a card that just missed gets a second look soon', serve.includes('BLIP_RETRY_MS') && serve.includes('snapshotJustDropped()'));

fs.rmSync(tmp, { recursive: true, force: true });

if (failures) {
  console.log(`\n${failures} failed`);
  process.exit(1);
}
console.log('\nall ok');
