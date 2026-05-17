"""Check if authenticated OpenSky returns category data."""
import json
import os
import urllib.parse
import urllib.request


def load_env_file(path):
    try:
        with open(path, encoding="utf-8") as env_file:
            for line in env_file:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, value = line.split("=", 1)
                os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))
    except FileNotFoundError:
        pass


load_env_file(".env.local")
load_env_file("backend/.env")

client_id = os.environ.get("OPENSKY_CLIENT_ID", "")
client_secret = os.environ.get("OPENSKY_CLIENT_SECRET", "")

if not client_id or not client_secret:
    raise SystemExit("Missing OPENSKY_CLIENT_ID or OPENSKY_CLIENT_SECRET")

# Get token
token_url = "https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token"
data = urllib.parse.urlencode({
    "grant_type": "client_credentials",
    "client_id": client_id,
    "client_secret": client_secret,
}).encode()
req = urllib.request.Request(token_url, data=data, headers={"Content-Type": "application/x-www-form-urlencoded"})

try:
    r = urllib.request.urlopen(req, timeout=10)
    token_data = json.loads(r.read())
    token = token_data["access_token"]
    print(f"Got token (expires in {token_data.get('expires_in')}s)")

    # Fetch states with token
    states_url = "https://opensky-network.org/api/states/all?extended=1"
    req2 = urllib.request.Request(states_url, headers={
        "Accept": "application/json",
        "Authorization": f"Bearer {token}"
    })
    r2 = urllib.request.urlopen(req2, timeout=30)
    d = json.loads(r2.read())
    states = d.get("states", [])
    print(f"Total states (authenticated): {len(states)}")

    lengths = {}
    for s in states:
        lengths[len(s)] = lengths.get(len(s), 0) + 1
    print(f"State vector lengths: {lengths}")

    cats = {}
    for s in states:
        if len(s) > 17 and s[17] is not None:
            c = s[17]
            cats[c] = cats.get(c, 0) + 1
    
    print(f"\nCategory distribution (authenticated):")
    for k, v in sorted(cats.items()):
        print(f"  cat={k}: {v}")

    helis = [s for s in states if len(s) > 17 and s[17] == 8]
    print(f"\nHelicopters (cat=8): {len(helis)}")
    for h in helis[:5]:
        print(f"  icao={h[0]} callsign={h[1]} country={h[2]}")

except Exception as e:
    print(f"Error: {e}")
