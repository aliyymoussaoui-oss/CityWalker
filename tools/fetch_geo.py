#!/usr/bin/env python3
"""Télécharge les géométries brutes (OSM / Open Data Paris) dans tools/cache/.

Chaque réponse est mise en cache : relancer le script ne retélécharge rien.
Utiliser --force pour rafraîchir.
"""
import argparse, json, pathlib, sys, urllib.request

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from overpass import query as overpass_query  # noqa: E402

CACHE = pathlib.Path(__file__).resolve().parent / "cache"
UA = "CityWalker/1.0 (carte photo perso; github.com/aliyymoussaoui-oss/CityWalker)"

# --- Requêtes Overpass -------------------------------------------------------
# bbox Paris intra-muros + bois : (S, W, N, E)
BBOX_PARIS = "48.800,2.220,48.915,2.475"
BBOX_MTP = "43.560,3.790,43.680,3.960"
BBOX_LYON = "45.700,4.760,45.820,4.920"

QUERIES = {
    # Montpellier : les 7 grands quartiers officiels (admin_level 10)
    "mtp_quartiers": f"""[out:json][timeout:120];
rel["boundary"="administrative"]["admin_level"="10"]({BBOX_MTP});
out geom;""",
    # Montpellier : limite communale
    "mtp_commune": """[out:json][timeout:120];
rel["boundary"="administrative"]["admin_level"="8"]["name"="Montpellier"]["ref:INSEE"="34172"];
out geom;""",
    # Montpellier : eau (le Lez, le Verdanson, bassins)
    "mtp_water": f"""[out:json][timeout:180];
(
  way["natural"="water"]({BBOX_MTP});
  way["waterway"="riverbank"]({BBOX_MTP});
  rel["natural"="water"]({BBOX_MTP});
  way["waterway"~"^(river|stream|canal)$"]["name"~"Lez|Verdanson|Lironde|Mosson",i]({BBOX_MTP});
);
out geom;""",
    # Montpellier : parcs et bois notables
    "mtp_green": f"""[out:json][timeout:180];
(
  way["leisure"="park"]({BBOX_MTP});
  rel["leisure"="park"]({BBOX_MTP});
  way["landuse"~"^(forest|meadow)$"]({BBOX_MTP});
  way["leisure"="garden"]["name"]({BBOX_MTP});
);
out geom;""",
    # Montpellier : étiquettes de sous-quartiers
    "mtp_places": f"""[out:json][timeout:120];
node["place"~"^(suburb|neighbourhood|quarter)$"]({BBOX_MTP});
out;""",
    # Lyon : les 9 arrondissements, la limite communale, l'eau et le vert
    # Les arrondissements de Lyon sont au niveau 9 ; le niveau 10 y désigne les
    # conseils de quartier, qui ne couvrent pas la ville.
    "lyon_quartiers": f"""[out:json][timeout:120];
rel["boundary"="administrative"]["admin_level"="9"]({BBOX_LYON});
out geom;""",
    "lyon_commune": """[out:json][timeout:120];
rel["boundary"="administrative"]["admin_level"="8"]["ref:INSEE"="69123"];
out geom;""",
    "lyon_water": f"""[out:json][timeout:180];
(
  way["natural"="water"]({BBOX_LYON});
  way["waterway"="riverbank"]({BBOX_LYON});
  rel["natural"="water"]({BBOX_LYON});
);
out geom;""",
    "lyon_green": f"""[out:json][timeout:180];
(
  way["leisure"="park"]({BBOX_LYON});
  rel["leisure"="park"]({BBOX_LYON});
  way["landuse"="forest"]({BBOX_LYON});
);
out geom;""",
    # Paris : limite communale (silhouette + clipping)
    "paris_commune": """[out:json][timeout:120];
rel["boundary"="administrative"]["admin_level"="8"]["ref:INSEE"="75056"];
out geom;""",
    # Paris : la Seine, les canaux, les lacs des bois
    "paris_water": f"""[out:json][timeout:240];
(
  way["natural"="water"]({BBOX_PARIS});
  way["waterway"="riverbank"]({BBOX_PARIS});
  rel["natural"="water"]({BBOX_PARIS});
  way["waterway"="canal"]["name"~"Saint-Martin|Ourcq|Villette",i]({BBOX_PARIS});
);
out geom;""",
    # Paris : bois, grands parcs, cimetières paysagers
    "paris_green": f"""[out:json][timeout:240];
(
  way["leisure"="park"]({BBOX_PARIS});
  rel["leisure"="park"]({BBOX_PARIS});
  way["landuse"="forest"]({BBOX_PARIS});
  rel["landuse"="forest"]({BBOX_PARIS});
);
out geom;""",
}

DOWNLOADS = {
    "paris_arrondissements.geojson":
        "https://opendata.paris.fr/api/explore/v2.1/catalog/datasets/arrondissements/exports/geojson",
}


def fetch_all(force=False):
    CACHE.mkdir(parents=True, exist_ok=True)
    for name, url in DOWNLOADS.items():
        dest = CACHE / name
        if dest.exists() and not force:
            print(f"· {name} (cache)")
            continue
        print(f"↓ {name}")
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=180) as r:
            dest.write_bytes(r.read())
    for name, ql in QUERIES.items():
        dest = CACHE / f"{name}.json"
        if dest.exists() and not force:
            print(f"· {name}.json (cache)")
            continue
        print(f"↓ {name}.json")
        payload = overpass_query(ql)
        if not payload.get("elements"):
            raise SystemExit(f"Réponse vide pour {name} — on refuse d'écrire un cache faux.")
        dest.write_text(json.dumps(payload, ensure_ascii=False))


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true")
    fetch_all(ap.parse_args().force)
