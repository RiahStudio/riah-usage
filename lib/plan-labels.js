'use strict';

/**
 * Plan names and list prices for the usage board.
 * Live API price wins when present (so a $0 Ultra grant from SuperGrok Heavy
 * shows as $0, not $200).
 */

function prettyPlan(raw, providerName) {
  if (raw == null || raw === '') return null;
  const s = String(raw).trim();
  const low = s.toLowerCase().replace(/[_-]+/g, ' ');
  if (providerName === 'Codex' || providerName === 'ChatGPT') {
    if (low === 'plus') return 'Plus';
    if (low === 'pro') return 'Pro';
    if (low === 'free' || low === 'freeplan') return 'Free';
    if (low === 'team' || low === 'enterprise') return s.charAt(0).toUpperCase() + s.slice(1);
  }
  if (providerName === 'Cursor') {
    if (low === 'ultra') return 'Ultra';
    if (low === 'pro') return 'Pro';
    if (low === 'pro plus' || low === 'pro_plus' || low === 'proplus') return 'Pro+';
    if (low === 'business' || low === 'team') return s.charAt(0).toUpperCase() + low.slice(1);
    if (low === 'free' || low === 'hobby') return 'Free';
  }
  if (providerName === 'Grok') {
    // Board label is Heavy, not SuperGrok Heavy.
    if (low.includes('heavy')) return 'Heavy';
    if (low.includes('plus')) return 'SuperGrok Plus';
    if (low.includes('lite')) return 'SuperGrok Lite';
    if (low.includes('super')) return 'SuperGrok';
    if (low === 'free') return 'Free';
  }
  if (providerName === 'Gemini') {
    // Google returns the full product line ("Gemini Code Assist for
    // individuals") — that blows out the tray. Keep the short product name.
    if (low.includes('code assist')) return 'Code Assist';
    if (low.includes('ultra') || low.includes('ai ultra')) return 'Ultra';
    if (low.includes('ai pro') || low === 'pro' || low === 'standard') return 'Pro';
    if (low.includes('ai plus') || low === 'plus') return 'Plus';
    if (low === 'free' || low.includes('free')) return 'Free';
  }
  // Claude Max 20× already pretty from Python; pass through
  if (/^max\s+\d+×$/i.test(s) || /^max\s+\d+x$/i.test(s)) {
    return s.replace(/x$/i, '×');
  }
  // Title-case short tokens
  if (s.length <= 24 && !/\s/.test(s)) {
    return s.charAt(0).toUpperCase() + s.slice(1);
  }
  return s;
}

function planPrice(providerName, planName, livePrice) {
  if (livePrice) {
    const n = String(livePrice).trim();
    if (/^\$?\d/.test(n)) return n.includes('/') ? n : `${n.replace(/\s*\/mo$/i, '')}/mo`;
  }
  if (!planName) return null;
  const p = String(planName).toLowerCase();
  const table = {
    Claude: [
      [/max\s*20/, '$200/mo'],
      [/max\s*5/, '$100/mo'],
      [/^max$/, '$100/mo'],
      [/^pro$/, '$20/mo'],
      [/^free$/, '$0'],
    ],
    Cursor: [
      [/ultra/, '$200/mo'],
      [/pro\+/, '$60/mo'],
      [/^pro$/, '$20/mo'],
      [/business|team/, null],
      [/^free$|^hobby$/, '$0'],
    ],
    Codex: [
      [/^plus$/, '$20/mo'],
      [/^pro$/, '$20/mo'],
      [/^free$/, '$0'],
      [/team|enterprise/, null],
    ],
    Grok: [
      [/heavy/, '$300/mo'],
      [/plus/, '$100/mo'],
      [/lite/, '$10/mo'],
      [/super/, '$30/mo'],
      [/^free$/, '$0'],
      [/^paid$/, null],
    ],
    Gemini: [
      [/^free$/, '$0'],
      [/^plus$|ai plus/, '$10/mo'],
      [/^pro$|^standard$|ai pro/, '$20/mo'],
      [/ultra|ai ultra/, '$250/mo'],
    ],
    Copilot: [
      [/^free$/, '$0'],
      [/^pro\+$/, '$39/mo'],
      [/^pro$/, '$10/mo'],
      [/business|enterprise/, null],
    ],
  };
  const rows = table[providerName] || [];
  for (const [re, price] of rows) {
    if (re.test(p)) return price;
  }
  return null;
}

function planHints(obj, into) {
  const out = into || [];
  if (!obj || typeof obj !== 'object') return out;
  for (const [k, v] of Object.entries(obj)) {
    if (/plan|tier|subscr|product|sku|offer/i.test(k) && typeof v === 'string' && v.trim()) {
      out.push(v);
    } else if (Array.isArray(v)) {
      for (const item of v) {
        if (typeof item === 'string' && item.trim()) out.push(item);
        else if (item && typeof item === 'object') planHints(item, out);
      }
    } else if (v && typeof v === 'object') {
      planHints(v, out);
    }
  }
  return out;
}

function inferGrokPlan(user, billCfg, extra) {
  extra = extra || {};
  const named = planHints(user)
    .concat(planHints(billCfg))
    .concat(planHints(extra.credits || extra.creditsCfg))
    .concat(String(extra.products || ''))
    .join(' ');
  if (/heavy/i.test(named)) return 'Heavy';
  if (/plus/i.test(named) && /super|grok/i.test(named)) return 'SuperGrok Plus';
  if (/lite/i.test(named) && /super|grok/i.test(named)) return 'SuperGrok Lite';
  const monthly = billCfg?.monthlyLimit?.val ?? billCfg?.monthlyLimit ?? null;
  // Do not guess Heavy from a quota number — that was one account's shape.
  // Named tier from the API, or a local pin on that machine.
  if (extra.override) {
    const pinned = prettyPlan(extra.override, 'Grok') || String(extra.override).trim();
    if (pinned) return pinned;
  }
  if (user?.hasGrokCodeAccess) return 'SuperGrok';
  if (monthly != null && Number(monthly) > 0) return 'Paid';
  return 'Free';
}

module.exports = {
  prettyPlan,
  prettyPlan: prettyPlan,
  planPrice,
  inferGrokPlan,
  inferGrokPlan: inferGrokPlan,
};
