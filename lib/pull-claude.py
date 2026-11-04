#!/usr/bin/env python3
"""
Pull Claude usage: 5-hour, weekly, Fable, Sonnet/Opus scoped windows.
Prefers Riah Usage's own login (see pull_own), which it renews itself.
Without one, borrows Claude Code's login in ~/.claude READ-ONLY -- never
renews it, never writes it -- so it can't sign Claude Code out.
If neither works, reads the Claude.ai session already in Firefox.
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
# Riah Usage's own login (Re-sign in on the Claude card makes it). Outside
# the repo on purpose: it holds tokens.
OWN_DIR = os.environ.get("RIAH_USAGE_CLAUDE_DIR") or os.path.join(HOME, ".riah-usage", "claude")
OWN_CRED = os.path.join(OWN_DIR, ".credentials.json")
CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
TOKEN_URL = "https://platform.claude.com/v1/oauth/token"
USAGE_URL = "https://api.anthropic.com/api/oauth/usage"
SCRATCH = os.path.join(os.path.dirname(__file__), "..", "scratch")
BACKOFF_FILE = os.path.join(SCRATCH, "claude-retry.json")
# Written by lib/claude-statusline-tap.js from Claude Code's own status line.
TAP_FILE = os.path.join(SCRATCH, "claude-statusline.json")
TAP_FRESH_S = 20 * 60
# Last good usage-endpoint answer, for the scoped meters (Fable, Sonnet...)
# the status line doesn't carry.
RAW_CACHE = os.path.join(SCRATCH, "claude-usage-raw.json")
# The desk's watcher asks every minute (Captain, 2026-10-19: "useless unless
# it's updated every minute or so"). Anthropic can still answer 429 with an
# hour's Retry-After, so the gap tunes itself: one read a minute normally, one
# every five minutes for six hours after any 429. While locked out, the
# status-line numbers fill in.
ATTEMPT_FILE = os.path.join(SCRATCH, "claude-last-attempt.json")
MIN_GAP_S = 55
CAUTIOUS_GAP_S = 5 * 60
CAUTIOUS_FOR_S = 6 * 3600
WEB_USAGE_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:142.0) "
    "Gecko/20100101 Firefox/142.0"
)


def load_cred():
    if not os.path.exists(CRED):
        return None
    with open(CRED, "r", encoding="utf-8") as f:
        return json.load(f)


def oauth_block(cred):
    if not cred:
        return None
    if isinstance(cred.get("claudeAiOauth"), dict):
        o = cred["claudeAiOauth"]
        if o.get("accessToken") or o.get("refreshToken"):
            return o
    return None


def save_own_cred(data):
    os.makedirs(OWN_DIR, exist_ok=True)
    tmp = OWN_CRED + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f)
    os.replace(tmp, OWN_CRED)


def refresh(oauth):
    """Renew a login. Only ever called on Riah Usage's OWN login."""
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


def fresh_token(oauth):
    at = oauth.get("accessToken") or oauth.get("access_token")
    exp = oauth.get("expiresAt") or oauth.get("expires_at")
    if not at:
        return None
    if exp:
        try:
            if int(exp) < int(time.time() * 1000) + 120_000:
                return None
        except Exception:
            pass
    return at


def renew_own(failed=None):
    """
    Renew Riah Usage's own login, one process at a time.

    The refresh token changes on every renewal, so two readers renewing at
    once (the minute watcher and a full collect, or Sync Gemini's collect)
    would leave one holding a dead token -- and the login gone for good. Take a
    lock, re-read the file, and skip the renewal if another reader just did it.
    Returns (access_token, oauth) or (None, None).
    """
    lock = OWN_CRED + ".lock"
    deadline = time.time() + 30
    while True:
        try:
            os.close(os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY))
            break
        except FileExistsError:
            try:
                if time.time() - os.path.getmtime(lock) > 60:
                    os.remove(lock)  # left by a reader that died mid-renewal
                    continue
            except OSError:
                pass
            if time.time() > deadline:
                return None, None
            time.sleep(0.5)
    try:
        cred = read_json(OWN_CRED)
        oauth = oauth_block(cred)
        if not oauth:
            return None, None
        oauth = dict(oauth)
        current = fresh_token(oauth)
        if current and current != failed:
            return current, oauth  # another reader renewed it moments ago
        token = refresh(oauth)
        if token:
            cred["claudeAiOauth"] = oauth
            save_own_cred(cred)
        return token, oauth
    finally:
        try:
            os.remove(lock)
        except OSError:
            pass


