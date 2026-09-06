#!/usr/bin/env python3
"""Fabrique dist/citywalker.html : l'application entière dans un seul fichier.

CSS, JavaScript et données cartographiques sont intégrés au HTML. Le fichier
obtenu n'a aucune dépendance : il s'ouvre par double-clic (file://), se met sur
n'importe quel hébergement, s'envoie par mail ou se publie tel quel.
"""
import json, pathlib, re, sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"

JS_ORDER = ["util", "model", "store", "exif", "photos", "import", "cloud", "share", "tiles", "map", "ui", "main"]


def build():
    html = (ROOT / "index.html").read_text(encoding="utf-8")
    css = (ROOT / "assets" / "app.css").read_text(encoding="utf-8")

    # Données embarquées : main.js les lira depuis window.CW_DATA au lieu de fetch().
    data = {c: json.loads((ROOT / "data" / f"{c}.json").read_text(encoding="utf-8"))
            for c in ("paris", "montpellier")}
    payload = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    # `</script>` ne doit jamais apparaître littéralement dans un bloc script.
    payload = payload.replace("</", "<\\/")

    scripts = []
    for name in JS_ORDER:
        src = (ROOT / "assets" / "js" / f"{name}.js").read_text(encoding="utf-8")
        scripts.append(f"/* ---- {name}.js ---- */\n{src}")
    bundle = "\n".join(scripts).replace("</script", "<\\/script")

    # Le manifeste et l'icône ne servent qu'au site servi en HTTP : un fichier
    # unique n'a rien à installer, on retire ces références externes.
    html = re.sub(r'\n<link rel="manifest"[^>]*>', "", html)
    html = re.sub(r'\n<link rel="apple-touch-icon"[^>]*>', "", html)
    html = html.replace('<link rel="stylesheet" href="assets/app.css">',
                        f"<style>\n{css}\n</style>")
    html = re.sub(r'\n<script src="assets/js/[a-z]+\.js"></script>', "", html)
    html = html.replace(
        "</body>",
        f'<script>window.CW_DATA={payload};</script>\n<script>\n{bundle}\n</script>\n</body>',
    )

    DIST.mkdir(exist_ok=True)
    out = DIST / "citywalker.html"
    out.write_text(html, encoding="utf-8")

    # Garde-fous : le fichier doit être complet et autonome.
    text = out.read_text(encoding="utf-8")
    problems = []
    if 'src="assets' in text or 'href="assets' in text:
        problems.append("il reste une référence à assets/")
    for name in JS_ORDER:
        if f"---- {name}.js ----" not in text:
            problems.append(f"{name}.js absent du bundle")
    if '"paris"' not in text or '"montpellier"' not in text:
        problems.append("données de ville absentes")
    if problems:
        raise SystemExit("Build incohérent :\n  " + "\n  ".join(problems))

    # Dossier prêt à déposer sur un hébergeur : un seul index.html, rien d'autre.
    site = DIST / "site"
    site.mkdir(exist_ok=True)
    (site / "index.html").write_text(text, encoding="utf-8")

    print(f"dist/citywalker.html — {out.stat().st_size / 1024:.0f} Ko, autonome")
    print("dist/site/index.html — dossier à glisser tel quel sur un hébergeur")
    return out



def build_artifact(source):
    """Variante sans <!doctype>/<html>/<head>/<body> pour la publication en Artifact."""
    text = source.read_text(encoding="utf-8")
    head = re.search(r"<head>(.*?)</head>", text, re.S)
    body = re.search(r"<body>(.*?)</body>", text, re.S)
    if not head or not body:
        raise SystemExit("Structure HTML inattendue : impossible d'extraire head/body.")
    keep = []
    for pattern in (r"<title>.*?</title>", r"<meta name=\"description\"[^>]*>", r"<style>.*?</style>"):
        m = re.search(pattern, head.group(1), re.S)
        if m:
            keep.append(m.group(0))
    out = source.parent / "artifact.html"
    out.write_text("\n".join(keep) + "\n" + body.group(1).strip() + "\n", encoding="utf-8")
    low = out.read_text(encoding="utf-8").lower()
    for forbidden in ("<!doctype", "<html", "<head>", "<body"):
        if forbidden in low:
            raise SystemExit(f"La variante artifact contient encore {forbidden}")
    print(f"dist/artifact.html — {out.stat().st_size / 1024:.0f} Ko")
    return out

if __name__ == "__main__":
    build_artifact(build())
