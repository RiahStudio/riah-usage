#!/usr/bin/env python3
"""Pull Cursor plan usage. Prints JSON only — never prints tokens."""
import json
import os
import sqlite3
import sys
import urllib.error
import urllib.request

def state_db_candidates():
    """Cursor's login DB — Windows %APPDATA%, macOS Library, Linux ~/.config."""
    home = os.path.expanduser("~")
    appdata = os.environ.get("APPDATA") or ""
    local = os.environ.get("LOCALAPPDATA") or ""
    rel = os.path.join("Cursor", "User", "globalStorage", "state.vscdb")
    return [
        os.path.join(appdata, rel) if appdata else "",
        os.path.join(local, rel) if local else "",
        os.path.join(home, "Library", "Application Support", rel),
        os.path.join(home, ".config", rel),
    ]


def find_state_db():
    for p in state_db_candidates():
        if p and os.path.exists(p):
            return p
    return None


def main():
    db = find_state_db()
    if not db:
        print(json.dumps({"ok": False, "error": "no_db"}))
        return 0

    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    cur = con.cursor()
    row = cur.execute(
        "SELECT value FROM ItemTable WHERE key = ?",
        ("cursorAuth/accessToken",),
    ).fetchone()
    con.close()
    if not row or not row[0]:
        print(json.dumps({"ok": False, "error": "no_token"}))
        return 0

    token = row[0] if isinstance(row[0], str) else row[0].decode("utf-8", "ignore")

    def get(url):
        req = urllib.request.Request(
            url,
            headers={
                "Authorization": f"Bearer {token}",
                "Accept": "application/json",
                "User-Agent": "RiahUsage/1.0",
            },
        )
        with urllib.request.urlopen(req, timeout=20) as r:
            return json.loads(r.read().decode())

    def post(url, body=None):
        data = json.dumps(body or {}).encode()
        req = urllib.request.Request(
            url,
            data=data,
            method="POST",
            headers={
                "Authorization": f"Bearer {token}",
                "Accept": "application/json",
                "Content-Type": "application/json",
                "User-Agent": "RiahUsage/1.0",
            },
        )
        with urllib.request.urlopen(req, timeout=20) as r:
            return json.loads(r.read().decode())

    out = {"ok": True, "sources": {}, "plan": None}

    # Plan name from local Cursor login (no network)
    try:
        con2 = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
        row2 = con2.cursor().execute(
            "SELECT value FROM ItemTable WHERE key = ?",
            ("cursorAuth/stripeMembershipType",),
        ).fetchone()
        con2.close()
        if row2 and row2[0]:
            out["plan"] = str(row2[0])
    except Exception:
        pass

    try:
        out["sources"]["auth_usage"] = get("https://api2.cursor.sh/auth/usage")
    except Exception as e:
        out["sources"]["auth_usage_error"] = str(e)[:120]

    try:
        out["sources"]["usage_summary"] = get("https://cursor.com/api/usage-summary")
    except Exception as e:
        out["sources"]["usage_summary_error"] = str(e)[:120]

    try:
        plan_info = post(
            "https://api2.cursor.sh/aiserver.v1.DashboardService/GetPlanInfo", {}
        )
        out["sources"]["plan_info"] = plan_info
        name = (plan_info.get("planInfo") or {}).get("planName")
        if name:
            out["plan"] = name
    except Exception as e:
        out["sources"]["plan_info_error"] = str(e)[:120]

    # Newer period usage (Connect RPC style path varies; try common ones)
    for url in (
        "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage",
        "https://cursor.com/api/dashboard/get-current-period-usage",
    ):
        try:
            out["sources"]["period"] = post(url, {})
            out["sources"]["period_url"] = url
            break
        except Exception as e:
            out["sources"]["period_error"] = str(e)[:120]

    print(json.dumps(out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
