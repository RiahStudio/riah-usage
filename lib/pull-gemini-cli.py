#!/usr/bin/env python3
"""
Pull Gemini usage the same way every other provider on this desk works:
from a login some CLI already put on disk. No browser, no cookies, no
extension, no page left open.

Gemini CLI signs in with Google and caches OAuth at ~/.gemini/oauth_creds.json.
With that token we can call the same two Code Assist endpoints the CLI itself
calls for quota:

    POST https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist
    POST https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota

Protocol learned from the open-source `gemini-cli-usage` tool
(https://github.com/wakamex/gemini-cli-usage) -- implementation is our own.

Reports the Gemini CLI / Code Assist quota. That is NOT the same number as the
consumer Gemini app's usage page; it is the one that matches how the studio
actually spends Gemini. Never prints tokens.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

HOME = os.path.expanduser("~")
GEMINI_DIR = os.environ.get("GEMINI_DIR") or os.path.join(HOME, ".gemini")
CRED = os.path.join(GEMINI_DIR, "oauth_creds.json")
SETTINGS = os.path.join(GEMINI_DIR, "settings.json")

TOKEN_URL = "https://oauth2.googleapis.com/token"
CODE_ASSIST = "https://cloudcode-pa.googleapis.com/v1internal"
UA = "riah-usage/1.0"

CLIENT_ID_RE = re.compile(r"OAUTH_CLIENT_ID\s*=\s*['\"]([^'\"]+)['\"]")
CLIENT_SECRET_RE = re.compile(r"OAUTH_CLIENT_SECRET\s*=\s*['\"]([^'\"]+)['\"]")


def read_json(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def out(obj):
    print(json.dumps(obj))
    return 0


# --- auth -------------------------------------------------------------------


def auth_type():
    """Which sign-in Gemini CLI is configured for. Env wins, then settings."""
    if os.environ.get("GOOGLE_GENAI_USE_GCA") == "true":
        return "oauth-personal"
    if os.environ.get("GOOGLE_GENAI_USE_VERTEXAI") == "true":
        return "vertex-ai"
    if os.environ.get("GEMINI_API_KEY"):
        return "gemini-api-key"
    s = read_json(SETTINGS)
    if isinstance(s, dict):
        sec = s.get("security")
        if isinstance(sec, dict):
            a = sec.get("auth")
            if isinstance(a, dict) and isinstance(a.get("selectedType"), str):
                return a["selectedType"]
    return None


def oauth2_js_candidates():
    """Where the Gemini CLI's own oauth2.js might live on this machine."""
    rels = [
        os.path.join(
            "node_modules", "@google", "gemini-cli-core",
            "dist", "src", "code_assist", "oauth2.js",
        ),
        os.path.join(
            "node_modules", "@google", "gemini-cli", "node_modules", "@google",
            "gemini-cli-core", "dist", "src", "code_assist", "oauth2.js",
        ),
    ]
    roots = []
    exe = shutil.which("gemini")
    if exe:
        p = os.path.realpath(exe)
        roots.append(os.path.dirname(p))
        roots.append(os.path.dirname(os.path.dirname(p)))
    if sys.platform == "win32":
        # fnm / nvm-windows put node (and global npm packages) under versioned dirs
        for base in (
            os.path.join(HOME, "AppData", "Roaming", "fnm", "node-versions"),
            os.path.join(HOME, "AppData", "Local", "fnm_multishells"),
            os.path.join(HOME, "AppData", "Roaming", "npm"),
        ):
            if os.path.isdir(base):
                roots.append(base)
                try:
                    for name in os.listdir(base):
                        roots.append(os.path.join(base, name))
                        roots.append(os.path.join(base, name, "installation"))
                except OSError:
                    pass
    else:
        for base in ("/usr/lib", "/usr/local/lib", os.path.join(HOME, ".nvm", "versions")):
            if os.path.isdir(base):
                roots.append(base)
    for root in roots:
        for rel in rels:
            for cand in (os.path.join(root, rel), os.path.join(root, "lib", rel)):
                if os.path.isfile(cand):
                    yield cand


