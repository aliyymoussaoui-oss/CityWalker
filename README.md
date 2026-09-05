# CityWalker

Deux cartes sobres — **Paris** et **Montpellier** — pour épingler les lieux que
tu as déjà photographiés, noter dans quelle ambiance (coucher de soleil, nuit,
pluie, brume…), y attacher tes photos, et suivre ton pourcentage de découverte
de la ville et de ses quartiers.

Une seule page, aucun compte, aucun serveur. Tout reste sur ton appareil.

- **155 lieux à Paris**, répartis sur les 20 arrondissements.
- **85 lieux à Montpellier**, répartis sur les 7 grands quartiers.
- Cartes vectorielles dessinées à partir des données officielles : silhouette de
  la commune, limites de quartiers, cours d'eau, parcs. Aucune tuile à charger,
  la carte fonctionne hors ligne une fois la page ouverte.

## Comment ça marche

1. Choisis la ville en haut à gauche.
2. Clique une épingle sur la carte, ou un lieu dans la liste de droite.
3. Bouton **« Je l'ai photographié »**, puis coche les ambiances capturées.
4. Ajoute tes photos : elles sont redimensionnées et rangées dans le navigateur.
   Si la photo porte une date EXIF, elle remplit la date toute seule ; si elle
   porte des coordonnées GPS, l'application signale le lieu le plus proche.
5. L'onglet **Progression** donne le pourcentage global, le détail par quartier,
   par catégorie et par ambiance, plus une liste de prochains lieux à faire.

### Partager une carte

Deux mécanismes, volontairement distincts :

| Ce que tu veux | Comment | Ce qui voyage |
| --- | --- | --- |
| Montrer ta carte à quelqu'un | **Partager → Copier le lien** | Lieux cochés, ambiances, dates, notes en option. Pas les photos. |
| Changer d'appareil, tout transférer | **Partager → Exporter** puis **Importer** | Tout, photos comprises, dans un fichier `.json`. |

Le lien s'ouvre en lecture seule, avec le prénom de son auteur en bandeau. Un
bouton permet de **fusionner** la carte reçue dans la sienne : la fusion n'enlève
jamais rien, elle ne fait qu'ajouter.

Concrètement pour l'usage prévu : tu remplis Paris de ton côté, Souad remplit
Montpellier du sien, et vous vous échangez vos liens.

### Où sont mes données

Dans ton navigateur, sur cet appareil, et nulle part ailleurs :

- progression, ambiances, notes et dates : `localStorage` ;
- photos : `IndexedDB`, redimensionnées à 1600 px de côté (plus une vignette).

Vider les données du site les efface. **Exporte régulièrement** si tu y tiens.
Si le navigateur bloque le stockage (navigation privée stricte), l'application
le dit et continue de fonctionner sans les photos.

## Mettre la carte en ligne

Le site est statique : aucun serveur, aucune base de données, donc rien à
dimensionner. Les étapes exactes sont dans **[DEPLOIEMENT.md](DEPLOIEMENT.md)** —
Cloudflare Pages est l'option recommandée, elle fonctionne avec un dépôt privé.

`python3 tools/build_single.py` produit en plus `dist/citywalker.html` :
l'application entière dans un seul fichier de 237 Ko, qui s'ouvre même par
double-clic, sans serveur.

En local :

```sh
python3 -m http.server 8000   # puis http://localhost:8000
```

Un `file://` direct ne marche pas : `fetch()` sur `data/*.json` est bloqué par le
navigateur.

## Développement

```
index.html            la page unique
assets/app.css        toute la mise en forme (thème clair et sombre)
assets/js/util.js     helpers DOM, dates, base64url, toasts
assets/js/model.js    ambiances, catégories, calcul de progression
assets/js/store.js    localStorage (progression) + IndexedDB (photos)
assets/js/exif.js     lecteur EXIF minimal : date de prise de vue et GPS
assets/js/photos.js   décodage, redimensionnement, vignette
assets/js/share.js    lien de partage, export/import, fusion
assets/js/map.js      carte SVG : rendu, pan/zoom, épingles
assets/js/ui.js       petits composants (anneau, barre, puce d'ambiance)
assets/js/main.js     orchestration
data/*.json           géométries projetées + lieux (généré, versionné)
tools/                pipeline de génération des données
tests/smoke.mjs       tests de bout en bout (Chromium headless)
```

Les scripts sont chargés en ordre et partagent l'objet global `CW` : pas de
bundler, pas de dépendance à l'exécution.

### Régénérer les données cartographiques

```sh
python3 tools/fetch_geo.py     # télécharge et met en cache (Overpass, Open Data Paris)
python3 tools/geocode.py       # géocode les listes curatées (Nominatim, 1 req/s)
python3 tools/build_geo.py     # écrit data/paris.json et data/montpellier.json
```

`build_geo.py` vérifie chaque lieu par **point-dans-polygone** contre les vraies
limites de quartier et refuse d'écrire un fichier incohérent. Les listes de lieux
sont éditées à la main dans `tools/spots/*.json` : ajouter un lieu, c'est ajouter
un objet `{id, name, cat, zone, query}` puis relancer les trois commandes.

### Tests

```sh
npm install
node tests/smoke.mjs
```

31 vérifications de bout en bout : rendu des deux cartes, cochage d'un lieu,
ambiances, filtres, recherche sans accent, persistance après rechargement,
changement de ville, zoom, lien de partage, mode lecture seule, fusion. Le test
échoue au moindre message d'erreur en console.

## Suite envisagée (v2)

- **Communes alentours** : Vincennes, Boulogne, Saint-Ouen côté Paris ;
  Palavas-les-Flots, Maguelone, Pic Saint-Loup côté Montpellier. La carte est
  aujourd'hui bornée à la commune, l'ajout demande d'élargir la projection et
  d'ajouter une couche de communes voisines.
- Vue « pellicule » : toutes les photos d'une ville sur une même page.
- Export d'une image de la carte à publier.

## Données

- Limites communales, quartiers de Montpellier, cours d'eau, parcs et
  coordonnées des lieux : **OpenStreetMap**, © les contributeurs, sous ODbL.
- Arrondissements de Paris : **Ville de Paris**, portail Open Data.