def pull_own():
    """
    Riah Usage's own Claude login, kept apart from Claude Code's.

    The refresh token rotates on every renewal. We used to renew Claude Code's
    own login in ~/.claude and write it back -- and any Claude Code running at
    the time later saved its older copy over ours, so the next renewal used a
    dead token and Claude Code signed itself out. Every few days: a blank card
    and another `claude auth login`. (Captain, 2026-10-19.) A login of our own
    has one user, so renewing it can't knock anything else out.

    Returns the usage JSON and the oauth block, or (None, error).
    """
    cred = None
    if os.path.exists(OWN_CRED):
        try:
            with open(OWN_CRED, "r", encoding="utf-8") as f:
                cred = json.load(f)
        except Exception:
            cred = None
    oauth = oauth_block(cred)
    if not oauth:
        return None, None
    oauth = dict(oauth)
    try:
        token = fresh_token(oauth)
        if not token:
            token, oauth = renew_own()
        if not token:
            return None, "refresh_failed"
        try:
            return fetch_usage(token), oauth
        except urllib.error.HTTPError as e:
            if e.code not in (401, 403):
                return None, f"http_{e.code}"
            token, oauth = renew_own(failed=token)
            if not token:
                return None, f"http_{e.code}"
            return fetch_usage(token, throttle=False), oauth
    except urllib.error.HTTPError as e:
        return None, f"http_{e.code}"
    except ClaudeBackoff:
        return None, "http_429"
    except Exception as e:
        return None, type(e).__name__


def fetch_usage_from_browser():
    """
    Claude.ai session already in Firefox after a web sign-in.
    Same usage JSON shape as the OAuth endpoint. Never prints cookies.
    """
    try:
        import browser_cookie3 as bc
    except Exception:
        return None, None
    try:
        jar = bc.firefox()
    except Exception:
        return None, None
    org = None
    for cookie in jar:
        if cookie.name == "lastActiveOrg" and cookie.value:
            org = str(cookie.value).strip().strip('"')
            break
    if not org:
        return None, None
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))

    def get_json(url):
        req = urllib.request.Request(
            url,
            headers={
                "User-Agent": WEB_USAGE_UA,
                "Accept": "application/json",
                "Referer": "https://claude.ai/settings/usage",
                "Origin": "https://claude.ai",
                "anthropic-client-platform": "web_claude_ai",
            },
        )
        with opener.open(req, timeout=20) as response:
            return json.loads(response.read().decode())

    try:
        usage = get_json(f"https://claude.ai/api/organizations/{org}/usage")
    except Exception:
        return None, None
    plan_oauth = {}
    try:
        org_info = get_json(f"https://claude.ai/api/organizations/{org}")
        plan_oauth["rateLimitTier"] = org_info.get("rate_limit_tier")
        billing = str(org_info.get("billing_type") or "").lower()
        if "pro" in billing:
            plan_oauth["subscriptionType"] = "pro"
        elif "max" in billing:
            plan_oauth["subscriptionType"] = "max"
        elif "free" in billing:
            plan_oauth["subscriptionType"] = "free"
    except Exception:
        pass
    return usage, plan_oauth


def token_tag(token):
    """Short fingerprint so a lockout on one login doesn't block the next one. Not the token."""
    import hashlib

    return hashlib.sha256(token.encode()).hexdigest()[:12]


