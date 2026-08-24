#!/usr/bin/env node
/**
 * Pin Heavy / Ultra labels so the board does not keep saying SuperGrok $30
 * after an upgrade, or miss Cursor Ultra at $0/$200.
 *
 * Run: node tests/test-plan-labels.js
 */
'use strict';

const { prettyPlan, planPrice, inferGrokPlan } = require('../lib/plan-labels');

let failures = 0;
function check(name, pass, detail) {
  if (pass) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`);
  }
}

console.log('\nPlan labels');

check(
  'Cursor Ultra pretty + list price',
  prettyPlan('ultra', 'Cursor') === 'Ultra' && planPrice('Cursor', 'Ultra') === '$200/mo'
);
check(
  'Cursor Ultra live $0 grant beats list price',
  planPrice('Cursor', 'Ultra', '$0') === '$0/mo' || planPrice('Cursor', 'Ultra', '0') === '0/mo'
);
check(
  'Cursor Pro+ still $60',
  prettyPlan('pro_plus', 'Cursor') === 'Pro+' && planPrice('Cursor', 'Pro+') === '$60/mo'
);
check(
  'Grok Heavy pretty + list price',
  prettyPlan('supergrok_heavy', 'Grok') === 'Heavy' &&
    planPrice('Grok', 'Heavy') === '$300/mo' &&
    planPrice('Grok', 'SuperGrok Heavy') === '$300/mo'
);
check(
  'Grok Plus does not collapse to SuperGrok $30',
  prettyPlan('SuperGrok Plus', 'Grok') === 'SuperGrok Plus' &&
    planPrice('Grok', 'SuperGrok Plus') === '$100/mo'
);
check(
  'infer Heavy from named tier even when monthlyLimit is 0',
  inferGrokPlan({ hasGrokCodeAccess: true, planName: 'SuperGrok Heavy' }, { monthlyLimit: { val: 0 } }) ===
    'Heavy'
);
check(
  'infer Heavy from monthlyLimit >= 100000',
  inferGrokPlan({ hasGrokCodeAccess: true }, { monthlyLimit: { val: 100000 } }) === 'Heavy'
);
check(
  'infer SuperGrok when code access and no Heavy signal',
  inferGrokPlan({ hasGrokCodeAccess: true }, { monthlyLimit: { val: 0 } }) === 'SuperGrok'
);
check(
  'local override labels Heavy when xAI omits the tier',
  inferGrokPlan({ hasGrokCodeAccess: true }, { monthlyLimit: { val: 0 } }, { override: 'Heavy' }) ===
    'Heavy' &&
    inferGrokPlan({ hasGrokCodeAccess: true }, { monthlyLimit: { val: 0 } }, { override: 'SuperGrok Heavy' }) ===
      'Heavy'
);
check(
  'named Plus still beats a Heavy override',
  inferGrokPlan(
    { hasGrokCodeAccess: true, planName: 'SuperGrok Plus' },
    { monthlyLimit: { val: 0 } },
    { override: 'SuperGrok Heavy' }
  ) === 'SuperGrok Plus'
);

if (failures) {
  console.log(`\n${failures} failed`);
  process.exit(1);
}
console.log('\nall ok');
