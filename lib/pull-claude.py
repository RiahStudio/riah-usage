#!/usr/bin/env python3
"""
Pull Claude usage: 5-hour, weekly, Fable, Sonnet/Opus scoped windows.
Reads Claude Code OAuth from ~/.claude/.credentials.json (claudeAiOauth).
Never prints tokens.
"""
from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

HOME = os.path.expanduser("~")
CRED = os.path.join(HOME, ".claude", ".credentials.json")
CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
TOKEN_URL = "https://platform.claude.com/v1/oauth/token"
USAGE_URL = "https://api.anthropic.com/api/oauth/usage"


def load_cred():
    if not os.path.exists(CRED):
        return None
    with open(CRED, "r", encoding="utf-8") as f:
        return json.load(f)


def save_cred(data):
    tmp = CRED + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f)
    os.replace(tmp, CRED)


def oauth_block(cred):
    if not cred:
        return None
    if isinstance(cred.get("claudeAiOauth"), dict):
        o = cred["claudeAiOauth"]
        if o.get("accessToken") or o.get("refreshToken"):
            return o
    return None


def refresh(oauth):
    rt = oauth.get("refreshToken") or oauth.get("refresh_token")
    if not rt:
        return None
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
            "User-Agent": "claude-code/2.0.32",
        },
    )
    with urllib.request.urlopen(req, timeout=20) as r:
        tok = json.loads(r.read().decode())
    access = tok.get("access_token")
    if not access:
        return None
    oauth["accessToken"] = access
    if tok.get("refresh_token"):
        oauth["refreshToken"] = tok["refresh_token"]
    if tok.get("expires_in"):
        oauth["expiresAt"] = int(time.time() * 1000) + int(tok["expires_in"]) * 1000
    return access


def access_token(oauth):
    at = oauth.get("accessToken") or oauth.get("access_token")
    exp = oauth.get("expiresAt") or oauth.get("expires_at")
    need = not at
    if exp is not None:
        try:
            need = need or int(exp) < int(time.time() * 1000) + 120_000
        except Exception:
            pass
    if need:
        return refresh(oauth)
    return at


def fetch_usage(token):
    req = urllib.request.Request(
        USAGE_URL,
        headers={
            "Authorization": f"Bearer {token}",
            "anthropic-beta": "oauth-2025-04-20",
            "User-Agent": "claude-code/2.0.32",
            "Accept": "application/json",
        },
    )
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read().decode())


def pretty_plan(oauth):
    """Human plan label: Max 20×, Pro, Free, …"""
    import re

    sub = str(oauth.get("subscriptionType") or "").strip().lower()
    tier = str(oauth.get("rateLimitTier") or "").strip()
    mult = None
    m = re.search(r"(\d+)\s*x", tier, re.I)
    if m:
        mult = m.group(1)
    if sub == "max":
        return f"Max {mult}×" if mult else "Max"
    if sub == "pro":
        return "Pro"
    if sub in ("free", "free_plan"):
        return "Free"
    if tier:
        if "max" in tier.lower() and mult:
            return f"Max {mult}×"
        return tier.replace("_", " ").replace("default ", "").strip().title()
    return sub.title() if sub else None


def meters_from_usage(j):
    meters = []

    def add(label, used, resets=None):
        if used is None:
            return
        meters.append(
            {
                "label": label,
                "usedPercent": round(float(used)),
                "resetsAt": resets,
            }
        )

    if isinstance(j.get("five_hour"), dict):
        add("5-hour", j["five_hour"].get("utilization"), j["five_hour"].get("resets_at"))
    if isinstance(j.get("seven_day"), dict):
        add("Weekly", j["seven_day"].get("utilization"), j["seven_day"].get("resets_at"))
    if isinstance(j.get("seven_day_sonnet"), dict):
        add(
            "Weekly Sonnet",
            j["seven_day_sonnet"].get("utilization"),
            j["seven_day_sonnet"].get("resets_at"),
        )
    if isinstance(j.get("seven_day_opus"), dict):
        add(
            "Weekly Opus",
            j["seven_day_opus"].get("utilization"),
            j["seven_day_opus"].get("resets_at"),
        )
    if isinstance(j.get("seven_day_cowork"), dict):
        add(
            "Weekly Cowork",
            j["seven_day_cowork"].get("utilization"),
            j["seven_day_cowork"].get("resets_at"),
        )

    seen = {m["label"].lower() for m in meters}
    for lim in j.get("limits") or []:
        if not isinstance(lim, dict):
            continue
        pct = lim.get("percent")
        if pct is None:
            pct = lim.get("utilization")
        if pct is None:
            continue
        kind = (lim.get("kind") or "").lower()
        model = None
        scope = lim.get("scope") or {}
        if isinstance(scope, dict):
            model = (scope.get("model") or {}).get("display_name") or scope.get(
                "display_name"
            )
        if kind == "session" or "session" in kind:
            label = "5-hour"
        elif kind in ("weekly_all", "weekly"):
            label = "Weekly"
        elif model:
            # Glance labels: "Fable" not "Weekly Fable"
            label = str(model)
        else:
            label = lim.get("name") or kind or "Limit"
        if label.lower() in seen:
            continue
        seen.add(label.lower())
        add(label, pct, lim.get("resets_at"))

    return meters


def main():
    cred = load_cred()
    oauth = oauth_block(cred)
    if not oauth:
        print(
            json.dumps(
                {
                    "ok": False,
                    "error": "no_claude_code_oauth",
                    "hint": "Run `claude` once and complete /login so ~/.claude/.credentials.json gets claudeAiOauth.",
                }
            )
        )
        return 0

    oauth_mut = dict(oauth)
    try:
        token = access_token(oauth_mut)
    except Exception:
        print(json.dumps({"ok": False, "error": "refresh_failed"}))
        return 0
    if not token:
        print(json.dumps({"ok": False, "error": "no_access_token"}))
        return 0

    if oauth_mut.get("accessToken") != oauth.get("accessToken"):
        cred["claudeAiOauth"] = oauth_mut
        save_cred(cred)

    try:
        usage = fetch_usage(token)
    except urllib.error.HTTPError as e:
        if e.code in (401, 403):
            try:
                token = refresh(oauth_mut)
                if not token:
                    print(json.dumps({"ok": False, "error": f"http_{e.code}"}))
                    return 0
                cred["claudeAiOauth"] = oauth_mut
                save_cred(cred)
                usage = fetch_usage(token)
            except Exception:
                print(json.dumps({"ok": False, "error": f"http_{e.code}"}))
                return 0
        else:
            print(json.dumps({"ok": False, "error": f"http_{e.code}"}))
            return 0
    except Exception as e:
        print(json.dumps({"ok": False, "error": type(e).__name__}))
        return 0

    meters = meters_from_usage(usage)
    plan = pretty_plan(oauth_mut)
    print(
        json.dumps(
            {
                "ok": bool(meters),
                "plan": plan,
                "meters": meters,
                "href": "https://claude.ai/settings/usage",
                "error": None if meters else "empty_meters",
            }
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
