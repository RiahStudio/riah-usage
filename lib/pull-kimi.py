#!/usr/bin/env python3
"""
Pull Kimi (Moonshot AI) coding-plan usage the same way every other provider on
this desk works: from a login some CLI already put on disk. No browser, no
cookies, no API keys.

Kimi Code CLI signs in with a device-code flow and stores OAuth at
~/.kimi-code/credentials/kimi-code.json (KIMI_CODE_HOME moves that root).
With that token we ask the same usage endpoint the CLI's /usage command asks:

    GET https://api.kimi.com/coding/v1/usages

Access tokens are short-lived (~15 minutes), so an expired one is normal and
refresh is the main path, not the edge case:

    POST https://auth.kimi.com/api/oauth/token   (grant_type=refresh_token)

CLIENT_ID below is the Kimi Code CLI's own public device-flow client
identifier — it ships inside every kimi-code install and is not a secret
(same class of constant as the Gemini CLI's OAuth client id). Endpoint and
client verified against a real login on 2026-07-21; implementation is our own.

Statuses worth knowing downstream:
  - no_kimi_login    -> nothing at the credentials path; run `kimi login`.
  - auth_expired     -> refresh was refused; run `kimi login` again.
  - no_subscription  -> login works, but the account has no Kimi for Coding
                        plan, and Kimi only serves /usages to subscribers.

Never prints tokens.
"""
from __future__ import annotations

import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

HOME = os.path.expanduser("~")
KIMI_HOME = os.environ.get("KIMI_CODE_HOME") or os.path.join(HOME, ".kimi-code")
CRED = os.path.join(KIMI_HOME, "credentials", "kimi-code.json")

TOKEN_URL = "https://auth.kimi.com/api/oauth/token"
USAGES_URL = "https://api.kimi.com/coding/v1/usages"
CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098"
HREF = "https://www.kimi.com/code"
UA = "riah-usage/1.0"


