import urllib.request, json

try:
    r = urllib.request.urlopen('http://127.0.0.1:8000/api/v1/flights/', timeout=5)
    d = json.loads(r.read())
    flights = d.get('flights', [])
    src = d.get('source', '?')
    print(f"Total: {len(flights)}, Source: {src}")

    cats = {}
    for f in flights:
        c = f.get('category', 0)
        cats[c] = cats.get(c, 0) + 1

    print("Category distribution:")
    for k, v in sorted(cats.items()):
        print(f"  cat={k}: {v}")

    helis = [f for f in flights if f.get('category') == 8]
    print(f"\nHelicopters (cat=8): {len(helis)}")
    for h in helis[:5]:
        print(f"  {h['icao24']} callsign={h.get('callsign')} country={h.get('origin_country')}")

except Exception as e:
    print(f"Error: {e}")
