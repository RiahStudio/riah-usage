#!/usr/bin/env python3
"""Pull GitHub Copilot quota. Prints JSON only — never prints tokens.

Reads a token Copilot / gh already left on disk, then calls
GET https://api.github.com/copilot_internal/user
"""
import json
import os
import re
import sys
import urllib.error
import urllib.request

HOME = os.path.expanduser("~")
LOCAL = os.environ.get("LOCALAPPDATA", "")
APPDATA = os.environ.get("APPDATA", "")


def try_json(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def token_from_apps(obj):
    """github-copilot apps.json / hosts.json shapes vary by editor version."""
    if not isinstance(obj, dict):
        return None
    # Flat: { "github.com": { "oauth_token": "..." } }
    for host in ("github.com", "Github.com"):
        block = obj.get(host)
        if isinstance(block, dict):
            for k in ("oauth_token", "token", "access_token"):
                if block.get(k):
                    return str(block[k]).strip()
    # Nested apps: { "github.com:Iv1....": { "user": "...", "oauth_token": "..." } }
    for key, block in obj.items():
        if not isinstance(block, dict):
            continue
        for k in ("oauth_token", "token", "access_token"):
            if block.get(k):
                return str(block[k]).strip()
    return None


def token_from_gh_yml(path):
    try:
        text = open(path, "r", encoding="utf-8").read()
    except Exception:
        return None
    # Minimal YAML scrape — gh hosts.yml is small and predictable.
    m = re.search(
        r"(?ms)^github\.com:\s*.*?(?:oauth_token|oauth-token):\s*(\S+)",
        text,
    )
    if m:
        return m.group(1).strip().strip("\"'")
    m = re.search(r"(?m)^\s*oauth_token:\s*(\S+)", text)
    if m:
        return m.group(1).strip().strip("\"'")
    return None


def discover_token():
    for var in (
        "GITHUB_COPILOT_GITHUB_TOKEN",
        "COPILOT_GITHUB_TOKEN",
        "GITHUB_COPILOT_API_TOKEN",
        "GITHUB_TOKEN",
    ):
        v = (os.environ.get(var) or "").strip()
        if v:
            return v, "env"

    candidates = []
    for base in (
        os.path.join(HOME, ".config", "github-copilot"),
        os.path.join(HOME, "Library", "Application Support", "github-copilot"),
        os.path.join(HOME, "AppData", "Local", "github-copilot"),
        os.path.join(LOCAL, "github-copilot"),
        os.path.join(APPDATA, "GitHub Copilot"),
    ):
        candidates.append(os.path.join(base, "apps.json"))
        candidates.append(os.path.join(base, "hosts.json"))

    for path in candidates:
        if not os.path.isfile(path):
            continue
        tok = token_from_apps(try_json(path))
        if tok:
            return tok, path

    for path in (
        os.path.join(HOME, ".config", "gh", "hosts.yml"),
        os.path.join(HOME, "Library", "Application Support", "GitHub CLI", "hosts.yml"),
        os.path.join(APPDATA, "GitHub CLI", "hosts.yml"),
    ):
        if not os.path.isfile(path):
            continue
        tok = token_from_gh_yml(path)
        if tok:
            return tok, path

    return None, None


def used_pct(snap):
    if not isinstance(snap, dict):
        return None
    if snap.get("unlimited"):
        return None
    pr = snap.get("percent_remaining")
    if pr is not None:
        try:
            return max(0.0, min(100.0, 100.0 - float(pr)))
        except Exception:
            pass
    ent = snap.get("entitlement")
    rem = snap.get("remaining")
    if rem is None:
        rem = snap.get("quota_remaining")
    try:
        ent = float(ent)
        rem = float(rem)
    except Exception:
        return None
    if ent <= 0:
        return None
    return max(0.0, min(100.0, 100.0 * (ent - rem) / ent))


def plan_label(raw):
    if not raw:
        return None
    s = str(raw).strip().lower().replace("_", " ")
    if s in ("individual", "pro", "copilot pro"):
        return "Pro"
    if "pro+" in s or "pro plus" in s:
        return "Pro+"
    if "business" in s:
        return "Business"
    if "enterprise" in s:
        return "Enterprise"
    if s in ("free", "copilot free"):
        return "Free"
    return str(raw).strip()


def main():
    token, src = discover_token()
    if not token:
        print(json.dumps({"ok": False, "error": "no_token"}))
        return 0

    req = urllib.request.Request(
        "https://api.github.com/copilot_internal/user",
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            "User-Agent": "RiahUsage/1.0",
            "X-GitHub-Api-Version": "2025-04-01",
            "Editor-Version": "vscode/1.90.0",
            "Editor-Plugin-Version": "copilot/1.0.0",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            data = json.loads(r.read().decode("utf-8", "ignore"))
    except urllib.error.HTTPError as e:
        body = ""
        try:
            body = e.read().decode("utf-8", "ignore")[:200]
        except Exception:
            pass
        print(
            json.dumps(
                {
                    "ok": False,
                    "error": f"http_{e.code}",
                    "detail": body,
                    "token_source": "found" if src else None,
                }
            )
        )
        return 0
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)[:120]}))
        return 0

    snaps = data.get("quota_snapshots") or {}
    resets = data.get("quota_reset_date_utc") or data.get("quota_reset_date")
    meters = []

    # Prefer AI credits / premium when present (2026 billing).
    label_map = (
        ("premium_interactions", "Credits"),
        ("chat", "Chat"),
        ("completions", "Completions"),
    )
    # Some responses nest a dedicated credits bucket
    for key, label in (
        ("ai_credits", "Credits"),
        ("credits", "Credits"),
        ("premium_interactions", "Credits"),
    ):
        if key in snaps and used_pct(snaps[key]) is not None:
            label_map = ((key, "Credits"),) + tuple(
                (k, lab) for k, lab in label_map if k != key and lab != "Credits"
            )
            break

    seen = set()
    for key, label in label_map:
        if key in seen or key not in snaps:
            continue
        seen.add(key)
        pct = used_pct(snaps[key])
        if pct is None:
            continue
        meters.append(
            {
                "label": label,
                "usedPercent": round(pct),
                "resetsAt": resets,
            }
        )

    plan = plan_label(data.get("copilot_plan") or data.get("access_type_sku"))
    out = {
        "ok": True,
        "plan": plan,
        "login": data.get("login"),
        "meters": meters,
        "raw_keys": sorted(list(snaps.keys())),
    }
    if not meters:
        out["ok"] = bool(plan)
        out["error"] = "no_quota_meters"
        out["note"] = "Org seat or unlimited plan — no personal percent meters."
    print(json.dumps(out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
