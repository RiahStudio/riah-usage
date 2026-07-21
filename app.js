/* Riah Usage — board + connect onboarding */
(function () {
  var ORDER_KEY = 'riah-usage-order';
  var SKIP_KEY = 'riah-usage-setup-skipped';
  var HIDDEN_KEY = 'riah-usage-hidden';
  var WANT_KEY = 'riah-usage-want';
  var WIZARD_KEY = 'riah-usage-wizard';
  var cfg = window.RIAH_USAGE_CONFIG || {};
  var guides = window.RIAH_USAGE_SETUP || [];
  var readyGuides = guides.filter(function (g) {
    return g.ready !== false;
  });
  var isHttp = location.protocol === 'http:' || location.protocol === 'https:';
  var syncPollTimer = null;

  // Escape anything before it goes into innerHTML. Provider names, plans and
  // meter labels all arrive from vendor APIs -- they are not ours, so they are
  // not trusted. A poisoned label would otherwise run as markup inside the
  // desk's own page.
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // Escaping a URL stops it breaking OUT of the attribute, but a
  // `javascript:` or `data:` value would still run when clicked -- escaping
  // alone is not enough for an href. Only allow ordinary web links.
  function safeUrl(u) {
    var s = String(u == null ? '' : u).trim();
    return /^https?:\/\//i.test(s) ? s : '#';
  }

  var coffee = document.getElementById('coffee');
  if (coffee && cfg.buyMeACoffeeUrl) coffee.href = cfg.buyMeACoffeeUrl;
  if (coffee && (!cfg.buyMeACoffeeUrl || /YOUR_HANDLE/i.test(cfg.buyMeACoffeeUrl))) {
    coffee.hidden = true;
  }

  var list = document.getElementById('list');
  var setupEl = document.getElementById('setup');
  var boardEl = document.getElementById('board');
  var lastGeneratedAt = null;
  var dragWired = false;
  var dragEl = null;
  var didDrag = false;
  var setupOpen = false;
  var latestData = window.USAGE_DATA || null;

  function loadHidden() {
    try {
      var arr = JSON.parse(localStorage.getItem(HIDDEN_KEY) || '[]');
      return Array.isArray(arr) ? arr.map(String) : [];
    } catch (e) {
      return [];
    }
  }
  function saveHidden(names) {
    try {
      localStorage.setItem(HIDDEN_KEY, JSON.stringify(names));
    } catch (e) {}
    // Same reason as saveOrder: the tray by the clock cannot read localStorage.
    // Without this POST, unchecking Gemini (or any AI) only hid it on the web
    // board — the hover list kept showing it. (Captain, 2026-07-21.)
    if (isHttp) {
      try {
        fetch('/api/hidden', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(names),
        }).catch(function () {});
      } catch (e) {}
    }
  }
  function isHidden(name) {
    return loadHidden().indexOf(name) !== -1;
  }
  function setHidden(name, hide) {
    if (!name) return;
    var next = loadHidden().filter(function (n) {
      return n !== name;
    });
    if (hide) next.push(name);
    saveHidden(next);
  }

  function setLive(ok) {
    var dot = document.getElementById('live-dot');
    var lab = document.getElementById('live-label');
    if (!dot || !lab) return;
    if (ok) {
      dot.classList.add('on');
      lab.textContent = 'Live';
    } else {
      dot.classList.remove('on');
      lab.textContent = isHttp ? 'Live' : 'Offline';
    }
  }

  function tone(used) {
    if (used >= 85) return 'hot';
    if (used >= 60) return 'warn';
    return 'ok';
  }
  function hottest(meters) {
    var max = 0;
    (meters || []).forEach(function (m) {
      if (m.usedPercent > max) max = m.usedPercent;
    });
    return tone(max);
  }
  function loadOrder() {
    try {
      var arr = JSON.parse(localStorage.getItem(ORDER_KEY) || '[]');
      return Array.isArray(arr) ? arr : [];
    } catch (e) {
      return [];
    }
  }
  /** Merge visible drag order with prior saved names so missing AIs keep their slot. */
  function saveOrder(names) {
    var prev = loadOrder();
    var next = names.slice();
    prev.forEach(function (name) {
      if (next.indexOf(name) === -1) next.push(name);
    });
    try {
      localStorage.setItem(ORDER_KEY, JSON.stringify(next));
    } catch (e) {}
    // Also tell the desk, so the tray icon by the clock shows the same order.
    // localStorage alone lives in ONE browser: the tray could never read it,
    // and the order vanished with the browser profile.
    if (isHttp) {
      try {
        fetch('/api/order', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(next),
        }).catch(function () {});
      } catch (e) {}
    }
  }
  function sortBySaved(rows) {
    var order = loadOrder();
    if (!order.length) return rows.slice();
    var rank = {};
    order.forEach(function (name, i) {
      rank[name] = i;
    });
    return rows.slice().sort(function (a, b) {
      var ra = rank.hasOwnProperty(a.shortName) ? rank[a.shortName] : 1000 + rows.indexOf(a);
      var rb = rank.hasOwnProperty(b.shortName) ? rank[b.shortName] : 1000 + rows.indexOf(b);
      return ra - rb;
    });
  }

  function connectionMap(data) {
    var map = {};
    (data && data.connections ? data.connections : []).forEach(function (c) {
      map[c.id] = !!c.connected;
    });
    // Live meters win; reconnect stubs mean “not usable yet”
    (data && data.providers ? data.providers : []).forEach(function (p) {
      if (!p || !p.shortName) return;
      if (p.status === 'reconnect') map[p.shortName] = false;
      else if ((p.meters || []).length) map[p.shortName] = true;
    });
    return map;
  }

  function connectedCount(data) {
    var map = connectionMap(data);
    return readyGuides.filter(function (g) {
      return map[g.id];
    }).length;
  }

  function loadWant() {
    try {
      var arr = JSON.parse(localStorage.getItem(WANT_KEY) || '[]');
      return Array.isArray(arr) ? arr.map(String) : [];
    } catch (e) {
      return [];
    }
  }
  function saveWant(ids) {
    try {
      localStorage.setItem(WANT_KEY, JSON.stringify(ids));
    } catch (e) {}
  }
  function loadWizard() {
    try {
      return JSON.parse(localStorage.getItem(WIZARD_KEY) || 'null');
    } catch (e) {
      return null;
    }
  }
  function saveWizard(w) {
    try {
      if (!w) localStorage.removeItem(WIZARD_KEY);
      else localStorage.setItem(WIZARD_KEY, JSON.stringify(w));
    } catch (e) {}
  }
  function guideById(id) {
    for (var i = 0; i < guides.length; i++) {
      if (guides[i].id === id) return guides[i];
    }
    return null;
  }

  function shouldAutoOpenSetup(data) {
    if (setupOpen) return true;
    try {
      if (localStorage.getItem(SKIP_KEY) === '1') return false;
    } catch (e) {}
    return connectedCount(data) === 0;
  }

  function showSetup(show) {
    setupOpen = !!show;
    if (!setupEl || !boardEl) return;
    setupEl.hidden = !show;
    boardEl.hidden = !!show;
    var btn = document.getElementById('btn-connect');
    if (btn) btn.textContent = show ? 'Meters' : 'Connect';
  }

  function copyText(text, btn) {
    function done() {
      if (!btn) return;
      var prev = btn.textContent;
      btn.textContent = 'Copied';
      setTimeout(function () {
        btn.textContent = prev;
      }, 1200);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(function () {
        fallback();
      });
    } else {
      fallback();
    }
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
      } catch (e) {}
      document.body.removeChild(ta);
      done();
    }
  }

  function refreshNow(btn, opts) {
    opts = opts || {};
    if (!isHttp) {
      location.reload();
      return Promise.resolve(null);
    }
    if (btn) {
      btn.disabled = true;
      if (!opts.quietLabel) btn.textContent = opts.busyLabel || 'Checking…';
    }
    return fetch('/api/refresh', { method: 'POST' })
      .then(function (r) {
        return r.json();
      })
      .then(function () {
        return fetch('/usage-data.js?t=' + Date.now(), { cache: 'no-store' }).then(function (r) {
          return r.text();
        });
      })
      .then(function (text) {
        var m = text.match(/window\.USAGE_DATA\s*=\s*(\{[\s\S]*\});?\s*$/);
        if (!m) throw new Error('bad data');
        lastGeneratedAt = null;
        var data = JSON.parse(m[1]);
        window.USAGE_DATA = data;
        render(data, true);
        return data;
      })
      .catch(function () {
        setLive(false);
        return null;
      })
      .finally(function () {
        if (btn) {
          btn.disabled = false;
          if (opts.restoreLabel) btn.textContent = opts.restoreLabel;
        }
      });
  }

  function openConnectFor(aiId) {
    showSetup(true);
    var want = loadWant();
    if (aiId && want.indexOf(aiId) === -1) {
      want.push(aiId);
      saveWant(want);
    }
    if (aiId) {
      saveWizard({ phase: 'step', queue: want.length ? want : [aiId], index: Math.max(0, (want.length ? want : [aiId]).indexOf(aiId)) });
    } else if (!loadWizard()) {
      saveWizard({ phase: 'pick', queue: [], index: 0 });
    }
    renderSetup(latestData || { providers: [], connections: [] });
  }

  function clearSyncPoll() {
    if (syncPollTimer) {
      clearInterval(syncPollTimer);
      syncPollTimer = null;
    }
  }

  function advanceWizard(data) {
    var w = loadWizard() || { phase: 'pick', queue: [], index: 0 };
    var next = (w.index || 0) + 1;
    if (next >= (w.queue || []).length) {
      saveWizard({ phase: 'done', queue: w.queue || [], index: next });
    } else {
      saveWizard({ phase: 'step', queue: w.queue, index: next });
    }
    renderSetup(data || latestData || { providers: [], connections: [] });
  }

  function renderSetup(data) {
    if (!setupEl) return;
    clearSyncPoll();
    var map = connectionMap(data);
    var n = connectedCount(data);
    var w = loadWizard();
    if (!w) {
      w = { phase: n > 0 ? 'pick' : 'pick', queue: loadWant(), index: 0 };
      saveWizard(w);
    }

    if (w.phase === 'step' && (!w.queue || !w.queue.length)) {
      w = { phase: 'pick', queue: [], index: 0 };
      saveWizard(w);
    }

    var head =
      '<div class="su-intro">' +
      '<h1>Connect your AIs</h1>' +
      '<p>Pick what you use. We’ll walk through each one — no passwords, no API keys.</p>' +
      '<p class="su-progress">' +
      n +
      ' ready with live meters</p>' +
      '</div>';

    var body = '';
    var actions = '';

    if (w.phase === 'pick') {
      var want = loadWant();
      body +=
        '<p class="su-section">Which AIs do you use?</p>' +
        '<p class="su-shown-hint">Check every AI you use. We’ll walk through each one.</p>' +
        '<div class="su-checks su-pick-grid">';
      guides.forEach(function (g) {
        var soon = g.ready === false;
        var checked = want.indexOf(g.id) !== -1;
        body +=
          '<label class="su-check' +
          (soon ? ' soon' : '') +
          '">' +
          '<input type="checkbox" data-want="' +
          g.id +
          '"' +
          (checked ? ' checked' : '') +
          ' />' +
          '<span>' +
          g.title +
          (soon ? ' <em>Soon</em>' : '') +
          '</span>' +
          '</label>';
      });
      body += '</div>';

      if (n > 0) {
        body +=
          '<div class="su-shown">' +
          '<p class="su-section">Shown on the board</p>' +
          '<p class="su-shown-hint">Uncheck to hide from the board and the tray hover — without disconnecting.</p>' +
          '<div class="su-checks">';
        readyGuides.forEach(function (g) {
          body +=
            '<label class="su-check">' +
            '<input type="checkbox" data-shown="' +
            g.id +
            '"' +
            (!isHidden(g.id) ? ' checked' : '') +
            ' />' +
            '<span>' +
            g.title +
            '</span>' +
            '</label>';
        });
        body += '</div></div>';
      }

      body += missingSection(data);

      actions =
        '<div class="su-actions">' +
        '<button type="button" class="su-primary" id="btn-start-wizard">Continue</button>' +
        (n > 0
          ? '<button type="button" class="su-ghost" id="btn-see-meters">See my meters</button>'
          : '<button type="button" class="su-ghost" id="btn-skip">Skip for now</button>') +
        '</div>';
    } else if (w.phase === 'step') {
      var id = w.queue[w.index];
      var g = guideById(id) || { id: id, title: id, steps: [], ready: false };
      var stepNum = w.index + 1;
      var stepTotal = w.queue.length;
      var ok = !!map[g.id];

      body +=
        '<p class="su-section">Set up ' +
        stepNum +
        ' of ' +
        stepTotal +
        '</p>' +
        '<div class="su-wizard-card' +
        (ok ? ' ok' : '') +
        '">' +
        '<div class="su-wiz-top">' +
        '<span class="su-name">' +
        g.title +
        '</span>' +
        '<span class="su-state">' +
        (ok ? 'Connected' : g.ready === false ? 'Coming soon' : 'Not yet') +
        '</span>' +
        '</div>' +
        '<p class="su-blurb">' +
        (g.blurb || '') +
        '</p>';

      if (g.ready === false) {
        body +=
          '<p class="su-step">We don’t pull meters for this one yet — it’s on the roadmap. Skip to the next, or come back when it ships.</p>';
      } else {
        if (g.installUrl) {
          body +=
            '<a class="su-install" href="' +
            g.installUrl +
            '" target="_blank" rel="noopener">' +
            (g.installLabel || 'Docs') +
            ' ↗</a>';
        }
        (g.steps || []).forEach(function (s) {
          if (s.cmd) {
            body +=
              '<div class="su-cmd">' +
              '<code>' +
              s.cmd +
              '</code>' +
              '<button type="button" class="su-copy" data-copy="' +
              s.cmd.replace(/"/g, '&quot;') +
              '">Copy</button>' +
              '</div>';
          } else {
            body += '<p class="su-step">' + s.text + '</p>';
          }
        });
        if (g.action === 'sync-gemini') {
          body +=
            '<button type="button" class="su-sync" data-sync-gemini="1">' +
            (g.actionLabel || 'Sync Gemini') +
            '</button>' +
            '<p class="su-sync-status" data-sync-status hidden></p>';
        }
      }
      body += '</div>';

      actions = '<div class="su-actions">';
      if (g.ready === false) {
        actions += '<button type="button" class="su-primary" id="btn-wiz-next">Skip</button>';
      } else if (g.action === 'sync-gemini') {
        // Sync (the ink button in the card body) is the primary act on this
        // card — Google closed new individual CLI sign-ins 2026-07-21, so
        // Continue is the quiet path for Workspace / already-signed-in users.
        actions +=
          '<button type="button" class="su-ghost" id="btn-wiz-continue">I use the CLI — Continue</button>' +
          '<button type="button" class="su-ghost" id="btn-wiz-next">Skip for now</button>';
      } else {
        actions +=
          '<button type="button" class="su-primary" id="btn-wiz-continue">I\'m signed in — Continue</button>' +
          '<button type="button" class="su-ghost" id="btn-wiz-next">Skip</button>';
      }
      actions +=
        '<button type="button" class="su-ghost" id="btn-wiz-back">Back to list</button></div>';
    } else {
      body +=
        '<p class="su-section">You’re set</p>' +
        '<p class="su-step">Live meters are on the board. You can come back to Connect anytime to add more.</p>';
      actions =
        '<div class="su-actions">' +
        '<button type="button" class="su-primary" id="btn-see-meters">See my meters</button>' +
        '<button type="button" class="su-ghost" id="btn-wiz-back">Add more</button>' +
        '</div>';
    }

    setupEl.innerHTML = head + body + actions;

    setupEl.querySelectorAll('[data-want]').forEach(function (box) {
      box.addEventListener('change', function () {
        var next = [];
        setupEl.querySelectorAll('[data-want]').forEach(function (b) {
          if (b.checked) next.push(b.getAttribute('data-want'));
        });
        saveWant(next);
      });
    });
    setupEl.querySelectorAll('[data-shown]').forEach(function (box) {
      box.addEventListener('change', function () {
        setHidden(box.getAttribute('data-shown') || '', !box.checked);
        render(latestData || data, true);
        if (setupOpen) renderSetup(latestData || data);
      });
    });
    setupEl.querySelectorAll('[data-copy]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        copyText(btn.getAttribute('data-copy') || '', btn);
      });
    });

    var startW = document.getElementById('btn-start-wizard');
    if (startW) {
      startW.addEventListener('click', function () {
        var next = [];
        setupEl.querySelectorAll('[data-want]').forEach(function (b) {
          if (b.checked) next.push(b.getAttribute('data-want'));
        });
        saveWant(next);
        if (!next.length) {
          startW.textContent = 'Pick at least one';
          setTimeout(function () {
            startW.textContent = 'Continue';
          }, 1400);
          return;
        }
        saveWizard({ phase: 'step', queue: next, index: 0 });
        renderSetup(latestData || data);
      });
    }

    var back = document.getElementById('btn-wiz-back');
    if (back) {
      back.addEventListener('click', function () {
        saveWizard({ phase: 'pick', queue: loadWant(), index: 0 });
        renderSetup(latestData || data);
      });
    }

    var skipOne = document.getElementById('btn-wiz-next');
    if (skipOne) {
      skipOne.addEventListener('click', function () {
        advanceWizard(latestData || data);
      });
    }

    var cont = document.getElementById('btn-wiz-continue');
    if (cont) {
      cont.addEventListener('click', function () {
        var cur = (loadWizard() || {}).queue;
        var idx = (loadWizard() || {}).index || 0;
        var curId = cur && cur[idx];
        var wasLabel = cont.textContent;
        cont.textContent = 'Checking…';
        refreshNow(cont, { quietLabel: true, restoreLabel: wasLabel }).then(
          function (fresh) {
            var ok = fresh && connectionMap(fresh)[curId];
            if (ok) advanceWizard(fresh);
            else {
              cont.textContent = 'Not seeing it yet — try again';
              setTimeout(function () {
                cont.textContent = wasLabel;
              }, 1800);
            }
          }
        );
      });
    }

    setupEl.querySelectorAll('[data-sync-gemini]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var status = setupEl.querySelector('[data-sync-status]');
        function setMsg(t, isErr) {
          if (!status) return;
          status.hidden = false;
          status.textContent = t;
          status.className = 'su-sync-status' + (isErr ? ' err' : '');
        }
        if (!isHttp) {
          setMsg('Double-click Start Riah Usage, then try Sync again.', true);
          return;
        }
        btn.disabled = true;
        setMsg('Opening Google sign-in window…');
        fetch('/api/sync-gemini', { method: 'POST' })
          .then(function (r) {
            return r.json().then(function (j) {
              return { ok: r.ok && j && j.ok, j: j };
            });
          })
          .then(function (res) {
            if (!res.ok) {
              btn.disabled = false;
              setMsg('Could not start Sync. Try again in a moment.', true);
              return;
            }
            setMsg('Sign into Google if asked — we’ll finish automatically.');
            clearSyncPoll();
            var tries = 0;
            syncPollTimer = setInterval(function () {
              tries += 1;
              Promise.all([
                fetch('/api/sync-gemini', { cache: 'no-store' }).then(function (r) {
                  return r.json();
                }),
                fetch('/usage-data.js?t=' + Date.now(), { cache: 'no-store' })
                  .then(function (r) {
                    return r.text();
                  })
                  .then(function (text) {
                    var m = text.match(/window\.USAGE_DATA\s*=\s*(\{[\s\S]*\});?\s*$/);
                    return m ? JSON.parse(m[1]) : null;
                  })
                  .catch(function () {
                    return null;
                  }),
              ]).then(function (pair) {
                var st = pair[0] || {};
                var fresh = pair[1];
                if (fresh) {
                  window.USAGE_DATA = fresh;
                  latestData = fresh;
                }
                var gemOk =
                  fresh &&
                  (fresh.providers || []).some(function (p) {
                    return (
                      p.shortName === 'Gemini' &&
                      p.status !== 'reconnect' &&
                      (p.meters || []).length
                    );
                  });
                if (gemOk) {
                  clearSyncPoll();
                  btn.disabled = false;
                  setMsg('Gemini is connected.');
                  render(fresh, true);
                  advanceWizard(fresh);
                  return;
                }
                if (st.running === false && st.ok === false) {
                  clearSyncPoll();
                  btn.disabled = false;
                  if (st.error === 'need_page_capture' || st.phase === 'need_page_capture') {
                    setMsg(
                      'Your browser is holding the login while it’s open. On the Gemini Usage tab, click the “Send to Riah Usage” bookmark (capture page just opened).',
                      true
                    );
                  } else {
                    setMsg('Sync didn’t finish. Tap Sync Gemini and sign in if asked.', true);
                  }
                  return;
                }
                if (st.running === false && st.ok === true && !gemOk) {
                  refreshNow(null, { quietLabel: true }).then(function (d) {
                    var ok2 =
                      d &&
                      (d.providers || []).some(function (p) {
                        return (
                          p.shortName === 'Gemini' &&
                          p.status !== 'reconnect' &&
                          (p.meters || []).length
                        );
                      });
                    clearSyncPoll();
                    btn.disabled = false;
                    if (ok2) {
                      setMsg('Gemini is connected.');
                      advanceWizard(d);
                    } else {
                      setMsg('Signed in, but meters aren’t ready yet. Tap Sync Gemini once more.', true);
                    }
                  });
                  return;
                }
                if (tries > 90) {
                  clearSyncPoll();
                  btn.disabled = false;
                  setMsg('Still waiting on Google. Tap Sync Gemini again when you’re ready.', true);
                }
              });
            }, 2000);
          })
          .catch(function () {
            btn.disabled = false;
            setMsg('Could not reach the desk. Start Riah Usage again.', true);
          });
      });
    });

    var see = document.getElementById('btn-see-meters');
    if (see)
      see.addEventListener('click', function () {
        try {
          localStorage.setItem(SKIP_KEY, '1');
        } catch (e) {}
        saveWizard({ phase: 'pick', queue: loadWant(), index: 0 });
        showSetup(false);
      });
    var skip = document.getElementById('btn-skip');
    if (skip)
      skip.addEventListener('click', function () {
        try {
          localStorage.setItem(SKIP_KEY, '1');
        } catch (e) {}
        showSetup(false);
      });
  }

  function wireDrag() {
    if (dragWired) return;
    dragWired = true;
    list.addEventListener('dragstart', function (e) {
      var li = e.target.closest('li[draggable]');
      if (!li || !list.contains(li)) return;
      dragEl = li;
      didDrag = true;
      li.classList.add('ru-dragging');
      e.dataTransfer.effectAllowed = 'move';
      try {
        e.dataTransfer.setData('text/plain', li.getAttribute('data-name') || '');
      } catch (err) {}
    });
    list.addEventListener('dragend', function () {
      if (dragEl) dragEl.classList.remove('ru-dragging');
      list.querySelectorAll('.ru-drop-target').forEach(function (el) {
        el.classList.remove('ru-drop-target');
      });
      dragEl = null;
      var names = Array.prototype.map.call(list.querySelectorAll('li[data-name]'), function (li) {
        return li.getAttribute('data-name');
      });
      saveOrder(names);
      setTimeout(function () {
        didDrag = false;
      }, 0);
    });
    list.addEventListener('dragover', function (e) {
      e.preventDefault();
      if (!dragEl) return;
      var over = e.target.closest('li[draggable]');
      if (!over || over === dragEl || !list.contains(over)) return;
      list.querySelectorAll('.ru-drop-target').forEach(function (el) {
        if (el !== over) el.classList.remove('ru-drop-target');
      });
      over.classList.add('ru-drop-target');
      var rect = over.getBoundingClientRect();
      var before = e.clientY - rect.top < rect.height / 2;
      if (before) list.insertBefore(dragEl, over);
      else list.insertBefore(dragEl, over.nextSibling);
    });
    list.addEventListener('drop', function (e) {
      e.preventDefault();
    });
    list.addEventListener(
      'click',
      function (e) {
        if (!didDrag) return;
        var a = e.target.closest('a.ru-card');
        if (a) {
          e.preventDefault();
          e.stopPropagation();
        }
      },
      true
    );
  }

  function formatReset(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    var ms = d.getTime() - Date.now();
    if (ms <= 0) return 'resets soon';
    var hrs = ms / 3600000;
    if (hrs < 48) return 'resets in ' + Math.max(1, Math.round(hrs)) + 'h';
    var days = Math.round(hrs / 24);
    if (days <= 14) return 'resets in ' + days + 'd';
    return (
      'resets ' +
      d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    );
  }

  // Say out loud when a number is not current. A kept-back reading used to look
  // exactly like a live one, under a green LIVE dot -- so a stale 79% read as
  // today's truth when the real figure was 91%. An old number is fine; an old
  // number wearing today's clothes is not. (Captain, 2026-07-20)
  // "54m ago" reads as a fact. "54M OLD" reads as a scolding, and shouting it
  // in caps made it worse. (Captain, 2026-07-20.)
  function staleAge(iso) {
    if (!iso) return 'not current';
    var then = Date.parse(iso);
    if (!then) return 'not current';
    var mins = Math.round((Date.now() - then) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + 'm ago';
    var hrs = Math.round(mins / 60);
    if (hrs < 24) return hrs + 'h ago';
    return Math.round(hrs / 24) + 'd ago';
  }
  function staleTag(p) {
    if (!p || !p.stale) return '';
    var why = p.staleReason
      ? String(p.staleReason)
      : 'Could not reach this provider just now — showing the last reading.';
    // Plain sentence + the button that actually fixes it. A customer should
    // never have to open a terminal to un-stick their own meter.
    var btn = p.fix
      ? '<button type="button" class="ru-fix" data-fix="' + esc(p.fix.id) + '">' +
        esc(p.fix.verb) + '</button>'
      : '';
    return (
      '<span class="ru-stale" title="' + esc(why) + '">' +
      esc(staleAge(p.readAt)) +
      '</span>' +
      '<span class="ru-stale-why">' + esc(why) + '</span>' +
      btn
    );
  }

  function renderBoard(data) {
    var rows = sortBySaved(data.providers || []).filter(function (p) {
      return !isHidden(p.shortName);
    });
    if (!rows.length) {
      var n = connectedCount(data);
      var hiddenN = loadHidden().length;
      list.innerHTML =
        n > 0 && hiddenN > 0
          ? '<li class="ru-empty">Nothing on the board right now. Tap <b>Connect</b> and check what you want shown.</li>'
          : n > 0
            ? '<li class="ru-empty">Login found. Open <b>Connect</b> if meters don’t show yet.</li>'
            : '<li class="ru-empty">No meters yet. Tap <b>Connect</b> to link an AI — you only need one to start.</li>';
      return;
    }
    list.innerHTML = rows
      .map(function (p) {
        var reconnect = p.status === 'reconnect' || !(p.meters || []).length;
        var href = !reconnect && p.links && p.links[0] && p.links[0].href ? p.links[0].href : null;
        var tag = reconnect ? 'button' : href ? 'a' : 'div';
        var attrs = reconnect
          ? ' type="button" data-reconnect="' + esc(p.shortName) + '"'
          : href
            ? ' href="' + esc(safeUrl(href)) + '" target="_blank" rel="noopener"'
            : '';
        var planInner = p.plan
          ? '<span class="ru-plan">' + esc(String(p.plan).replace(/_/g, ' ')) + '</span>'
          : '';
        if (p.price) planInner += '<span class="ru-price">(' + esc(p.price) + ')</span>';
        if (reconnect) {
          planInner = '';
        }
        var plan = '<div class="ru-plan-block">' + (planInner || (reconnect ? '' : '<span class="ru-plan">—</span>')) + '</div>';
        var body;
        if (reconnect) {
          var hint = p.reconnectHint || 'Login expired';
          body =
            '<div class="ru-reconnect">' + esc(hint) + '</div>' +
            '<div class="ru-bar warn"><i style="width:100%"></i></div>';
        } else {
          var meters = (p.meters || [])
            .map(function (m) {
              var t = tone(m.usedPercent);
              // RS-036: `label` reaches here from a provider API or the local
              // sync bridge -- neither is ours. Escape before it becomes markup.
              var label = String(m.label == null ? '' : m.label).replace(/^Weekly\s+/i, '');
              if (label.toLowerCase() === 'weekly') label = 'Weekly';
              var reset = formatReset(m.resetsAt);
              return (
                '<div class="ru-meter"><div class="lab">' +
                esc(label) +
                '</div><div class="num ' +
                t +
                '">' +
                Number(m.usedPercent) +
                '%</div>' +
                (reset ? '<div class="reset">' + reset + '</div>' : '') +
                '</div>'
              );
            })
            .join('');
          var barT = hottest(p.meters);
          var barW = Math.max.apply(
            null,
            (p.meters || [])
              .map(function (m) {
                return m.usedPercent;
              })
              .concat([0])
          );
          body =
            '<div class="ru-meters">' +
            meters +
            '</div>' +
            '<div class="ru-bar ' +
            barT +
            '"><i style="width:' +
            Math.min(100, barW) +
            '%"></i></div>';
        }
        return (
          '<li draggable="true" data-name="' +
          esc(p.shortName) +
          '">' +
          '<' +
          tag +
          ' class="ru-card"' +
          attrs +
          '>' +
          '<div class="ru-card-top"><div class="ru-ai-wrap"><span class="ru-grip" aria-hidden="true">::</span><div class="ru-ai">' +
          esc(p.shortName) +
          '</div>' +
          staleTag(p) +
          '</div>' +
          plan +
          '</div>' +
          body +
          '</' +
          tag +
          '></li>'
        );
      })
      .join('');
    wireDrag();
    // "Sign in to X" — opens a terminal already running the right command, then
    // re-checks on its own so the card un-sticks without another click.
    list.querySelectorAll('[data-fix]').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        if (didDrag) return;
        var id = btn.getAttribute('data-fix');
        var was = btn.textContent;
        btn.disabled = true;
        btn.textContent = 'Opening…';
        fetch('/api/relogin', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: id }),
        })
          .then(function (r) { return r.json(); })
          .then(function (j) {
            btn.textContent = (j && j.note) ? j.note : 'Finish signing in';
            // Keep checking for a few minutes; the moment the sign-in lands,
            // the number goes live again with nothing more to click.
            var tries = 0;
            var t = setInterval(function () {
              tries++;
              refreshNow(null, { quietLabel: true }).then(function (d) {
                var ok = d && (d.providers || []).some(function (x) {
                  return x.shortName.toLowerCase() === id && !x.stale;
                });
                if (ok || tries > 20) clearInterval(t);
              });
            }, 15000);
          })
          .catch(function () {
            btn.disabled = false;
            btn.textContent = was;
          });
      });
    });
    list.querySelectorAll('[data-reconnect]').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        if (didDrag) {
          e.preventDefault();
          return;
        }
        openConnectFor(btn.getAttribute('data-reconnect') || '');
      });
    });
  }

  function render(data, liveOk) {
    latestData = data;
    if (typeof liveOk === 'boolean') setLive(liveOk);
    else if (data && (data.providers || []).length) setLive(isHttp);
    else setLive(false);

    if (!data) {
      list.innerHTML =
        '<li class="ru-empty">Double-click <b>Start Riah Usage</b> to open the live board.</li>';
      showSetup(true);
      renderSetup({ providers: [], connections: [] });
      return;
    }

    if (data.generatedAt && data.generatedAt === lastGeneratedAt && !setupOpen) {
      // still refresh setup status if open
    } else {
      lastGeneratedAt = data.generatedAt || null;
    }

    renderSetup(data);
    renderBoard(data);

    if (shouldAutoOpenSetup(data)) showSetup(true);
    else if (!setupOpen) showSetup(false);

    clearBoardMissing();
  }

  // Captain's ruling (2026-07-21): nothing undone ever renders on the board.
  // The board is live meters only. The "why isn't X showing" story still
  // exists — it lives on the Connect page (missingSection below), where the
  // fix is one tap away. Silence once made people say "broken"; the answer
  // is telling them on Connect, not parking problems on the front page.
  function clearBoardMissing() {
    var miss = document.getElementById('missing');
    if (miss && miss.innerHTML !== '') miss.innerHTML = '';
  }

  // Connect-page section: say why a meter is not showing.
  // Respects the "Shown on the board" checkboxes: unchecking a provider means
  // "I don't want to see it" — and that includes this list. (Captain, 2026-07-21.)
  function missingSection(data) {
    var items = ((data && data.missing) || []).filter(function (m) {
      return !isHidden(m.name);
    });
    if (!items.length) return '';
    var rows = items
      .map(function (m) {
        var stale = m.state === 'stale';
        return (
          '<li class="ru-miss' + (stale ? ' is-stale' : '') + '">' +
          '<span class="ru-miss-name">' + esc(m.name) + '</span>' +
          '<span class="ru-miss-why">' + esc(m.reason || '') + '</span>' +
          (m.action ? '<span class="ru-miss-do">' + esc(m.action) + '</span>' : '') +
          '</li>'
        );
      })
      .join('');
    return (
      '<div class="su-missing">' +
      '<p class="su-section">Not showing yet</p>' +
      '<ul class="ru-miss-list">' + rows + '</ul>' +
      '</div>'
    );
  }

  // Refresh all — sits on the LIVE line so an "old" badge always has its cure
  // within reach. Reuses refreshNow(), which already re-collects, re-reads the
  // data file and repaints; no point writing a second copy of that.
  var refreshBtn = document.getElementById('btn-refresh-all');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', function () {
      refreshNow(refreshBtn, { busyLabel: 'Refreshing…', restoreLabel: 'Refresh all' });
    });
  }

  var connectBtn = document.getElementById('btn-connect');
  if (connectBtn) {
    connectBtn.addEventListener('click', function () {
      if (setupOpen) showSetup(false);
      else {
        showSetup(true);
        renderSetup(latestData || { providers: [], connections: [] });
      }
    });
  }

  render(
    window.USAGE_DATA,
    isHttp && !!(window.USAGE_DATA && (window.USAGE_DATA.providers || []).length)
  );

  // Push whatever the page already has saved, so a prior uncheck reaches the
  // tray without needing to re-toggle the box.
  if (isHttp) {
    try {
      saveHidden(loadHidden());
    } catch (e) {}
  }

  if (isHttp) {
    var pollMs = Number(cfg.pollMs) || 15000;
    function poll() {
      fetch('/api/status?t=' + Date.now(), { cache: 'no-store' })
        .then(function (r) {
          return r.ok ? r.json() : Promise.reject();
        })
        .then(function (st) {
          return fetch('/usage-data.js?t=' + Date.now(), { cache: 'no-store' })
            .then(function (r) {
              return r.ok ? r.text() : Promise.reject();
            })
            .then(function (text) {
              var m = text.match(/window\.USAGE_DATA\s*=\s*(\{[\s\S]*\});?\s*$/);
              if (!m) {
                setLive(false);
                return;
              }
              try {
                var keepSetup = setupOpen;
                lastGeneratedAt = null;
                render(JSON.parse(m[1]), st.lastCollectOk !== false);
                if (keepSetup) showSetup(true);
              } catch (e) {
                setLive(false);
              }
            });
        })
        .catch(function () {
          setLive(false);
        });
    }
    poll();
    setInterval(poll, pollMs);
  } else {
    setLive(false);
  }
})();
