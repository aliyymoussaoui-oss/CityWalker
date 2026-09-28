#!/usr/bin/env bash
# Met le serveur de synchronisation en ligne chez Cloudflare, sans un clic.
#
# Appelé par .github/workflows/pages.yml avec deux secrets du dépôt :
#   CLOUDFLARE_API_TOKEN   jeton d'API (modèle « Edit Cloudflare Workers » + « D1 : Edit »)
#   CLOUDFLARE_ACCOUNT_ID  identifiant du compte
#
# Idempotent : chaque exécution crée ce qui manque (base D1, stockage R2,
# sous-domaine workers.dev), applique les migrations en attente, déploie, puis
# vérifie que le serveur répond. Il écrit `url=…` dans $GITHUB_OUTPUT.
#
# Sans les deux secrets, il ne fait rien et publie une URL vide : le site reste
# entièrement utilisable, en local.
#
# Si R2 n'est pas activé sur le compte (il demande d'enregistrer un moyen de
# paiement, même pour rester dans l'offre gratuite), le serveur part sans
# photos : comptes et progression se synchronisent quand même, et les photos
# suivront au déploiement d'après l'activation.
set -euo pipefail

cd "$(dirname "$0")"
OUT="${GITHUB_OUTPUT:-/dev/stdout}"
WORKER="citywalker-api"
DB_NAME="citywalker"
BUCKET="citywalker-photos"
API="${CLOUDFLARE_API_BASE:-https://api.cloudflare.com/client/v4}"   # surchargée par tests/deploy.mjs

