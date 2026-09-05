#!/usr/bin/env python3
"""Géocode les listes curatées via Nominatim, avec cache disque et garde-fous.

- 1 requête/seconde maximum (politique d'usage Nominatim).
- Résultats bornés à la bbox de la ville (`bounded=1`) : impossible de tomber
  sur un homonyme à l'autre bout de la France.
- Le cache (tools/cache/geocode.json) est indexé par (ville, requête) : relancer
  le script ne refait aucun appel réseau.
- Un `lat`/`lon` écrit à la main dans la liste curatée a toujours la priorité.
"""
import json, pathlib, sys, time, urllib.parse, urllib.request

ROOT = pathlib.Path(__file__).resolve().parent
CACHE_FILE = ROOT / "cache" / "geocode.json"
UA = "CityWalker/1.0 (carte photo perso; github.com/aliyymoussaoui-oss/CityWalker)"
ENDPOINT = "https://nominatim.openstreetmap.org/search"

CITIES = {
    # bbox de recherche : (lon_min, lat_max, lon_max, lat_min) — format viewbox
    "paris": {
        "viewbox": (2.2200, 48.9150, 2.4750, 48.8000),
        "names": {"paris"},
    },
    "montpellier": {
        "viewbox": (3.7900, 43.6800, 3.9600, 43.5600),
        "names": {"montpellier"},
    },
}

_last_call = [0.0]


def _throttle():
    delta = time.time() - _last_call[0]
    if delta < 1.1:
        time.sleep(1.1 - delta)
    _last_call[0] = time.time()


def _request(params):
    _throttle()
    url = f"{ENDPOINT}?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.loads(r.read())
        except Exception as exc:  # noqa: BLE001
            sys.stderr.write(f"    retry {attempt + 1}/4 ({exc})\n")
            time.sleep(2 ** attempt)
    raise RuntimeError(f"Nominatim injoignable pour {params.get('q')}")


def _city_of(address):
    for key in ("city", "town", "municipality", "village"):
        if key in address:
            return address[key].lower()
    return ""


def geocode(city, query):
    cfg = CITIES[city]
    x1, y1, x2, y2 = cfg["viewbox"]
    results = _request({
        "q": query,
        "format": "jsonv2",
        "limit": 8,
        "addressdetails": 1,
        "countrycodes": "fr",
        "viewbox": f"{x1},{y1},{x2},{y2}",
        "bounded": 1,
    })
    if not results:
        return None
    # On privilégie un résultat dont la commune correspond, puis l'importance.
    def score(r):
        in_city = _city_of(r.get("address", {})) in cfg["names"]
        return (1 if in_city else 0, float(r.get("importance") or 0))

    best = max(results, key=score)
    return {
        "lat": round(float(best["lat"]), 6),
        "lon": round(float(best["lon"]), 6),
        "display_name": best.get("display_name", ""),
        "osm": f"{best.get('osm_type', '?')}/{best.get('osm_id', '?')}",
        "class": f"{best.get('category', '?')}:{best.get('type', '?')}",
        "address_city": _city_of(best.get("address", {})),
        "address_suburb": best.get("address", {}).get("suburb", ""),
        "address_quarter": best.get("address", {}).get("quarter", ""),
    }


def run(cities=("paris", "montpellier")):
    CACHE_FILE.parent.mkdir(parents=True, exist_ok=True)
    cache = json.loads(CACHE_FILE.read_text()) if CACHE_FILE.exists() else {}
    missing = []
    for city in cities:
        src = json.loads((ROOT / "spots" / f"{city}.json").read_text())
        for spot in src["spots"]:
            if "lat" in spot and "lon" in spot:
                continue
            key = f"{city}|{spot['query']}"
            if key in cache:
                continue
            print(f"→ {city} · {spot['name']}")
            hit = geocode(city, spot["query"])
            if hit is None:
                missing.append((city, spot["id"], spot["query"]))
                print("   ✗ aucun résultat")
                continue
            cache[key] = hit
            CACHE_FILE.write_text(json.dumps(cache, ensure_ascii=False, indent=1))
            print(f"   ✓ {hit['lat']},{hit['lon']} · {hit['class']} · {hit['display_name'][:80]}")
    if missing:
        print("\n⚠ Sans résultat (à corriger à la main dans la liste curatée) :")
        for city, sid, q in missing:
            print(f"   {city} / {sid} : {q}")
    return cache


if __name__ == "__main__":
    run(sys.argv[1:] or ("paris", "montpellier"))
