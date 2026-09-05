#!/usr/bin/env python3
"""Transforme les géométries brutes + les listes curatées en data/<ville>.json.

Pipeline :
  1. lecture des caches (Open Data Paris + Overpass) ;
  2. assemblage des anneaux de relations OSM (outer/inner) ;
  3. simplification Douglas–Peucker en degrés ;
  4. projection Web Mercator normalisée sur un viewBox de 1000 unités de large ;
  5. fusion avec les listes curatées géocodées, puis vérification
     point-dans-polygone du quartier de chaque spot.

Le script échoue bruyamment (SystemExit) sur toute incohérence : mieux vaut un
build rouge qu'une carte fausse.
"""
import json, math, pathlib, sys
from collections import defaultdict

ROOT = pathlib.Path(__file__).resolve().parent
CACHE = ROOT / "cache"
OUT = ROOT.parent / "data"

VIEW_W = 1000.0           # largeur du viewBox SVG
PAD = 18.0                # marge intérieure, en unités de viewBox

# ---------------------------------------------------------------- géométrie --


def merc(lon, lat):
    """Web Mercator normalisé (x vers l'est, y vers le sud)."""
    x = math.radians(lon)
    y = math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))
    return x, -y


def ring_area_m2(ring):
    """Aire approchée d'un anneau lon/lat, en m² (équirectangulaire locale)."""
    if len(ring) < 3:
        return 0.0
    lat0 = sum(p[1] for p in ring) / len(ring)
    k = math.cos(math.radians(lat0))
    acc = 0.0
    for (x1, y1), (x2, y2) in zip(ring, ring[1:] + ring[:1]):
        acc += (x1 * k) * y2 - (x2 * k) * y1
    return abs(acc) / 2 * (111_320 ** 2)


def bbox_of(rings):
    xs = [p[0] for r in rings for p in r]
    ys = [p[1] for r in rings for p in r]
    return min(xs), min(ys), max(xs), max(ys)


def simplify(points, tol):
    """Douglas–Peucker itératif (pas de récursion : anneaux parfois énormes)."""
    if len(points) < 3:
        return list(points)
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        i, j = stack.pop()
        if j <= i + 1:
            continue
        ax, ay = points[i]
        bx, by = points[j]
        dx, dy = bx - ax, by - ay
        norm = math.hypot(dx, dy)
        best, best_d = -1, -1.0
        for k in range(i + 1, j):
            px, py = points[k]
            if norm == 0:
                d = math.hypot(px - ax, py - ay)
            else:
                d = abs(dy * px - dx * py + bx * ay - by * ax) / norm
            if d > best_d:
                best, best_d = k, d
        if best_d > tol:
            keep[best] = True
            stack.append((i, best))
            stack.append((best, j))
    return [p for p, k in zip(points, keep) if k]


def close_ring(ring):
    if ring and ring[0] != ring[-1]:
        ring = ring + [ring[0]]
    return ring


def point_in_rings(pt, rings):
    """Règle pair-impair sur l'ensemble des anneaux (gère les trous)."""
    x, y = pt
    inside = False
    for ring in rings:
        n = len(ring)
        for i in range(n):
            x1, y1 = ring[i]
            x2, y2 = ring[(i + 1) % n]
            if (y1 > y) != (y2 > y):
                xin = x1 + (y - y1) * (x2 - x1) / (y2 - y1)
                if xin > x:
                    inside = not inside
    return inside


# ------------------------------------------------------------- lecture OSM --


def stitch(ways):
    """Recoud une liste de polylignes en anneaux fermés."""
    segments = [list(w) for w in ways if len(w) >= 2]
    rings = []
    while segments:
        cur = segments.pop()
        progressed = True
        while progressed and (cur[0] != cur[-1]):
            progressed = False
            for idx, seg in enumerate(segments):
                if seg[0] == cur[-1]:
                    cur += seg[1:]
                elif seg[-1] == cur[-1]:
                    cur += list(reversed(seg))[1:]
                elif seg[-1] == cur[0]:
                    cur = seg[:-1] + cur
                elif seg[0] == cur[0]:
                    cur = list(reversed(seg))[:-1] + cur
                else:
                    continue
                segments.pop(idx)
                progressed = True
                break
        if cur[0] == cur[-1] and len(cur) >= 4:
            rings.append(cur[:-1])
    return rings