if [ -z "${CLOUDFLARE_API_TOKEN:-}" ] || [ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
  echo "::notice::Pas de secrets CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID : site publié sans synchronisation (voir SYNCHRONISATION.md)."
  echo "url=" >> "$OUT"
  exit 0
fi
ACCOUNT="$CLOUDFLARE_ACCOUNT_ID"
export CI=true   # wrangler ne pose aucune question

# Appel à l'API Cloudflare ; le corps JSON de la réponse sort sur stdout.
cf() {
  local method="$1" path="$2" body="${3:-}"
  if [ -n "$body" ]; then
    curl -sS -X "$method" "$API$path" -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
      -H "Content-Type: application/json" --data "$body"
  else
    curl -sS -X "$method" "$API$path" -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN"
  fi
}
# Lit un champ d'une réponse JSON ; vide si absent.
field() { python3 -c 'import json,sys
try: d=json.load(sys.stdin)
except Exception: sys.exit(0)
for k in sys.argv[1].split("."):
    if isinstance(d,list): d=d[int(k)] if len(d)>int(k) else None
    elif isinstance(d,dict): d=d.get(k)
    if d is None: sys.exit(0)
print(d if not isinstance(d,bool) else str(d).lower())' "$1"; }
errors() { python3 -c 'import json,sys
try: d=json.load(sys.stdin)
except Exception: print("réponse illisible"); sys.exit(0)
print("; ".join(f"{e.get(\"code\")}: {e.get(\"message\")}" for e in d.get("errors") or []))'; }

echo "— Vérification du jeton"
check=$(cf GET "/accounts/$ACCOUNT/workers/scripts")
if [ "$(echo "$check" | field success)" != "true" ]; then
  echo "::error::Le jeton Cloudflare ou l'identifiant de compte est refusé : $(echo "$check" | errors)"
  exit 1
fi

echo "— Base D1 « $DB_NAME »"
DB_ID=$(cf GET "/accounts/$ACCOUNT/d1/database?name=$DB_NAME" | python3 -c 'import json,sys
d=json.load(sys.stdin)
if not d.get("success"): sys.exit(0)
print(next((x["uuid"] for x in d.get("result") or [] if x.get("name")=="'"$DB_NAME"'"), ""))')
if [ -z "$DB_ID" ]; then
  created=$(cf POST "/accounts/$ACCOUNT/d1/database" "{\"name\":\"$DB_NAME\"}")
  DB_ID=$(echo "$created" | field result.uuid)
  if [ -z "$DB_ID" ]; then
    echo "::error::Création de la base D1 impossible : $(echo "$created" | errors). Le jeton a-t-il la permission « D1 : Edit » ?"
    exit 1
  fi
  echo "  créée : $DB_ID"
else
  echo "  existe déjà : $DB_ID"
fi

echo "— Stockage R2 « $BUCKET »"
PHOTOS=false
if [ "$(cf GET "/accounts/$ACCOUNT/r2/buckets/$BUCKET" | field success)" = "true" ]; then
  PHOTOS=true
  echo "  existe déjà"
else
  created=$(cf POST "/accounts/$ACCOUNT/r2/buckets" "{\"name\":\"$BUCKET\"}")
  if [ "$(echo "$created" | field success)" = "true" ]; then
    PHOTOS=true
    echo "  créé"
  else
    echo "::warning::R2 indisponible ($(echo "$created" | errors)). Le serveur part sans photos : active R2 dans le tableau de bord Cloudflare (R2 → Purchase R2 Plan, gratuit jusqu'à 10 Go) puis relance ce workflow."
  fi
fi

echo "— Sous-domaine workers.dev"
SUB=$(cf GET "/accounts/$ACCOUNT/workers/subdomain" | field result.subdomain)
if [ -z "$SUB" ]; then
  # Un compte neuf n'en a pas encore ; le nom doit être unique sur workers.dev.
  WANT="citywalker-$(echo -n "$ACCOUNT" | sha256sum | cut -c1-8)"
  created=$(cf PUT "/accounts/$ACCOUNT/workers/subdomain" "{\"subdomain\":\"$WANT\"}")
  SUB=$(echo "$created" | field result.subdomain)
  if [ -z "$SUB" ]; then
    echo "::error::Impossible de réserver un sous-domaine workers.dev : $(echo "$created" | errors). Ouvre une fois « Workers & Pages » dans le tableau de bord Cloudflare, puis relance."
    exit 1
  fi
  echo "  réservé : $SUB.workers.dev"
else
  echo "  $SUB.workers.dev"
fi

echo "— Configuration de déploiement"
{
  echo "# Écrit par server/deploy.sh — ne pas modifier à la main."
  echo "name = \"$WORKER\""
  echo "main = \"src/index.js\""
  echo "compatibility_date = \"2026-09-01\""
  echo "workers_dev = true"
  echo
  echo "[[d1_databases]]"
  echo "binding = \"DB\""
  echo "database_name = \"$DB_NAME\""
  echo "database_id = \"$DB_ID\""
  echo "migrations_dir = \"migrations\""
  if [ "$PHOTOS" = true ]; then
    echo
    echo "[[r2_buckets]]"
    echo "binding = \"PHOTOS\""
    echo "bucket_name = \"$BUCKET\""
  fi
  echo
  echo "[triggers]"
  echo "crons = [\"17 3 * * *\"]"
} > wrangler.deploy.toml
cat wrangler.deploy.toml

WRANGLER="../node_modules/.bin/wrangler"
if [ -n "${DRY_RUN:-}" ]; then
  # Essai à blanc (tests/deploy.mjs) : wrangler valide la configuration et
  # assemble le Worker sans rien envoyer.
  "$WRANGLER" deploy --dry-run -c wrangler.deploy.toml --outdir "$(mktemp -d)"
  echo "url=https://$WORKER.$SUB.workers.dev" >> "$OUT"
  exit 0
fi
echo "— Migrations"
"$WRANGLER" d1 migrations apply "$DB_NAME" --remote -c wrangler.deploy.toml

echo "— Déploiement"
"$WRANGLER" deploy -c wrangler.deploy.toml

URL="https://$WORKER.$SUB.workers.dev"
echo "— Vérification de $URL"
# Un sous-domaine tout neuf peut mettre quelques minutes à répondre.
for i in $(seq 1 40); do
  health=$(curl -sS -m 10 "$URL/v1/health" 2>/dev/null || true)
  if [ "$(echo "$health" | field ok)" = "true" ]; then
    echo "  en ligne : $health"
    echo "url=$URL" >> "$OUT"
    exit 0
  fi
  sleep 10
done
echo "::error::Le serveur est déployé mais ne répond pas sur $URL/v1/health après 6 minutes."
exit 1
