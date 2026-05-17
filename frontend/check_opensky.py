"""Check what OpenSky actually returns for the category field."""
import urllib.request, json

# Call OpenSky API directly (unauthenticated)
url = "https://opensky-network.org/api/states/all?extended=1"
req = urllib.request.Request(url, headers={"Accept": "application/json"})

try:
    r = urllib.request.urlopen(req, timeout=30)
    d = json.loads(r.read())
    states = d.get("states", [])
    print(f"Total states: {len(states)}")
    
    if not states:
        print("No states returned!")
    else:
        # Check vector lengths
        lengths = {}
        for s in states:
            l = len(s)
            lengths[l] = lengths.get(l, 0) + 1
        print(f"State vector lengths: {lengths}")
        
        # Check category distribution (index 17)
        cats = {}
        has_cat = 0
        no_cat = 0
        for s in states:
            if len(s) > 17 and s[17] is not None:
                has_cat += 1
                c = s[17]
                cats[c] = cats.get(c, 0) + 1
            else:
                no_cat += 1
        
        print(f"\nFlights WITH category (index 17): {has_cat}")
        print(f"Flights WITHOUT category: {no_cat}")
        print(f"\nCategory distribution:")
        for k, v in sorted(cats.items()):
            print(f"  cat={k}: {v}")
        
        # Show helicopters specifically
        helis = [s for s in states if len(s) > 17 and s[17] == 8]
        print(f"\nHelicopters (cat=8): {len(helis)}")
        for h in helis[:5]:
            print(f"  icao={h[0]} callsign={h[1]} country={h[2]}")

except Exception as e:
    print(f"Error: {e}")