def osm_rings(element):
    """Anneaux (outer d'abord, puis inner) d'un way fermé ou d'une relation."""
    if element["type"] == "way":
        geom = [(g["lon"], g["lat"]) for g in element.get("geometry", [])]
        if len(geom) >= 4 and geom[0] == geom[-1]:
            return [geom[:-1]], []
        return [], []
    outer_ways, inner_ways = [], []
    for m in element.get("members", []):
        geom = [(g["lon"], g["lat"]) for g in m.get("geometry") or []]
        if len(geom) < 2:
            continue
        (inner_ways if m.get("role") == "inner" else outer_ways).append(geom)
    return stitch(outer_ways), stitch(inner_ways)


def load_overpass(name):
    path = CACHE / f"{name}.json"
    if not path.exists():
        raise SystemExit(f"Cache manquant : {path} — lance d'abord tools/fetch_geo.py")
    return json.loads(path.read_text())["elements"]


# ----------------------------------------------------------------- rendu -----


class Projector:
    def __init__(self, all_rings):
        pts = [merc(x, y) for ring in all_rings for (x, y) in ring]
        xs = [p[0] for p in pts]
        ys = [p[1] for p in pts]
        self.x0, self.x1 = min(xs), max(xs)
        self.y0, self.y1 = min(ys), max(ys)
        span_x = self.x1 - self.x0
        self.scale = (VIEW_W - 2 * PAD) / span_x
        self.height = round((self.y1 - self.y0) * self.scale + 2 * PAD, 2)

    def __call__(self, lon, lat):
        mx, my = merc(lon, lat)
        return (round((mx - self.x0) * self.scale + PAD, 1),
                round((my - self.y0) * self.scale + PAD, 1))

    def meta(self):
        return {"x0": self.x0, "y0": self.y0, "scale": self.scale, "pad": PAD}


def path_of(rings, project):
    out = []
    for ring in rings:
        if len(ring) < 3:
            continue
        pts = [project(lon, lat) for lon, lat in ring]
        # dédoublonne les points devenus identiques après arrondi
        dedup = [pts[0]]
        for p in pts[1:]:
            if p != dedup[-1]:
                dedup.append(p)
        if len(dedup) < 3:
            continue
        d = f"M{dedup[0][0]} {dedup[0][1]}"
        d += "".join(f"L{x} {y}" for x, y in dedup[1:])
        out.append(d + "Z")
    return "".join(out)


def centroid(rings):
    """Centroïde surfacique de l'anneau extérieur le plus grand."""
    ring = max(rings, key=ring_area_m2)
    a = cx = cy = 0.0
    for (x1, y1), (x2, y2) in zip(ring, ring[1:] + ring[:1]):
        cross = x1 * y2 - x2 * y1
        a += cross
        cx += (x1 + x2) * cross
        cy += (y1 + y2) * cross
    if a == 0:
        return ring[0]
    a *= 0.5
    return cx / (6 * a), cy / (6 * a)


# ------------------------------------------------------------ construction --

CITY_META = {
    "paris": {
        "name": "Paris",
        "subtitle": "20 arrondissements",
        "accent": "#2f5d8a",
        "zone_word": "arrondissement",
        "zone_word_plural": "arrondissements",
        "tol": 0.00012,
        "tol_detail": 0.00020,
        "min_green_m2": 12000,
        "min_water_m2": 4000,
    },
    "montpellier": {
        "name": "Montpellier",
        "subtitle": "7 grands quartiers",
        "accent": "#b4622f",
        "zone_word": "quartier",
        "zone_word_plural": "quartiers",
        "tol": 0.00008,
        "tol_detail": 0.00014,
        "min_green_m2": 6000,
        "min_water_m2": 1500,
    },
}

ORDINAL = {1: "1er"}


