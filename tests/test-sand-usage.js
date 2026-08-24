#!/usr/bin/env node
/**
 * Pin Grok Bot weekly parsing from Cursor GetSandUsageStatus JSON.
 *
 * Run:  node tests/test-sand-usage.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { parseSandWeeklyUsage, protoTime } = require('../lib/parse-sand-usage');

let failures = 0;
function check(name, pass, detail) {
  if (pass) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`);
  }
}

console.log('\nGrok Bot sand usage parse');

const live = parseSandWeeklyUsage({
  usagePercent: 37,
  nextResetTimestampUtc: '2026-08-31T00:00:00.000Z',
});
check(
  'camelCase percent + reset',
  live.length === 1 &&
    live[0].label === 'Weekly' &&
    live[0].usedPercent === 37 &&
    live[0].resetsAt === '2026-08-31T00:00:00.000Z',
  JSON.stringify(live)
);

const snake = parseSandWeeklyUsage({
  usage_percent: 12,
  next_reset_timestamp_utc: 1782777600,
});
check(
  'snake_case percent + unix seconds reset',
  snake.length === 1 &&
    snake[0].usedPercent === 12 &&
    protoTime(1782777600) === snake[0].resetsAt,
  JSON.stringify(snake)
);

check(
  'nested usageStatus unwrap',
  parseSandWeeklyUsage({ usageStatus: { usagePercent: 8 } })[0]?.usedPercent === 8
);

check(
  'zero percent is live, not empty',
  parseSandWeeklyUsage({ usagePercent: 0 }).length === 1 &&
    parseSandWeeklyUsage({ usagePercent: 0 })[0].usedPercent === 0
);

check(
  'pooled enterprise is omitted',
  parseSandWeeklyUsage({
    usagePercent: 50,
    usesPooledEnterpriseAllowance: true,
  }).length === 0
);

check(
  'included limit zero is omitted',
  parseSandWeeklyUsage({
    usagePercent: 50,
    includedLimitZero: true,
  }).length === 0
);

check(
  'missing percent is omitted',
  parseSandWeeklyUsage({ nextResetTimestampUtc: '2026-08-31T00:00:00.000Z' }).length === 0
);

check(
  'fraction 0.4 stays 0.4 (do not *100 a live 0–100 field)',
  parseSandWeeklyUsage({ usagePercent: 0.4 })[0]?.usedPercent === 0.4
);

const collect = fs.readFileSync(path.join(__dirname, '..', 'collect-usage.js'), 'utf8');
const pull = fs.readFileSync(path.join(__dirname, '..', 'lib', 'pull-cursor.py'), 'utf8');
check(
  'collector uses the shared sand parser',
  collect.includes('./lib/parse-sand-usage') &&
    collect.includes('parseSandWeeklyUsage') &&
    collect.includes('Grok Bot')
);
check(
  'cursor pull asks for sand usage',
  pull.includes('GetSandUsageStatus') &&
    pull.includes('sand_usage') &&
    pull.includes('DashboardService/GetSandUsageStatus')
);

if (failures) {
  console.log(`\n${failures} failed`);
  process.exit(1);
}
console.log('\nall ok');
