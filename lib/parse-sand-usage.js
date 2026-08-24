'use strict';

/**
 * Grok Bot weekly usage from Cursor's GetSandUsageStatus JSON.
 * Metered on the Cursor account, not grok.com / Grok Build.
 */

function protoTime(raw) {
  if (raw == null || raw === '') return null;
  if (typeof raw === 'object') {
    const sec = raw.seconds ?? raw.Seconds;
    if (sec != null) {
      const n = Number(sec);
      if (Number.isFinite(n) && n > 0) return new Date(n * 1000).toISOString();
    }
    const ms = raw.ms ?? raw.millis ?? raw.value;
    if (ms != null) return protoTime(ms);
  }
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) {
    const ms = n < 1e12 ? n * 1000 : n;
    const d = new Date(ms);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function asPercent(raw) {
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

function unwrapSand(sandJson) {
  if (!sandJson || typeof sandJson !== 'object') return null;
  if (sandJson.usagePercent != null || sandJson.usage_percent != null) return sandJson;
  return (
    sandJson.usageStatus ||
    sandJson.sandUsageStatus ||
    sandJson.status ||
    sandJson.config ||
    sandJson
  );
}

function parseSandWeeklyUsage(sandJson) {
  const s = unwrapSand(sandJson);
  if (!s || typeof s !== 'object') return [];
  if (s.usesPooledEnterpriseAllowance === true || s.uses_pooled_enterprise_allowance === true) {
    return [];
  }
  if (s.includedLimitZero === true || s.included_limit_zero === true) {
    return [];
  }
  const used = asPercent(s.usagePercent ?? s.usage_percent);
  if (used == null) return [];
  const resetsAt = protoTime(s.nextResetTimestampUtc ?? s.next_reset_timestamp_utc);
  return [
    {
      label: 'Weekly',
      usedPercent: used,
      resetsAt,
    },
  ];
}

module.exports = { parseSandWeeklyUsage, protoTime, asPercent };
