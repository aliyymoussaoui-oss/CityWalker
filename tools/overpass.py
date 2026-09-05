"""Petit client Overpass tolérant aux pannes : bascule de miroir + retries."""
import json, sys, time, urllib.parse, urllib.request

# NB : overpass.osm.ch est volontairement exclu (instance limitée à la Suisse,
# elle répond 200 avec 0 élément pour la France, ce qui masquerait une panne).
MIRRORS = [
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://overpass-api.de/api/interpreter",
]

UA = "CityWalker/1.0 (carte photo perso; contact via github.com/aliyymoussaoui-oss/CityWalker)"


def query(ql, attempts=3, timeout=240):
    last = None
    for attempt in range(attempts):
        for url in MIRRORS:
            try:
                data = urllib.parse.urlencode({"data": ql}).encode()
                req = urllib.request.Request(url, data=data, headers={"User-Agent": UA})
                with urllib.request.urlopen(req, timeout=timeout) as r:
                    raw = r.read()
                payload = json.loads(raw)
                if "elements" in payload:
                    sys.stderr.write(f"  ok {url} -> {len(payload['elements'])} éléments\n")
                    return payload
                last = f"réponse sans 'elements' depuis {url}"
            except Exception as exc:  # noqa: BLE001 - on veut juste basculer
                last = f"{url}: {exc}"
                sys.stderr.write(f"  ko {last}\n")
            time.sleep(1.5)
        time.sleep(4 * (attempt + 1))
    raise RuntimeError(f"Overpass indisponible ({last})")


if __name__ == "__main__":
    print(json.dumps(query(sys.stdin.read()), ensure_ascii=False))