def fetch_usage(token, throttle=True):
    # A 429 is per login: after a fresh sign-in the new token read fine while
    # the old one was still locked out (2026-10-19).
    back = read_json(BACKOFF_FILE) or {}
    try:
        if back.get("tok") == token_tag(token) and float(back.get("retryAt", 0)) > time.time():
            raise ClaudeBackoff()
    except (ValueError, TypeError):
        pass
    last = read_json(ATTEMPT_FILE) or {}
    try:
        if throttle and time.time() - float(last.get("at", 0)) < MIN_GAP_S:
            # Read it moments ago: hand back that answer instead of a new request.
            cached = read_json(RAW_CACHE) or {}
            if time.time() - float(cached.get("at", 0)) < MIN_GAP_S + 300 and isinstance(cached.get("usage"), dict):
                return cached["usage"]
            raise ClaudeBackoff()
    except (ValueError, TypeError):
        pass
    write_json(ATTEMPT_FILE, {"at": time.time()})
    req = urllib.request.Request(
        USAGE_URL,
        headers={
            "Authorization": f"Bearer {token}",
            "anthropic-beta": "oauth-2025-04-20",
            "User-Agent": "claude-code/2.0.32",
            "Accept": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            usage = json.loads(r.read().decode())
        write_json(RAW_CACHE, {"at": time.time(), "usage": usage})
        return usage
    except urllib.error.HTTPError as e:
        if e.code == 429:
            try:
                seconds = max(60, min(7200, int(e.headers.get("Retry-After", "900"))))
            except (TypeError, ValueError):
                seconds = 900
            os.makedirs(os.path.dirname(BACKOFF_FILE), exist_ok=True)
            with open(BACKOFF_FILE, "w", encoding="utf-8") as f:
                json.dump({"retryAt": time.time() + seconds, "at": time.time(), "tok": token_tag(token)}, f)
        raise


class ClaudeBackoff(Exception):
    """The usage endpoint asked us to wait (or we read it moments ago); do not repeat the request."""


def read_json(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            v = json.load(f)
        return v if isinstance(v, dict) else None
    except (OSError, ValueError):
        return None


def write_json(path, value):
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = f"{path}.{os.getpid()}.tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(value, f)
        os.replace(tmp, path)
    except OSError:
        pass


def iso_reset(v):
    """Status line gives epoch seconds; the usage endpoint gives ISO. Board wants ISO."""
    if isinstance(v, (int, float)) and v > 0:
        secs = v / 1000 if v > 1e12 else v
        return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(secs))
    return v or None


def reset_passed(resets):
    if not resets:
        return False
    try:
        from datetime import datetime

        t = datetime.fromisoformat(str(resets).replace("Z", "+00:00")).timestamp()
        return t < time.time()
    except (ValueError, TypeError):
        return False


def tap_reading():
    """Fresh 5-hour/Weekly from Claude Code's status line, or None."""
    tap = read_json(TAP_FILE)
    if not tap:
        return None
    try:
        if time.time() - float(tap.get("at", 0)) / 1000 > TAP_FRESH_S:
            return None
    except (ValueError, TypeError):
        return None
    rl = tap.get("rate_limits") or {}
    usage = {}
    for key in ("five_hour", "seven_day"):
        w = rl.get(key)
        if isinstance(w, dict):
            used = w.get("used_percentage", w.get("utilization"))
            if used is not None:
                usage[key] = {"utilization": used, "resets_at": iso_reset(w.get("resets_at"))}
    return usage or None


def with_cached_scoped(meters):
    """Add the scoped meters (Fable, Sonnet...) from the last good endpoint read."""
    raw = (read_json(RAW_CACHE) or {}).get("usage")
    if not isinstance(raw, dict):
        return meters
    have = {m["label"].lower() for m in meters}
    for m in meters_from_usage(raw):
        if m["label"].lower() in have:
            continue
        if reset_passed(m.get("resetsAt")):
            m = dict(m, usedPercent=0, resetsAt=None)
        meters.append(m)
    return meters


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


def emit(meters, plan):
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


def fail(error):
    print(json.dumps({"ok": False, "error": error}))
    return 0


def main():
    global MIN_GAP_S
    tap = tap_reading()
    try:
        if time.time() - float((read_json(BACKOFF_FILE) or {}).get("at", 0)) < CAUTIOUS_FOR_S:
            MIN_GAP_S = CAUTIOUS_GAP_S
    except (ValueError, TypeError):
        pass

    usage, own = pull_own()
    if usage:
        return emit(meters_from_usage(usage), pretty_plan(own))
    own_error = own if isinstance(own, str) else None

    # Borrow Claude Code's login, read-only.
    cred = load_cred()
    oauth = oauth_block(cred)
    husk = (cred or {}).get("claudeAiOauth") if isinstance(cred, dict) else None
    husk = husk if isinstance(husk, dict) else {}
    token = fresh_token(oauth) if oauth else None
    shared_error = None
    if token:
        try:
            return emit(meters_from_usage(fetch_usage(token)), pretty_plan(oauth))
        except urllib.error.HTTPError as e:
            shared_error = f"http_{e.code}"
        except ClaudeBackoff:
            shared_error = "http_429"
        except Exception as e:
            shared_error = type(e).__name__

    # Claude Code's own status line: 5-hour and Weekly with no request at all.
    if tap:
        meters = meters_from_usage(tap)
        for m in meters:
            if reset_passed(m.get("resetsAt")):
                m.update(usedPercent=0, resetsAt=None)
        return emit(with_cached_scoped(meters), pretty_plan(oauth or husk))

    usage, plan_oauth = fetch_usage_from_browser()
    if usage:
        merged = dict(husk)
        merged.update({k: v for k, v in (plan_oauth or {}).items() if v})
        return emit(meters_from_usage(usage), pretty_plan(merged))

    if own_error:
        return fail(own_error)
    if shared_error:
        return fail(shared_error)
    if oauth:
        # Claude Code is still signed in; its short-lived key just lapsed and
        # renewing it is Claude Code's job, not ours. Keep the last reading.
        return fail("borrowed_login_idle")
    return fail("no_claude_code_oauth")


if __name__ == "__main__":
    sys.exit(main())
