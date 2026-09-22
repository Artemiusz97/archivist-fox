"""Pixiv OAuth Authentication Helper for Archivist Fox.

Bypasses gallery-dl's URL parsing bug (where &via=login causes a 400 Bad Request)
and automatically saves the refresh-token to both gallery-dl's persistent cache
and the project's .env file.
"""

import sys
import os
import webbrowser
import hashlib
import base64
import secrets
import sqlite3
import pickle
import urllib.parse
import urllib.request
import json

CLIENT_ID = "MOBrBDS8blbauoSck0ZfDbtuzpyT"
CLIENT_SECRET = "lsACyCD94FhDUtGTXi3QzcFE2uU1hqtDaKeqrdwj"
AUTH_TOKEN_URL = "https://oauth.secure.pixiv.net/auth/token"
REDIRECT_URI = "https://app-api.pixiv.net/web/v1/users/auth/pixiv/callback"

def generate_pkce():
    code_verifier = secrets.token_urlsafe(32)
    digest = hashlib.sha256(code_verifier.encode("ascii")).digest()
    code_challenge = base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")
    return code_verifier, code_challenge

def extract_code(raw_input: str) -> str:
    text = raw_input.strip()
    if not text:
        return ""
    if "code=" in text:
        parsed = urllib.parse.urlsplit(text if "://" in text else f"pixiv://{text}")
        qs = urllib.parse.parse_qs(parsed.query)
        if "code" in qs and qs["code"]:
            return qs["code"][0].strip()
    return text.strip()

def save_to_gallerydl_cache(refresh_token: str):
    appdata = os.environ.get("APPDATA")
    if not appdata:
        return False
    cache_db = os.path.join(appdata, "gallery-dl", "cache.sqlite3")
    if not os.path.exists(cache_db):
        os.makedirs(os.path.dirname(cache_db), exist_ok=True)
    try:
        conn = sqlite3.connect(cache_db)
        cur = conn.cursor()
        cur.execute("""
            CREATE TABLE IF NOT EXISTS data (
                key TEXT PRIMARY KEY,
                value BLOB,
                expires INTEGER
            )
        """)
        pickled_val = pickle.dumps(refresh_token)
        cur.execute("""
            INSERT OR REPLACE INTO data (key, value, expires)
            VALUES (?, ?, ?)
        """, ("gallery_dl.extractor.pixiv._refresh_token_cache-None", pickled_val, 0))
        conn.commit()
        conn.close()
        return True
    except Exception as e:
        print(f"[warning] Could not save to gallery-dl cache: {e}")
        return False

def save_to_env(refresh_token: str):
    env_path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env")
    if not os.path.exists(env_path):
        return False
    try:
        with open(env_path, "r", encoding="utf-8") as f:
            lines = f.readlines()
        found = False
        new_lines = []
        for line in lines:
            if line.startswith("PIXIV_REFRESH_TOKEN="):
                new_lines.append(f"PIXIV_REFRESH_TOKEN={refresh_token}\n")
                found = True
            else:
                new_lines.append(line)
        if not found:
            new_lines.append(f"\nPIXIV_REFRESH_TOKEN={refresh_token}\n")
        with open(env_path, "w", encoding="utf-8") as f:
            f.writelines(new_lines)
        return True
    except Exception as e:
        print(f"[warning] Could not save to .env: {e}")
        return False

def main():
    print("=" * 70)
    print("           ARCHIVIST FOX - PIXIV LOGIN SETUP HELPER")
    print("=" * 70)
    print("This helper connects your Pixiv account so the bot can download artwork.")
    print("Detailed guide available in: PIXIV_LOGIN_GUIDE.txt\n")
    
    code_verifier, code_challenge = generate_pkce()
    login_url = (
        f"https://app-api.pixiv.net/web/v1/login"
        f"?client=pixiv-android&code_challenge_method=S256&code_challenge={code_challenge}"
    )

    print("-" * 70)
    print("STEP 1: A browser window is opening to the Pixiv login page...")
    print(f"URL: {login_url}")
    print("-" * 70)
    try:
        webbrowser.open(login_url)
    except Exception:
        pass

    print("""
STEP 2: IN YOUR BROWSER (BEFORE LOGGING IN):
  * Press F12 (or right-click anywhere on the page -> Inspect).
  * Click on the "Network" tab at the top of the developer panel.
  * (Optional tip: check "Preserve log" / "Persist Logs" so entries stay).

STEP 3: LOG IN TO PIXIV:
  * Click your account to continue, or enter your username/password.

STEP 4: FIND & COPY THE CALLBACK LINK:
  * In the "Network" tab, type "callback" in the Filter search box.
  * Right-click the entry ("callback?state=..." or "login?code=...")
    and select: Copy -> Copy URL (or "Copy link address").
  * (OR if your browser address bar shows the pixiv:// link, copy that!)

----------------------------------------------------------------------
PASTE WHAT YOU COPIED BELOW (Full URL, code=..., or just the code):
----------------------------------------------------------------------""")

    user_input = input("\nPaste here and press Enter: ").strip()
    code = extract_code(user_input)

    if not code:
        print("\n[error] No code could be extracted from your input. Please try again.")
        sys.exit(1)

    print(f"\n[info] Exchanging code for refresh token...")

    post_data = urllib.parse.urlencode({
        "client_id": CLIENT_ID,
        "client_secret": CLIENT_SECRET,
        "code": code,
        "code_verifier": code_verifier,
        "grant_type": "authorization_code",
        "include_policy": "true",
        "redirect_uri": REDIRECT_URI,
    }).encode("utf-8")

    req = urllib.request.Request(
        AUTH_TOKEN_URL,
        data=post_data,
        headers={
            "User-Agent": "PixivAndroidApp/5.0.234 (Android 11; Pixel 5)",
            "Content-Type": "application/x-www-form-urlencoded",
        }
    )

    try:
        with urllib.request.urlopen(req) as resp:
            resp_data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        err_body = e.read().decode("utf-8", errors="replace")
        print(f"\n[error] Authentication failed ({e.code}): {err_body}")
        print("Note: Pixiv codes expire within 30 seconds. Run the script again to retry.")
        sys.exit(1)
    except Exception as e:
        print(f"\n[error] Request failed: {e}")
        sys.exit(1)

    refresh_token = resp_data.get("refresh_token")
    if not refresh_token:
        print(f"\n[error] No refresh_token returned by Pixiv: {resp_data}")
        sys.exit(1)

    user_info = resp_data.get("user", {})
    username = user_info.get("name") or user_info.get("account") or "Unknown"

    print("\n" + "=" * 60)
    print(f"[success] Logged in as Pixiv user: {username}")
    print(f"[success] Refresh token: {refresh_token}")
    print("=" * 60)

    saved_cache = save_to_gallerydl_cache(refresh_token)
    if saved_cache:
        print("[success] Saved to gallery-dl cache (cache.sqlite3)")

    saved_env = save_to_env(refresh_token)
    if saved_env:
        print("[success] Saved to .env (PIXIV_REFRESH_TOKEN)")

    print("\nSetup is complete! You can now download Pixiv artworks with Archivist Fox.")

if __name__ == "__main__":
    main()