def oauth_client():
    """The CLI's OAuth client id/secret -- needed only to refresh an expired token."""
    cid = os.environ.get("GEMINI_OAUTH_CLIENT_ID")
    sec = os.environ.get("GEMINI_OAUTH_CLIENT_SECRET")
    if cid and sec:
        return cid, sec
    for path in oauth2_js_candidates():
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as f:
                src = f.read()
        except OSError:
            continue
        m1 = CLIENT_ID_RE.search(src)
        m2 = CLIENT_SECRET_RE.search(src)
        if m1 and m2:
            return m1.group(1), m2.group(1)
    return None, None


def save_cred(data):
    """Atomic write -- worst case we lose a refresh, never corrupt the CLI's file."""
    try:
        tmp = CRED + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
        os.replace(tmp, CRED)
    except OSError:
        pass


def refresh(creds):
    rt = creds.get("refresh_token")
    if not rt:
        return None, "no_refresh_token"
    cid, sec = oauth_client()
    if not cid or not sec:
        return None, "no_oauth_client"
    body = urllib.parse.urlencode(
        {
            "grant_type": "refresh_token",
            "refresh_token": rt,
            "client_id": cid,
            "client_secret": sec,
        }
    ).encode()
    req = urllib.request.Request(
        TOKEN_URL,
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/x-www-form-urlencoded",
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
    creds["expiry_date"] = int(time.time() * 1000) + int(tok.get("expires_in", 3600)) * 1000
    if tok.get("refresh_token"):
        creds["refresh_token"] = tok["refresh_token"]
    if tok.get("id_token"):
        creds["id_token"] = tok["id_token"]
    save_cred(creds)
    return access, None


def access_token(creds):
    tok = creds.get("access_token")
    exp = 0
    try:
        exp = int(creds.get("expiry_date") or 0)
    except (TypeError, ValueError):
        exp = 0
    # Refresh a minute early so a slow call cannot expire mid-flight.
    if not tok or time.time() * 1000 >= exp - 60_000:
        return refresh(creds)
    return tok, None


# --- code assist ------------------------------------------------------------


def post(method, payload, token):
    req = urllib.request.Request(
        "%s:%s" % (CODE_ASSIST, method),
        data=json.dumps(payload).encode(),
        method="POST",
        headers={
            "Authorization": "Bearer %s" % token,
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": UA,
        },
    )
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read().decode())


def load_code_assist(token):
    project = (
        os.environ.get("GOOGLE_CLOUD_PROJECT")
        or os.environ.get("GOOGLE_CLOUD_PROJECT_ID")
        or None
    )
    meta = {
        "ideType": "IDE_UNSPECIFIED",
        "platform": "PLATFORM_UNSPECIFIED",
        "pluginType": "GEMINI",
    }
    if project:
        meta["duetProject"] = project
    return post(
        "loadCodeAssist",
        {"cloudaicompanionProject": project, "metadata": meta},
        token,
    )


def model_label(model_id):
    """Short, human meter names. The card already says Gemini."""
    m = str(model_id or "").lower()
    if not m:
        return "Quota"
    if "flash-lite" in m or "flashlite" in m:
        return "Lite"
    if "flash" in m:
        return "Flash"
    if "pro" in m:
        return "Pro"
    if "ultra" in m:
        return "Ultra"
    return re.sub(r"^gemini-", "", m).replace("-", " ").title()[:12]


def meters_from_buckets(buckets):
    meters = []
    seen = set()
    for b in buckets or []:
        if not isinstance(b, dict):
            continue
        frac = b.get("remainingFraction")
        if not isinstance(frac, (int, float)):
            continue
        pct = round((1.0 - float(frac)) * 100)
        pct = max(0, min(100, pct))
        label = model_label(b.get("modelId"))
        if label in seen:
            continue
        seen.add(label)
        meters.append(
            {"label": label, "usedPercent": pct, "resetsAt": b.get("resetTime")}
        )
    # Busiest first, so the tray's three-bar icon shows what actually matters.
    meters.sort(key=lambda m: m["usedPercent"], reverse=True)
    return meters


