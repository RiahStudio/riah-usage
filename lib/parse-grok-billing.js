'use strict';

/**
 * Turn Grok CLI billing JSON into desk meters.
 *
 * SuperGrok unified billing (proto3 JSON) omits zero scalars. After a weekly
 * reset, `creditUsagePercent` and `productUsage` disappear even though the
 * pull succeeded — that means 0% used, not "no data". Treating omit as failure
 * left the previous week's number on the board until usage went above 0 again.
 */

function grokPeriodLabel(period) {
  const t = String((period && period.type) || '').toUpperCase();
  if (t.includes('WEEK')) return 'Weekly';
  if (t.includes('MONTH')) return 'Monthly';
  if (t.includes('DAY')) return 'Daily';
  return 'Usage';
}

function tidyProductLabel(raw) {
  const s = String(raw || 'Product');
  if (/build/i.test(s)) return 'Build';
  if (/^api$/i.test(s)) return 'API';
  return s;
}

function parseGrokBilling(creditsJson, billJson) {
  const cfg = (creditsJson && (creditsJson.config || creditsJson)) || {};
  const bill = (billJson && (billJson.config || billJson)) || {};
  const meters = [];
  const period = cfg.currentPeriod || bill.currentPeriod || null;
  const unified =
    cfg.isUnifiedBillingUser === true || bill.isUnifiedBillingUser === true;
  const resetsAt =
    (period && period.end) ||
    cfg.billingPeriodEnd ||
    bill.billingPeriodEnd ||
    null;

  if (cfg.creditUsagePercent != null && cfg.creditUsagePercent !== '') {
    const label =
      grokPeriodLabel(period) === 'Usage' ? 'Weekly' : grokPeriodLabel(period);
    meters.push({
      label,
      usedPercent: Number(cfg.creditUsagePercent),
      resetsAt,
    });
  } else if (unified && period) {
    meters.push({
      label: grokPeriodLabel(period),
      usedPercent: 0,
      resetsAt,
    });
  }

  for (const p of cfg.productUsage || []) {
    if (p.usagePercent == null) continue;
    meters.push({
      label: tidyProductLabel(p.product),
      usedPercent: p.usagePercent,
      resetsAt: null,
    });
  }

  if (!meters.length && bill) {
    const limitRaw = bill.monthlyLimit?.val ?? bill.monthlyLimit;
    const usedRaw = bill.used?.val ?? bill.used;
    const limit = limitRaw != null ? Number(limitRaw) : NaN;
    const used = usedRaw != null ? Number(usedRaw) : NaN;
    if (Number.isFinite(limit) && limit > 0 && Number.isFinite(used)) {
      meters.push({
        label: 'Monthly',
        usedPercent: (used / limit) * 100,
        resetsAt: bill.billingPeriodEnd || null,
      });
    }
  }

  return meters;
}

module.exports = { parseGrokBilling, grokPeriodLabel };
