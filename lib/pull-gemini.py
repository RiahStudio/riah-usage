#!/usr/bin/env python3
"""Pull Gemini Apps usage from gemini.google.com (Current + Weekly).

Uses the same batchexecute RPC the Usage limits page calls (VxUbXb).
Auth = Google cookies from whichever browsers are installed on this machine.
Never prints cookie values or tokens.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

LOCAL = os.environ.get("LOCALAPPDATA", "")

USAGE_RPC = "VxUbXb"
USAGE_URL = "https://gemini.google.com/usage"
BATCH_URL = "https://gemini.google.com/_/BardChatUi/data/batchexecute"
UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/138.0.0.0 Safari/537.36"
)

def chromium_cookie_candidates():
    """Every Default / Profile * cookies DB we can find, across all browsers."""
    roots = [
        ("brave", Path(LOCAL) / "BraveSoftware/Brave-Browser/User Data"),
        ("chrome", Path(LOCAL) / "Google/Chrome/User Data"),
        ("edge", Path(LOCAL) / "Microsoft/Edge/User Data"),
    ]
    out = []
    for brand, root in roots:
        if not root.exists():
            continue
        state = root / "Local State"
        for child in sorted(root.iterdir(), key=lambda p: (p.name != "Default", p.name)):
            if not child.is_dir():
                continue
            if child.name != "Default" and not child.name.startswith("Profile"):
                continue
            cookie = child / "Network" / "Cookies"
            if not cookie.exists():
                cookie = child / "Cookies"
            if cookie.exists():
                label = brand if child.name == "Default" else f"{brand}:{child.name}"
                out.append((label, cookie, state))
    return out


COOKIE_CANDIDATES = chromium_cookie_candidates()


def out(obj: dict) -> int:
    print(json.dumps(obj, ensure_ascii=False))
    return 0


def copy_cookies_db(src: Path) -> Path | None:
    if not src.exists():
        return None
    td = Path(tempfile.mkdtemp(prefix="riah-gem-cookies-"))
    dst = td / "Cookies"

    def _ok() -> bool:
        return dst.exists() and dst.stat().st_size > 0

    # 1) Plain copy (works if browser is closed)
    try:
        shutil.copy2(src, dst)
        if _ok():
            return dst
    except Exception:
        pass

    # 2) Win32 CreateFile with full share (browsers often lock the DB otherwise)
    try:
        import ctypes
        from ctypes import wintypes

        GENERIC_READ = 0x80000000
        FILE_SHARE_ALL = 0x7
        OPEN_EXISTING = 3
        FILE_ATTRIBUTE_NORMAL = 0x80
        INVALID = ctypes.c_void_p(-1).value

        CreateFileW = ctypes.windll.kernel32.CreateFileW
        CreateFileW.argtypes = [
            wintypes.LPCWSTR,
            wintypes.DWORD,
            wintypes.DWORD,
            wintypes.LPVOID,
            wintypes.DWORD,
            wintypes.DWORD,
            wintypes.HANDLE,
        ]
        CreateFileW.restype = wintypes.HANDLE
        ReadFile = ctypes.windll.kernel32.ReadFile
        CloseHandle = ctypes.windll.kernel32.CloseHandle
        GetFileSizeEx = ctypes.windll.kernel32.GetFileSizeEx

        handle = CreateFileW(
            str(src),
            GENERIC_READ,
            FILE_SHARE_ALL,
            None,
            OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL,
            None,
        )
        if handle and handle != INVALID:
            size = ctypes.c_ulonglong(0)
            if GetFileSizeEx(handle, ctypes.byref(size)) and size.value > 0:
                buf = (ctypes.c_char * size.value)()
                read = wintypes.DWORD(0)
                if ReadFile(handle, buf, size.value, ctypes.byref(read), None):
                    dst.write_bytes(bytes(buf[: read.value]))
            CloseHandle(handle)
            if _ok():
                return dst
    except Exception:
        pass

    # 3) PowerShell FileShare.ReadWrite stream copy
    try:
        ps = (
            "$src = '"
            + str(src).replace("'", "''")
            + "'; $dst = '"
            + str(dst).replace("'", "''")
            + "'; "
            "$fs = [System.IO.File]::Open($src, [System.IO.FileMode]::Open, "
            "[System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite); "
            "$out = [System.IO.File]::Create($dst); $fs.CopyTo($out); "
            "$out.Close(); $fs.Close()"
        )
        subprocess.run(
            ["powershell", "-NoProfile", "-Command", ps],
            capture_output=True,
            text=True,
            timeout=45,
            check=False,
        )
        if _ok():
            return dst
    except Exception:
        pass

    # 4) esentutl backup copy
    try:
        subprocess.run(
            ["esentutl", "/y", str(src), "/d", str(dst), "/o"],
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
        if _ok():
            return dst
    except Exception:
        pass

    shutil.rmtree(td, ignore_errors=True)
    return None


def try_sqlite_readonly_cookies(cookie_db: Path, local_state: Path):
    """Open the live Cookies DB read-only (no copy) when the browser holds a lock."""
    if not cookie_db.exists() or not local_state.exists():
        return None
    uri = cookie_db.resolve().as_uri() + "?mode=ro&immutable=1"
    tmp = None
    try:
        # decrypt_chromium_cookies expects a Path to a sqlite file — copy via dump if needed
        con = sqlite3.connect(uri, uri=True, timeout=3)
        rows = con.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='cookies'"
        ).fetchone()
        con.close()
        if not rows:
            return None
        # Materialize a temp copy using the readonly connection + SQL dump of needed rows
        td = Path(tempfile.mkdtemp(prefix="riah-gem-ro-"))
        tmp = td / "Cookies"
        src = sqlite3.connect(uri, uri=True, timeout=3)
        dst = sqlite3.connect(str(tmp))
        src.backup(dst)
        dst.close()
        src.close()
        cookies = decrypt_chromium_cookies(tmp, local_state)
        shutil.rmtree(td, ignore_errors=True)
        return cookies
    except Exception:
        if tmp is not None:
            shutil.rmtree(tmp.parent, ignore_errors=True)
        return None


def iter_browser_cookie3_sources():
    """Yield (cookies, label) for every browser that has Google auth cookies.

    Important: do NOT stop at the first browser. Firefox may be signed into a
    free Google account while another browser has the paid one you actually use.
    """
    try:
        import browser_cookie3 as bc
    except Exception:
        return

    for label, fn in (
        ("brave", getattr(bc, "brave", None)),
        ("chrome", getattr(bc, "chrome", None)),
        ("edge", getattr(bc, "edge", None)),
        ("firefox", getattr(bc, "firefox", None)),
    ):
        if not callable(fn):
            continue
        try:
            cookies = list(fn(domain_name=".google.com"))
            if any(
                c.name in ("SAPISID", "__Secure-1PSID", "__Secure-3PSID", "SID")
                for c in cookies
            ):
                yield cookies, label
        except Exception:
            continue


def load_google_cookies_via_browser_cookie3():
    """Back-compat: first browser source found with auth cookies."""
    for cookies, label in iter_browser_cookie3_sources():
        return cookies, label, None
    return None, None, "no_browser_cookie3_or_empty"


def _dpapi_unprotect(raw: bytes) -> bytes:
    import ctypes
    from ctypes import wintypes

    class DATA_BLOB(ctypes.Structure):
        _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_char))]

    blob_in = DATA_BLOB(len(raw), ctypes.create_string_buffer(raw, len(raw)))
    blob_out = DATA_BLOB()
    if not ctypes.windll.crypt32.CryptUnprotectData(
        ctypes.byref(blob_in), None, None, None, None, 0, ctypes.byref(blob_out)
    ):
        raise OSError("CryptUnprotectData failed")
    try:
        return ctypes.string_at(blob_out.pbData, blob_out.cbData)
    finally:
        ctypes.windll.kernel32.LocalFree(blob_out.pbData)


def decrypt_chromium_cookies(cookie_db: Path, local_state: Path):
    try:
        import base64

        from Cryptodome.Cipher import AES
    except Exception:
        return None

    try:
        state = json.loads(local_state.read_text(encoding="utf-8"))
        enc_key_b64 = state.get("os_crypt", {}).get("encrypted_key")
        if not enc_key_b64:
            return None
        enc_key = base64.b64decode(enc_key_b64)
        if enc_key.startswith(b"DPAPI"):
            enc_key = enc_key[5:]
        master = _dpapi_unprotect(enc_key)
    except Exception:
        return None

    def decrypt_value(encrypted: bytes) -> str:
        if not encrypted:
            return ""
        try:
            if encrypted.startswith(b"v10") or encrypted.startswith(b"v20"):
                nonce = encrypted[3:15]
                ciphertext = encrypted[15:-16]
                tag = encrypted[-16:]
                cipher = AES.new(master, AES.MODE_GCM, nonce=nonce)
                return cipher.decrypt_and_verify(ciphertext, tag).decode("utf-8", "ignore")
            return _dpapi_unprotect(encrypted).decode("utf-8", "ignore")
        except Exception:
            return ""

    con = sqlite3.connect(str(cookie_db))
    try:
        try:
            rows = con.execute(
                "SELECT host_key, name, encrypted_value, path, is_secure "
                "FROM cookies WHERE host_key LIKE '%google%' OR host_key LIKE '%gemini%'"
            ).fetchall()
            use_encrypted = True
        except sqlite3.Error:
            rows = con.execute(
                "SELECT host_key, name, value, path, is_secure "
                "FROM cookies WHERE host_key LIKE '%google%'"
            ).fetchall()
            use_encrypted = False

        cookies = []
        for host, name, val, path, secure in rows:
            if use_encrypted:
                value = decrypt_value(val or b"")
            else:
                value = val or ""
            if not value:
                continue
            cookies.append(
                {
                    "name": name,
                    "value": value,
                    "domain": host,
                    "path": path or "/",
                    "secure": bool(secure),
                }
            )
        return cookies
    finally:
        con.close()


def iter_cookies_from_copied_dbs():
    for label, cookie_path, state_path in chromium_cookie_candidates():
        if not cookie_path.exists():
            continue
        cookies = None
        copied = copy_cookies_db(cookie_path)
        if copied and state_path.exists():
            try:
                cookies = decrypt_chromium_cookies(copied, state_path)
            finally:
                shutil.rmtree(copied.parent, ignore_errors=True)
        if not cookies:
            cookies = try_sqlite_readonly_cookies(cookie_path, state_path)
        if cookies and any(
            c["name"] in ("SAPISID", "__Secure-1PSID", "__Secure-3PSID", "SID")
            for c in cookies
        ):
            yield cookies, label


def load_cookies_from_copied_dbs():
    locked = []
    for label, cookie_path, state_path in chromium_cookie_candidates():
        if not cookie_path.exists():
            continue
        copied = copy_cookies_db(cookie_path)
        if not copied:
            locked.append(label)
            continue
        if not state_path.exists():
            shutil.rmtree(copied.parent, ignore_errors=True)
            continue
        cookies = decrypt_chromium_cookies(copied, state_path)
        shutil.rmtree(copied.parent, ignore_errors=True)
        if cookies and any(
            c["name"] in ("SAPISID", "__Secure-1PSID", "__Secure-3PSID", "SID")
            for c in cookies
        ):
            return cookies, label, None
    if locked:
        return None, None, "cookies_locked:" + ",".join(locked)
    return None, None, "no_browser_cookies"


def cookie_header(cookies) -> str:
    parts = []
    seen = set()
    for c in cookies:
        if isinstance(c, dict):
            name, value = c.get("name"), c.get("value")
        else:
            name, value = getattr(c, "name", None), getattr(c, "value", None)
        if not name or value is None or name in seen:
            continue
        seen.add(name)
        parts.append(f"{name}={value}")
    return "; ".join(parts)


def http_get(url: str, cookie: str) -> str:
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": UA,
            "Cookie": cookie,
            "Accept": "text/html,application/xhtml+xml",
        },
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read().decode("utf-8", "ignore")


def http_post_form(url: str, cookie: str, form: dict) -> str:
    data = urllib.parse.urlencode(form).encode()
    req = urllib.request.Request(
        url,
        data=data,
        method="POST",
        headers={
            "User-Agent": UA,
            "Cookie": cookie,
            "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
            "Origin": "https://gemini.google.com",
            "Referer": "https://gemini.google.com/usage",
            "X-Same-Domain": "1",
            "Accept": "*/*",
        },
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read().decode("utf-8", "ignore")


def extract_session(html: str):
    at = None
    m = re.search(r'"SNlM0e":"([^"]+)"', html)
    if m:
        at = m.group(1)
    bl = None
    m = re.search(r'boq_assistant-bard-web-server_[^"\\]+', html)
    if m:
        bl = m.group(0)
    sid = None
    m = re.search(r'"FdrFJe":"([^"]+)"', html)
    if m:
        sid = m.group(1)
    return at, bl, sid


def parse_batchexecute_payload(text: str, rpc_id: str):
    m = re.search(
        rf'\["wrb\.fr","{re.escape(rpc_id)}","((?:\\.|[^"\\])*)"',
        text,
    )
    if not m:
        return None
    raw = m.group(1)
    try:
        s = json.loads('"' + raw + '"')
        return json.loads(s)
    except Exception:
        try:
            s = bytes(raw, "utf-8").decode("unicode_escape")
            return json.loads(s)
        except Exception:
            return None


def ts_to_iso(pair):
    if not isinstance(pair, (list, tuple)) or not pair:
        return None
    try:
        sec = int(pair[0])
        nano = int(pair[1]) if len(pair) > 1 and pair[1] is not None else 0
        dt = datetime.fromtimestamp(sec + nano / 1e9, tz=timezone.utc)
        return dt.strftime("%Y-%m-%dT%H:%M:%SZ")
    except Exception:
        return None


def remaining_to_used(remaining):
    try:
        rem = float(remaining)
        if rem > 1.0 and rem <= 100:
            return round(max(0, min(100, 100.0 - rem)))
        return round(max(0, min(100, (1.0 - rem) * 100.0)))
    except Exception:
        return None


def plan_from_code(code) -> str | None:
    try:
        n = int(code)
    except Exception:
        return None
    return {0: "Free", 1: "Plus", 2: "Pro", 3: "Ultra", 4: "Ultra"}.get(n)


def plan_from_html(html: str) -> str | None:
    # Upsell to Plus without a PLUS badge → Free
    if "Get 2x more usage with AI Plus" in html or "Get Google AI Plus" in html:
        if re.search(r">\s*PLUS\s*<", html) or re.search(r'"PLUS"', html):
            return "Plus"
        return "Free"
    if re.search(r">\s*ULTRA\s*<", html):
        return "Ultra"
    if re.search(r">\s*PRO\s*<", html):
        return "Pro"
    if re.search(r">\s*PLUS\s*<", html) or re.search(r"\bPLUS\b", html):
        return "Plus"
    return None


def meters_from_vx(payload):
    """
    VxUbXb shape (observed 2026-07-17):
    [null, null, [
       [5,  [sec,nano], flag, "Limit resets {REFILL_TIME}", [remainingFraction]],
       [27, [sec,nano], flag, "Limit resets {REFILL_TIME}", [remainingFraction]]
     ], planCode, [sec,nano]]
    Window 5 ≈ current / ~5-hour; 27 ≈ weekly.
    """
    meters = []
    plan = None
    if not isinstance(payload, list) or len(payload) < 3:
        return meters, plan

    buckets = payload[2]
    if len(payload) >= 4 and payload[3] is not None:
        plan = plan_from_code(payload[3])

    if not isinstance(buckets, list):
        return meters, plan

    for b in buckets:
        if not isinstance(b, list) or len(b) < 2:
            continue
        win = b[0]
        resets = ts_to_iso(b[1]) if isinstance(b[1], list) else None
        remaining = None
        for cell in reversed(b):
            if isinstance(cell, list) and cell and isinstance(cell[0], (int, float)):
                remaining = cell[0]
                break
        used = remaining_to_used(remaining) if remaining is not None else None
        if used is None:
            continue
        if win in (5, "5"):
            label = "Current usage"
        elif win in (27, "27"):
            label = "Weekly limit"
        else:
            label = f"Limit {win}"
        meters.append({"label": label, "usedPercent": used, "resetsAt": resets})

    order = {"Current usage": 0, "Weekly limit": 1}
    meters.sort(key=lambda m: order.get(m["label"], 9))
    return meters, plan


def meters_from_html(html: str):
    """Fallback when the RPC shape drifts — scrape the Usage page text."""
    # Strip tags lightly so "% used" pairs survive.
    text = re.sub(r"<script[\s\S]*?</script>", " ", html, flags=re.I)
    text = re.sub(r"<style[\s\S]*?</style>", " ", text, flags=re.I)
    text = re.sub(r"<[^>]+>", "\n", text)
    text = re.sub(r"[ \t]+", " ", text)

    meters = []
    cur = re.search(r"Current usage[\s\S]{0,400}?(\d+)\s*%\s*used", text, re.I)
    if cur:
        meters.append(
            {
                "label": "Current usage",
                "usedPercent": int(cur.group(1)),
                "resetsAt": None,
            }
        )
    wk = re.search(r"Weekly limit[\s\S]{0,400}?(\d+)\s*%\s*used", text, re.I)
    if wk:
        meters.append(
            {
                "label": "Weekly limit",
                "usedPercent": int(wk.group(1)),
                "resetsAt": None,
            }
        )
    if not meters:
        all_pct = [int(x) for x in re.findall(r"(\d+)\s*%\s*used", text, re.I)]
        if len(all_pct) >= 2:
            meters = [
                {"label": "Current usage", "usedPercent": all_pct[0], "resetsAt": None},
                {"label": "Weekly limit", "usedPercent": all_pct[1], "resetsAt": None},
            ]
        elif len(all_pct) == 1:
            meters = [
                {"label": "Current usage", "usedPercent": all_pct[0], "resetsAt": None}
            ]
    return meters


def plan_rank(plan: str | None) -> int:
    if not plan:
        return 0
    p = plan.lower()
    if "ultra" in p:
        return 4
    if "pro" in p:
        return 3
    if "plus" in p:
        return 2
    if "free" in p:
        return 1
    return 0


def pull_with_cookies(cookies, source: str):
    header = cookie_header(cookies)
    authish = ("SID" in header) or ("PSID" in header) or ("SAPISID" in header)
    if not header or not authish:
        return {"ok": False, "error": "no_google_auth_cookies", "source": source}

    try:
        html = http_get(USAGE_URL, header)
    except urllib.error.HTTPError as e:
        return {"ok": False, "error": f"http_{e.code}", "source": source}
    except Exception as e:
        return {"ok": False, "error": type(e).__name__, "source": source}

    if "accounts.google.com" in html[:2000] and "SNlM0e" not in html:
        return {"ok": False, "error": "login_required", "source": source}

    plan = plan_from_html(html)
    meters = []
    plan_code = None

    at, bl, sid = extract_session(html)
    if at:
        bl = bl or "boq_assistant-bard-web-server_20260715.16_p0"
        params = {
            "rpcids": USAGE_RPC,
            "source-path": "/usage",
            "bl": bl,
            "hl": "en",
            "_reqid": str(int(time.time() * 1000) % 10000000),
            "rt": "c",
        }
        if sid:
            params["f.sid"] = sid
        url = BATCH_URL + "?" + urllib.parse.urlencode(params)
        form = {
            "at": at,
            "f.req": json.dumps([[[USAGE_RPC, "[]", None, "generic"]]]),
        }
        try:
            body = http_post_form(url, header, form)
            payload = parse_batchexecute_payload(body, USAGE_RPC)
            if payload is not None:
                meters, plan_code = meters_from_vx(payload)
                if not plan:
                    plan = plan_code
        except Exception:
            pass

    if not meters:
        meters = meters_from_html(html)
        if meters and not plan:
            plan = plan_from_html(html)

    if not meters:
        return {
            "ok": False,
            "error": "no_meters",
            "source": source,
            "plan": plan,
        }

    return {
        "ok": True,
        "meters": meters,
        "plan": plan or plan_code,
        "source": source,
        "href": "https://gemini.google.com/usage",
    }


def load_bridge_snapshot():
    """Optional local bridge written by a same-machine helper (never committed)."""
    path = Path(__file__).resolve().parent.parent / "scratch" / "gemini-bridge.json"
    if not path.exists():
        return None
    try:
        age = time.time() - path.stat().st_mtime
        if age > 12 * 60 * 60:
            return None
        data = json.loads(path.read_text(encoding="utf-8"))
        if data.get("ok") and data.get("meters"):
            data = dict(data)
            data["source"] = data.get("source") or "bridge"
            data["href"] = data.get("href") or "https://gemini.google.com/usage"
            return data
    except Exception:
        return None
    return None


def main():
    # Try EVERY signed-in browser/profile -- one may be free while another is paid.
    attempts = []
    best = None

    sources = []
    for cookies, label in iter_browser_cookie3_sources():
        sources.append((cookies, label))
    for cookies, label in iter_cookies_from_copied_dbs():
        sources.append((cookies, "db:" + label))

    for cookies, source in sources:
        result = pull_with_cookies(cookies, source or "browser")
        attempts.append(f"{source}:{result.get('error') or 'ok'}:{result.get('plan') or '-'}")
        if not (result.get("ok") and result.get("meters")):
            continue
        if best is None or plan_rank(result.get("plan")) > plan_rank(best.get("plan")):
            best = result
        # Prefer a paid plan as soon as we see one.
        if plan_rank(result.get("plan")) >= 2:
            return out(result)

    if best:
        return out(best)

    bridge = load_bridge_snapshot()
    if bridge:
        return out(bridge)

    return out(
        {
            "ok": False,
            "error": "no_meters" if attempts else "no_browser_cookies",
            "tried": attempts[:12],
            "href": "https://gemini.google.com/usage",
        }
    )


if __name__ == "__main__":
    sys.exit(main() or 0)