def slugify(text):
    import re, unicodedata
    norm = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "-", norm.lower()).strip("-")


def paris_zones():
    gj = json.loads((CACHE / "paris_arrondissements.geojson").read_text())
    zones = []
    for f in gj["features"]:
        p = f["properties"]
        num = int(p["c_ar"])
        geom = f["geometry"]
        polys = geom["coordinates"] if geom["type"] == "MultiPolygon" else [geom["coordinates"]]
        rings = [[(round(x, 7), round(y, 7)) for x, y in ring[:-1]]
                 for poly in polys for ring in poly]
        zones.append({"id": f"{num:02d}", "name": p["l_aroff"],
                      "label": ORDINAL.get(num, f"{num}e"), "rings": rings, "order": num})
    zones.sort(key=lambda z: z["order"])
    if len(zones) != 20:
        raise SystemExit(f"Paris : {len(zones)} arrondissements au lieu de 20")
    return zones


def montpellier_zones():
    zones = []
    for el in load_overpass("mtp_quartiers"):
        name = el["tags"]["name"]
        outer, inner = osm_rings(el)
        if not outer:
            raise SystemExit(f"Quartier sans anneau exploitable : {name}")
        zones.append({"id": slugify(name), "name": name, "label": name,
                      "rings": outer + inner, "order": 0})
    zones.sort(key=lambda z: -sum(ring_area_m2(r) for r in z["rings"]))
    for i, z in enumerate(zones):
        z["order"] = i
    if len(zones) != 7:
        raise SystemExit(f"Montpellier : {len(zones)} quartiers au lieu de 7")
    return zones


def commune_rings(city):
    els = load_overpass("paris_commune" if city == "paris" else "mtp_commune")
    outer, inner = osm_rings(els[0])
    if not outer:
        raise SystemExit(f"Limite communale illisible pour {city}")
    return outer, inner


def area_features(city, kind, rings_commune, min_area):
    prefix = "paris" if city == "paris" else "mtp"
    feats = []
    for el in load_overpass(f"{prefix}_{kind}"):
        outer, inner = osm_rings(el)
        if not outer:
            continue
        area = sum(ring_area_m2(r) for r in outer)
        if area < min_area:
            continue
        if not point_in_rings(centroid(outer), rings_commune):
            continue
        feats.append({"rings": outer + inner, "area": area,
                      "name": el.get("tags", {}).get("name", "")})
    feats.sort(key=lambda f: -f["area"])
    return feats


SUB_LABELS = {
    "Écusson", "Antigone", "Boutonnet", "Beaux-Arts", "Figuerolles", "Les Arceaux",
    "Les Aubes", "Port Marianne", "Odysseum", "Richter", "La Paillade", "Malbosc",
    "Alco", "Aiguelongue", "Estanove", "Saint-Roch", "Millénaire", "Grammont",
    "Celleneuve", "Les Sabines", "Le Petit Bard", "Tournezy", "Lemasson",
    "La Pompignane", "Les Grisettes", "La Mosson", "Les Beaux-Arts",
}


def montpellier_labels(proj, commune):
    labels, seen = [], set()
    for el in load_overpass("mtp_places"):
        name = el.get("tags", {}).get("name")
        if not name or name in seen or name not in SUB_LABELS:
            continue
        pt = (el["lon"], el["lat"])
        if not point_in_rings(pt, commune):
            continue
        seen.add(name)
        x, y = proj(*pt)
        labels.append({"name": name, "x": x, "y": y})
    labels.sort(key=lambda l: l["name"])
    return labels


