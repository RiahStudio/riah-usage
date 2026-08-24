#!/usr/bin/env node
/**
 * Pin Grok unified-billing parsing so a weekly reset cannot freeze last week's %.
 *
 * Run:  node tests/test-grok-billing.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { parseGrokBilling } = require('../lib/parse-grok-billing');

let failures = 0;
function check(name, pass, detail) {
  if (pass) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`);
  }
}

console.log('\nGrok billing parse');

const resetOmit = parseGrokBilling(
  {
    config: {
      currentPeriod: {
        type: 'USAGE_PERIOD_TYPE_WEEKLY',
        start: '2026-08-18T15:22:05.528873+00:00',
        end: '2026-08-25T15:22:05.528873+00:00',
      },
      onDemandCap: { val: 0 },
      onDemandUsed: { val: 0 },
      isUnifiedBillingUser: true,
      prepaidBalance: { val: 0 },
    },
  },
  {
    config: {
      monthlyLimit: { val: 0 },
      used: { val: 148 },
      billingPeriodEnd: '2026-09-01T00:00:00+00:00',
    },
  }
);
check(
  'omitted percent after weekly reset is 0%, not empty',
  resetOmit.length === 1 &&
    resetOmit[0].label === 'Weekly' &&
    resetOmit[0].usedPercent === 0,
  JSON.stringify(resetOmit)
);
check(
  'reset date rides on the weekly meter',
  resetOmit[0] && resetOmit[0].resetsAt === '2026-08-25T15:22:05.528873+00:00'
);
check(
  'monthlyLimit 0 does not invent a monthly percent',
  !resetOmit.some((m) => m.label === 'Monthly')
);

const classic = parseGrokBilling(
  {
    config: {
      creditUsagePercent: 42.4,
      currentPeriod: {
        type: 'USAGE_PERIOD_TYPE_WEEKLY',
        end: '2026-08-18T15:22:05.528873+00:00',
      },
      isUnifiedBillingUser: true,
      productUsage: [
        { product: 'GrokBuild', usagePercent: 37 },
        { product: 'GrokImagine', usagePercent: 4 },
        { product: 'GrokChat', usagePercent: 1 },
      ],
    },
  },
  null
);
check(
  'classic credits payload still yields weekly + product splits',
  classic.length === 4 &&
    classic[0].label === 'Weekly' &&
    classic[0].usedPercent === 42.4 &&
    classic[1].label === 'Build' &&
    classic[1].usedPercent === 37,
  JSON.stringify(classic)
);

const explicitZero = parseGrokBilling(
  {
    config: {
      creditUsagePercent: 0,
      currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', end: '2026-08-25T00:00:00Z' },
      isUnifiedBillingUser: true,
    },
  },
  null
);
check(
  'explicit 0% still counts as a weekly meter',
  explicitZero.length === 1 && explicitZero[0].usedPercent === 0
);

const monthly = parseGrokBilling(
  { config: {} },
  {
    config: {
      monthlyLimit: { val: 1000 },
      used: { val: 250 },
      billingPeriodEnd: '2026-09-01T00:00:00Z',
    },
  }
);
check(
  'legacy monthly used/limit still works when there is no weekly period',
  monthly.length === 1 && monthly[0].label === 'Monthly' && monthly[0].usedPercent === 25,
  JSON.stringify(monthly)
);

const collect = fs.readFileSync(path.join(__dirname, '..', 'collect-usage.js'), 'utf8');
check(
  'collector uses the shared Grok parser',
  collect.includes('./lib/parse-grok-billing') &&
    collect.includes('parseGrokBilling')
);

if (failures) {
  console.log(`\n${failures} failed`);
  process.exit(1);
}
console.log('\nall ok');