def read_json(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def out(obj):
    print(json.dumps(obj))
    return 0


def save_cred(data):
    """Atomic write — worst case we lose a refresh, never corrupt the CLI's file."""
    try:
        tmp = CRED + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
        os.replace(tmp, CRED)
    except OSError:
        pass


# --- auth --------------------------------------------------------------------


def refresh(creds):
    rt = creds.get("refresh_token")
    if not rt:
        return None, "no_refresh_token"
    body = urllib.parse.urlencode(
        {
            "grant_type": "refresh_token",
            "refresh_token": rt,
            "client_id": CLIENT_ID,
        }
    ).encode()
    req = urllib.request.Request(
        TOKEN_URL,
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/x-www-form-urlencoded",
            "Accept": "application/json",
            "User-Agent": UA,
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            tok = json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        return None, "refresh_http_%d" % e.code
    except Exception:
        return None, "refresh_failed"
    access = tok.get("access_token")
    if not access:
        return None, "refresh_failed"
    creds["access_token"] = access
    # Kimi rotates the refresh token — saving the new one back is what keeps
    # the CLI's own login healthy instead of quietly burning it.
    if tok.get("refresh_token"):
        creds["refresh_token"] = tok["refresh_token"]
    if tok.get("expires_in"):
        creds["expires_at"] = int(time.time()) + int(tok["expires_in"])
        creds["expires_in"] = int(tok["expires_in"])
    for k in ("scope", "token_type"):
        if tok.get(k):
            creds[k] = tok[k]
    save_cred(creds)
    return access, None


def access_token(creds):
    tok = creds.get("access_token")
    exp = 0
    try:
        exp = int(creds.get("expires_at") or 0)  # epoch seconds
    except (TypeError, ValueError):
        exp = 0
    # Refresh a minute early so a slow call cannot expire mid-flight.
    if not tok or time.time() >= exp - 60:
        return refresh(creds)
    return tok, None


# --- usage -------------------------------------------------------------------


def get_usages(token):
    req = urllib.request.Request(
        USAGES_URL,
        headers={
            "Authorization": "Bearer %s" % token,
            "Accept": "application/json",
            "User-Agent": UA,
        },
    )
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read().decode())


def iso(ts):
    """Normalize a reset stamp: ISO passes through, epoch seconds/ms convert."""
    if ts is None or ts == "":
        return None
    if isinstance(ts, (int, float)):
        n = float(ts)
        if n > 1e12:
            n /= 1000.0
        try:
            return time.strftime("%Y-%m-%dT%H:%M:%S+00:00", time.gmtime(n))
        except (OverflowError, OSError, ValueError):
            return None
    return str(ts)


def pretty_label(raw):
    m = str(raw or "").strip().lower().replace("_", " ").replace("-", " ")
    if not m:
        return "Quota"
    if "week" in m:
        return "Weekly"
    if "hour" in m and ("5" in m or "five" in m):
        return "5-hour"
    if "hour" in m:
        return "Hourly"
    if "day" in m or "daily" in m:
        return "Daily"
    if "month" in m:
        return "Monthly"
    return m.title()[:12]


def pick(d, *names):
    for n in names:
        if isinstance(d, dict) and d.get(n) is not None:
            return d.get(n)
    return None


def meter_from(item):
    """One usage window -> one meter, whatever field spelling Kimi chose."""
    if not isinstance(item, dict):
        return None
    label = pretty_label(
        pick(item, "name", "label", "window", "title", "period", "scope", "type")
    )
    pct = pick(item, "used_percent", "usedPercent", "usage_percent", "percent")
    if pct is None:
        used = pick(item, "used", "usage", "consumed", "count")
        limit = pick(item, "limit", "total", "quota", "max")
        if used is not None and limit not in (None, 0):
            try:
                pct = float(used) / float(limit) * 100.0
            except (TypeError, ValueError, ZeroDivisionError):
                pct = None
    if pct is None:
        frac = pick(item, "remaining_fraction", "remainingFraction")
        if isinstance(frac, (int, float)):
            pct = (1.0 - float(frac)) * 100.0
    if pct is None:
        return None
    try:
        pct = max(0, min(100, round(float(pct))))
    except (TypeError, ValueError):
        return None
    resets = iso(
        pick(
            item,
            "reset_at",
            "resets_at",
            "resetAt",
            "reset_time",
            "resetTime",
            "next_reset_time",
            "renews_at",
            "expires_at",
        )
    )
    return {"label": label, "usedPercent": pct, "resetsAt": resets}


def meters_from(payload):
    items = None
    plan = None
    if isinstance(payload, dict):
        for key in ("usages", "data", "items", "quotas", "windows", "limits"):
            v = payload.get(key)
            if isinstance(v, list):
                items = v
                break
            if isinstance(v, dict):
                items = list(v.values())
                break
        if items is None:
            items = [payload]
        plan = pick(
            payload, "membership", "plan", "level", "tier", "plan_name", "planName"
        )
        if isinstance(plan, dict):
            plan = pick(plan, "name", "label", "id", "level")
    elif isinstance(payload, list):
        items = payload
    meters = []
    seen = set()
    for it in items or []:
        m = meter_from(it)
        if not m or m["label"] in seen:
            continue
        seen.add(m["label"])
        meters.append(m)
        if plan is None and isinstance(it, dict):
            p = pick(it, "membership", "plan", "level", "tier")
            if isinstance(p, str):
                plan = p
    # Busiest first, so the tray's bars show what actually matters.
    meters.sort(key=lambda m: m["usedPercent"], reverse=True)
    return meters, (str(plan).strip() if isinstance(plan, str) and plan.strip() else None)


# --- main --------------------------------------------------------------------


def main():
    # Dev aid: map a saved response body without touching the network.
    #   python lib/pull-kimi.py --parse-fixture some-response.json
    if len(sys.argv) == 3 and sys.argv[1] == "--parse-fixture":
        payload = read_json(sys.argv[2])
        if payload is None:
            return out({"ok": False, "error": "bad_fixture"})
        meters, plan = meters_from(payload)
        return out({"ok": bool(meters), "plan": plan, "meters": meters, "href": HREF})

    creds = read_json(CRED)
    if not isinstance(creds, dict) or not (
        creds.get("access_token") or creds.get("refresh_token")
    ):
        return out(
            {
                "ok": False,
                "error": "no_kimi_login",
                "hint": "Run `kimi login` in a terminal, then refresh.",
            }
        )
    token, err = access_token(creds)
    if not token:
        return out(
            {
                "ok": False,
                "error": err or "auth_expired",
                "hint": "Run `kimi login` again to renew the sign-in.",
            }
        )
    try:
        payload = get_usages(token)
    except urllib.error.HTTPError as e:
        detail = ""
        try:
            detail = e.read().decode("utf-8", "replace")
        except Exception:
            pass
        if e.code == 401:
            # One retry through refresh — the token may have just lapsed.
            token, rerr = refresh(creds)
            if token:
                try:
                    payload = get_usages(token)
                except Exception:
                    return out({"ok": False, "error": "http_401"})
            else:
                return out({"ok": False, "error": rerr or "auth_expired"})
        elif e.code == 403 and "permission_denied" in detail:
            return out(
                {
                    "ok": False,
                    "error": "no_subscription",
                    "hint": "The Kimi login works, but this account has no Kimi for Coding plan.",
                }
            )
        else:
            return out({"ok": False, "error": "http_%d" % e.code})
    except Exception:
        return out({"ok": False, "error": "no_answer"})

    meters, plan = meters_from(payload)
    if not meters:
        return out({"ok": False, "error": "unknown_shape"})
    return out({"ok": True, "plan": plan, "meters": meters, "href": HREF})


if __name__ == "__main__":
    sys.exit(main())
