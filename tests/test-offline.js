#!/usr/bin/env node
/**
 * No internet (2026-10-21): after a wake the PC had no DNS for 20 minutes.
 * Every collect then waited out each vendor's timeout and the board said Live
 * over old numbers. Pin the offline path: one quick DNS check, no vendor
 * reads, every card kept and marked old, `offline: true` in the snapshot.
 *
 * Runs collect-usage.js from a temp copy with DNS stubbed to fail, so it
 * never touches the real snapshot or the network.
 *
 * Run:  node tests/test-offline.js
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'riah-usage-offline-'));
fs.mkdirSync(path.join(tmp, 'lib'));
fs.copyFileSync(path.join(ROOT, 'collect-usage.js'), path.join(tmp, 'collect-usage.js'));
for (const f of fs.readdirSync(path.join(ROOT, 'lib'))) {
  if (f.endsWith('.js')) fs.copyFileSync(path.join(ROOT, 'lib', f), path.join(tmp, 'lib', f));
}
const noDns = path.join(tmp, 'no-dns.js');
fs.writeFileSync(
  noDns,
  "require('dns').lookup = (host, opts, cb) => (typeof opts === 'function' ? opts : cb)(" +
    "Object.assign(new Error('getaddrinfo ENOTFOUND ' + host), { code: 'ENOTFOUND' }));\n"
);

const readAt = '2026-10-21T00:55:00.000Z';
function seed() {
  const snap = {
    generatedAt: readAt,
    providers: [
      { shortName: 'Claude', plan: 'Max 5×', meters: [{ label: '5-hour', usedPercent: 29 }], status: 'live', readAt, stale: false },
      { shortName: 'Grok', meters: [] },
    ],
    connections: [{ id: 'Claude', connected: true }],
    missing: [],
    hidden: [],
  };
  fs.writeFileSync(path.join(tmp, 'usage-data.js'), 'window.USAGE_DATA = ' + JSON.stringify(snap) + ';\n');
}
function run(args) {
  seed();
  const t0 = Date.now();
  const r = spawnSync(process.execPath, ['-r', noDns, path.join(tmp, 'collect-usage.js'), ...args], {
    cwd: tmp,
    encoding: 'utf8',
    timeout: 20000,
    windowsHide: true,
  });
  const raw = fs.readFileSync(path.join(tmp, 'usage-data.js'), 'utf8');
  return { r, ms: Date.now() - t0, data: JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)) };
}

for (const args of [[], ['--claude-only']]) {
  const label = args.length ? 'claude-only' : 'full';
  console.log(`\nNo internet — ${label} collect`);
  const { r, ms, data } = run(args);
  const claude = data.providers.find((p) => p.shortName === 'Claude');
  check('exits cleanly', r.status === 0, r.stderr || String(r.error || ''));
  check('fast: no vendor reads were waited out', ms < 10000, ms + 'ms');
  check('snapshot says offline', data.offline === true);
  check('generatedAt moved on (this was a fresh look)', data.generatedAt !== readAt);
  check('Claude kept its last numbers', claude && claude.meters[0].usedPercent === 29);
  check('Claude marked old, with when', claude && claude.stale === true && claude.readAt === readAt);
  check(
    'reason is plain and offers no re-sign-in',
    claude && /no internet/i.test(claude.staleReason || '') && !claude.fix,
    JSON.stringify(claude && { staleReason: claude.staleReason, fix: claude.fix })
  );
  check('cards without meters are kept as they were', data.providers.some((p) => p.shortName === 'Grok'));
}

console.log('\nWiring');
const collect = fs.readFileSync(path.join(ROOT, 'collect-usage.js'), 'utf8');
const serve = fs.readFileSync(path.join(ROOT, 'serve.js'), 'utf8');
const app = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
check('claude-only clears offline once the internet answers', /offline:\s*undefined/.test(collect));
check('desk looks again quickly while offline', serve.includes('OFFLINE_RETRY_MS') && serve.includes('snapshotOffline()'));
check('Refresh mid-read waits for that read', /if \(collectRun\) return collectRun;/.test(serve));
check('board says No internet', app.includes("'No internet'") && app.includes('data.offline'));

fs.rmSync(tmp, { recursive: true, force: true });

if (failures) {
  console.log(`\n${failures} failed`);
  process.exit(1);
}
console.log('\nall ok');
