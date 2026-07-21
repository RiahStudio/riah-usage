/**
 * Bookmarklet target — run on gemini.google.com/usage while the desk is live.
 * Posts Current usage + Weekly limit to the local Riah Usage desk.
 * Never sends cookies or tokens — only plan label + percentages + reset times.
 */
(function () {
  var DESK = 'http://127.0.0.1:8775/api/gemini-usage';

  function planFromPage(text) {
    var plusBadge = Array.prototype.some.call(document.querySelectorAll('*'), function (el) {
      return el.children.length === 0 && /^\s*PLUS\s*$/i.test(el.textContent || '');
    });
    if (plusBadge) return 'Plus';
    var proBadge = Array.prototype.some.call(document.querySelectorAll('*'), function (el) {
      return el.children.length === 0 && /^\s*PRO\s*$/i.test(el.textContent || '');
    });
    if (proBadge) return 'Pro';
    var ultraBadge = Array.prototype.some.call(document.querySelectorAll('*'), function (el) {
      return el.children.length === 0 && /^\s*ULTRA\s*$/i.test(el.textContent || '');
    });
    if (ultraBadge) return 'Ultra';
    if (/Get 2x more usage with AI Plus|Get Google AI Plus/.test(text)) return 'Free';
    return null;
  }

  function metersFromDom(text) {
    var current = (text.match(/Current usage[\s\S]*?(\d+)% used/) || [])[1];
    var all = [];
    var re = /(\d+)% used/g;
    var m;
    while ((m = re.exec(text))) all.push(Number(m[1]));
    var weekly = all.length > 1 ? all[1] : all[0];
    var currentReset = (text.match(/Current usage[\s\S]*?Resets ([^\n]+)/) || [])[1];
    var weeklyReset = (text.match(/Weekly limit[\s\S]*?Resets ([^\n]+)/) || [])[1];
    if (current == null && weekly == null) return null;
    return [
      {
        label: 'Current usage',
        usedPercent: current == null ? 0 : Number(current),
        resetsAt: null,
        resetLabel: currentReset || null,
      },
      {
        label: 'Weekly limit',
        usedPercent: weekly == null ? 0 : Number(weekly),
        resetsAt: null,
        resetLabel: weeklyReset || null,
      },
    ];
  }

  function parseRpc(text) {
    var m = text.match(/\[\["wrb\.fr","VxUbXb","((?:\\.|[^"\\])*)"/);
    if (!m) return null;
    try {
      return JSON.parse(JSON.parse('"' + m[1] + '"'));
    } catch (e) {
      return null;
    }
  }

  function metersFromRpc(payload) {
    if (!payload || !Array.isArray(payload[2])) return { meters: null, planCode: null };
    var meters = [];
    payload[2].forEach(function (b) {
      if (!Array.isArray(b)) return;
      var win = b[0];
      var ts = b[1];
      var rem = null;
      for (var i = b.length - 1; i >= 0; i--) {
        if (Array.isArray(b[i]) && typeof b[i][0] === 'number') {
          rem = b[i][0];
          break;
        }
      }
      if (rem == null) return;
      var used = Math.round(Math.max(0, Math.min(100, (1 - rem) * 100)));
      var resetsAt = null;
      if (Array.isArray(ts) && ts[0]) {
        var ms = ts[0] * 1000 + (ts[1] || 0) / 1e6;
        resetsAt = new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
      }
      meters.push({
        label: win === 5 ? 'Current usage' : win === 27 ? 'Weekly limit' : 'Limit ' + win,
        usedPercent: used,
        resetsAt: resetsAt,
      });
    });
    return { meters: meters, planCode: payload[3] };
  }

  function planFromCode(code) {
    if (code === 0) return 'Free';
    if (code === 1) return 'Plus';
    if (code === 2) return 'Pro';
    if (code === 3 || code === 4) return 'Ultra';
    return null;
  }

  async function run() {
    if (!/gemini\.google\.com/i.test(location.hostname)) {
      alert('Open gemini.google.com/usage first, then run Sync again.');
      return;
    }
    var pageText = document.body ? document.body.innerText : '';
    var plan = planFromPage(pageText);
    var meters = null;

    try {
      var html = document.documentElement.innerHTML;
      var at = (html.match(/"SNlM0e":"([^"]+)"/) || [])[1];
      var bl =
        (html.match(/boq_assistant-bard-web-server_[^"\\]+/) || [])[0] ||
        'boq_assistant-bard-web-server_20260715.16_p0';
      var sid = (html.match(/"FdrFJe":"([^"]+)"/) || [])[1];
      if (at) {
        var body = new URLSearchParams();
        body.set('at', at);
        body.set('f.req', JSON.stringify([[['VxUbXb', '[]', null, 'generic']]]));
        var url =
          'https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=VxUbXb&source-path=%2Fusage&bl=' +
          encodeURIComponent(bl) +
          '&hl=en&_reqid=' +
          (Date.now() % 10000000) +
          '&rt=c';
        if (sid) url += '&f.sid=' + encodeURIComponent(sid);
        var r = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
          body: body,
          credentials: 'include',
        });
        var text = await r.text();
        var parsed = metersFromRpc(parseRpc(text));
        if (parsed.meters && parsed.meters.length) meters = parsed.meters;
        if (!plan) plan = planFromCode(parsed.planCode);
      }
    } catch (e) {}

    if (!meters) meters = metersFromDom(pageText);
    if (!meters || !meters.length) {
      alert('Could not read Gemini usage on this page. Make sure you’re on gemini.google.com/usage.');
      return;
    }

    var payload = {
      ok: true,
      plan: plan,
      meters: meters.map(function (m) {
        return {
          label: m.label,
          usedPercent: m.usedPercent,
          resetsAt: m.resetsAt || null,
        };
      }),
      source: 'page-sync',
      href: 'https://gemini.google.com/usage',
    };

    try {
      var res = await fetch(DESK, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      var j = await res.json();
      if (!j || !j.ok) throw new Error((j && j.error) || 'desk_error');
      alert('Synced to Riah Usage. You can switch back to the desk.');
    } catch (e) {
      alert(
        'Could not reach Riah Usage on this computer. Keep the desk window running (http://127.0.0.1:8775), then try Sync again.'
      );
    }
  }

  run();
})();