def plan_label(load_res):
    paid = load_res.get("paidTier") or {}
    cur = load_res.get("currentTier") or {}
    name = paid.get("name") or cur.get("name") or paid.get("id") or cur.get("id")
    if not name:
        return None
    s = str(name).replace("_", " ").strip()
    # "FREE_TIER" -> "Free", "Google AI Pro" stays as-is
    if s.isupper():
        s = s.title()
    s = re.sub(r"\s*Tier$", "", s).strip() or None
    if not s:
        return None
    # Tray overlay has room for short labels only ("Plus", "Pro", "SuperGrok").
    # Google's product string is "Gemini Code Assist for individuals" — truncate
    # to the product name so it fits next to the provider.
    low = s.lower()
    if "code assist" in low:
        return "Code Assist"
    if "ai ultra" in low or low == "ultra":
        return "Ultra"
    if "ai pro" in low or low == "pro" or low == "standard":
        return "Pro"
    if "ai plus" in low or low == "plus":
        return "Plus"
    if low == "free" or "free" in low:
        return "Free"
    return s


def main():
    creds = read_json(CRED)
    if not isinstance(creds, dict) or not (
        creds.get("access_token") or creds.get("refresh_token")
    ):
        kind = auth_type()
        if kind and kind != "oauth-personal":
            return out(
                {
                    "ok": False,
                    "error": "not_google_login",
                    "hint": "Gemini CLI is set to %s. Run `gemini` and choose "
                    "'Login with Google' to read your quota here." % kind,
                }
            )
        return out(
            {
                "ok": False,
                "error": "no_gemini_cli_login",
                "hint": "Run `gemini` once and sign in with Google. That writes "
                "the login this desk reads. No browser stays open.",
            }
        )

    token, err = access_token(creds)
    if not token:
        if err == "no_oauth_client":
            return out(
                {
                    "ok": False,
                    "error": err,
                    "hint": "Your Gemini login expired and the Gemini CLI could "
                    "not be found to renew it. Run `gemini` once, then refresh.",
                }
            )
        return out(
            {
                "ok": False,
                "error": err or "no_access_token",
                "hint": "Run `gemini` once to sign in again, then refresh.",
            }
        )

    try:
        load_res = load_code_assist(token)
    except urllib.error.HTTPError as e:
        hint = None
        if e.code in (401, 403):
            hint = "Google refused the saved login. Run `gemini` once to sign in again."
        return out({"ok": False, "error": "http_%d" % e.code, "hint": hint})
    except Exception as e:
        return out({"ok": False, "error": type(e).__name__})

    project = load_res.get("cloudaicompanionProject") or os.environ.get(
        "GOOGLE_CLOUD_PROJECT"
    )
    if not project:
        return out(
            {
                "ok": False,
                "error": "no_project",
                "hint": "Google did not return a Code Assist project for this "
                "account. If your account needs one, set GOOGLE_CLOUD_PROJECT.",
            }
        )

    try:
        quota = post("retrieveUserQuota", {"project": project}, token)
    except urllib.error.HTTPError as e:
        return out({"ok": False, "error": "http_%d" % e.code})
    except Exception as e:
        return out({"ok": False, "error": type(e).__name__})

    meters = meters_from_buckets(quota.get("buckets"))
    return out(
        {
            "ok": bool(meters),
            "plan": plan_label(load_res),
            "meters": meters,
            "href": "https://gemini.google.com/",
            "error": None if meters else "empty_meters",
            "hint": None
            if meters
            else "Signed in, but Google returned no quota buckets yet. "
            "Use Gemini CLI once and refresh.",
        }
    )


if __name__ == "__main__":
    sys.exit(main())