def load_spots(city, zones):
    src = json.loads((ROOT / "spots" / f"{city}.json").read_text())
    cache_file = CACHE / "geocode.json"
    cache = json.loads(cache_file.read_text()) if cache_file.exists() else {}
    zone_index = {z["id"]: z for z in zones}
    problems, moved, out = [], [], []
    for spot in src["spots"]:
        if "lat" in spot and "lon" in spot:
            lat, lon, label = spot["lat"], spot["lon"], "coordonnées manuelles"
        else:
            hit = cache.get(f"{city}|{spot['query']}")
            if not hit:
                problems.append(f"{spot['id']} : non géocodé ({spot['query']})")
                continue
            lat, lon, label = hit["lat"], hit["lon"], hit["display_name"][:70]
        found = next((z["id"] for z in zones if point_in_rings((lon, lat), z["rings"])), None)
        if found is None:
            problems.append(f"{spot['id']} : hors zone ({lat},{lon}) — {label}")
            continue
        if spot.get("zone") and spot["zone"] != found:
            moved.append(f"{spot['id']} : attendu {spot['zone']} → réel {found} "
                         f"({zone_index[found]['name']})")
        entry = dict(spot)
        entry.update({"lat": lat, "lon": lon, "zone": found})
        out.append(entry)
    if moved:
        print(f"  ~ {len(moved)} spot(s) reclassés par la géométrie :")
        for m in moved:
            print("     " + m)
    if problems:
        print(f"  ⚠ {len(problems)} spot(s) écartés :")
        for p in problems:
            print("     " + p)
    return out


def build(city):
    meta = CITY_META[city]
    zones = paris_zones() if city == "paris" else montpellier_zones()
    outer_c, inner_c = commune_rings(city)
    water = area_features(city, "water", outer_c, meta["min_water_m2"])
    green = area_features(city, "green", outer_c, meta["min_green_m2"])
    spots = load_spots(city, zones)
    proj = Projector(outer_c)

    def simp(rings, tol):
        out = []
        for r in rings:
            s = simplify(close_ring(list(r)), tol)
            if s and s[0] == s[-1]:
                s = s[:-1]
            if len(s) >= 3:
                out.append(s)
        return out

    data = {
        "id": city, "name": meta["name"], "subtitle": meta["subtitle"],
        "accent": meta["accent"], "zoneWord": meta["zone_word"],
        "zoneWordPlural": meta["zone_word_plural"],
        "view": {"w": VIEW_W, "h": proj.height},
        "projection": proj.meta(),
        "outline": path_of(simp(outer_c, meta["tol"]), proj),
        "zones": [], "water": [], "green": [], "labels": [], "spots": [],
    }
    for f in water:
        d = path_of(simp(f["rings"], meta["tol_detail"]), proj)
        if d:
            data["water"].append(d)
    for f in green:
        d = path_of(simp(f["rings"], meta["tol_detail"]), proj)
        if d:
            data["green"].append(d)
    for z in zones:
        cx, cy = centroid(z["rings"])
        px, py = proj(cx, cy)
        data["zones"].append({"id": z["id"], "name": z["name"], "label": z["label"],
                              "d": path_of(simp(z["rings"], meta["tol"]), proj),
                              "cx": px, "cy": py})
    if city == "montpellier":
        data["labels"] = montpellier_labels(proj, outer_c)

    order = {z["id"]: i for i, z in enumerate(data["zones"])}
    for s in spots:
        x, y = proj(s["lon"], s["lat"])
        entry = {"id": s["id"], "name": s["name"], "cat": s["cat"], "zone": s["zone"],
                 "x": x, "y": y, "lat": s["lat"], "lon": s["lon"]}
        for opt in ("sub", "tip", "best"):
            if s.get(opt):
                entry[opt] = s[opt]
        data["spots"].append(entry)
    data["spots"].sort(key=lambda s: (order[s["zone"]], s["name"]))
    return data


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    for city in (sys.argv[1:] or ["paris", "montpellier"]):
        print(f"\n=== {city} ===")
        data = build(city)
        dest = OUT / f"{city}.json"
        dest.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")))
        counts = defaultdict(int)
        for s in data["spots"]:
            counts[s["zone"]] += 1
        print(f"  zones={len(data['zones'])} eau={len(data['water'])} vert={len(data['green'])} "
              f"spots={len(data['spots'])} labels={len(data['labels'])} "
              f"viewBox=1000x{data['view']['h']} poids={dest.stat().st_size/1024:.0f} Ko")
        print("  répartition:", dict(sorted(counts.items())))
