# CityWalker

Trois cartes sobres — **Paris**, **Montpellier** et **Lyon** — pour épingler les lieux que
tu as déjà photographiés, noter dans quelle ambiance (coucher de soleil, nuit,
pluie, brume…), y attacher tes photos, et suivre ton pourcentage de découverte
de la ville et de ses quartiers.

Une seule page, aucun serveur obligatoire. Tout reste sur ton appareil — et si
tu veux retrouver ta carte ailleurs, un compte facultatif la synchronise.

- **161 lieux à Paris** : les 20 arrondissements, plus Vincennes, Saint-Denis,
  Saint-Ouen, la Défense, Saint-Cloud et Boulogne.
- **89 lieux à Montpellier** : les 7 grands quartiers, plus Palavas, Carnon,
  Maguelone et Lattes.
- **53 lieux à Lyon** : les 9 arrondissements, plus Bron, Collonges-au-Mont-d'Or
  et Vaulx-en-Velin.
- **Autant de lieux à toi que tu veux**, posés n'importe où sur la carte. Ils
  sont comptés à part, pour que le pourcentage de la ville reste honnête.
- **Vue France** : l'Hexagone, une épingle par ville couverte et son
  pourcentage — un clic ouvre la ville.
- Installable comme une application depuis le navigateur (Menu → Installer),
  utilisable hors ligne, pensée pour le téléphone.
- Cartes vectorielles dessinées à partir des données officielles : silhouette de
  la commune, limites de quartiers, cours d'eau, parcs. Rien à charger, la carte
  fonctionne hors ligne une fois la page ouverte.
- **Rues, noms de rues et communes alentours** dès l'ouverture, en trois styles
  — Chaleureux, Sobre, Sombre. Hors ligne ou réseau filtré, la carte vectorielle
  reprend la main toute seule : rien à régler, rien à comprendre.
- Trois couches au choix : tout, les lieux touristiques seuls, tes lieux seuls.

## Comment ça marche

1. Choisis la ville en haut à gauche.
2. Clique une épingle sur la carte, ou un lieu dans la liste de droite.
3. Bouton **« Je l'ai photographié »**, puis coche les ambiances capturées.
4. **Mes photos** : autorise l'accès à ta photothèque, et CityWalker replace tes
   photos toutes seules sur les lieux où elles ont été prises, en lisant leur
   position GPS. Rien ne quitte l'appareil, et rien n'est écrit sans ton accord.
5. Pas dans la liste ? **＋ Poser un lieu** sur la carte, puis clique où tu veux :
   le quartier et les coordonnées sont déduits tout seuls. **🎲 Au hasard** tire
   un lieu qu'il te reste à faire.
6. Ajoute tes photos à la main : elles sont redimensionnées et rangées dans le navigateur.
   Si la photo porte une date EXIF, elle remplit la date toute seule ; si elle
   porte des coordonnées GPS, l'application signale le lieu le plus proche.
7. L'onglet **Progression** donne le pourcentage global, le détail par quartier,
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

### Synchroniser entre plusieurs appareils

Facultatif, éteint par défaut. **⚙ Réglages → Compte et synchronisation** : colle
l'URL et la clé publique d'un projet [Supabase](https://supabase.com) gratuit,
crée un compte, et ta progression comme tes photos suivent d'un appareil à
l'autre. La fusion ne retire jamais rien. Mise en place détaillée, schéma SQL
compris, dans **[SYNCHRONISATION.md](SYNCHRONISATION.md)**.

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

Ouvrir `index.html` par double-clic ne marche pas : `fetch()` sur `data/*.json`
est bloqué en `file://`. C'est justement ce que résout `dist/citywalker.html`,
qui embarque les données.

## Développement

```
index.html            la page unique
assets/app.css        toute la mise en forme (thème clair et sombre)
assets/js/util.js     helpers DOM, dates, base64url, toasts
assets/js/model.js    ambiances, catégories, calcul de progression
assets/js/store.js    localStorage (progression) + IndexedDB (photos)
assets/js/exif.js     lecteur EXIF minimal : date de prise de vue et GPS
assets/js/photos.js   décodage, redimensionnement, vignette
assets/js/import.js   import de photothèque : lecture GPS, regroupement, rapport
assets/js/config.js   URL Supabase, clé anon, clé CARTO (injectées au déploiement)
assets/js/cloud.js    comptes et synchronisation (API REST Supabase, sans SDK)
assets/js/tiles.js    fond détaillé en tuiles CARTO, placé sans bibliothèque
assets/js/share.js    lien de partage, export/import, fusion
assets/js/map.js      carte SVG : rendu, pan/zoom, épingles
assets/js/ui.js       petits composants (anneau, barre, puce d'ambiance)
assets/js/main.js     orchestration
data/*.json           géométries projetées + lieux (généré, versionné)
tools/                pipeline de génération des données
tools/build_single.py fabrique dist/citywalker.html et dist/artifact.html
tests/smoke.mjs       tests de bout en bout (Chromium headless)
tests/single.mjs      vérifie le fichier unique hors serveur
tests/cloud.mjs       comptes et synchronisation, contre un faux Supabase
manifest.webmanifest  installation en application
sw.js                 cache hors ligne
DEPLOIEMENT.md        mise en ligne, hébergeur par hébergeur
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
node tests/smoke.mjs     # 50 vérifications sur le site
node tests/single.mjs    # le fichier unique, ouvert en file://
node tests/cloud.mjs     # 15 vérifications sur les comptes et la synchro
```

65 vérifications de bout en bout : rendu des deux cartes, cochage d'un lieu,
ambiances, filtres, recherche sans accent, persistance après rechargement,
changement de ville, zoom, pose d'un lieu à la main, tirage au hasard, lien de
partage, mode lecture seule, fusion, et un import de photothèque complet sur de
vraies photos porteuses d'EXIF GPS fabriquées par `tools/make_fixtures.mjs`. Le
test échoue au moindre message d'erreur en console.

## Suite

- **[ROADMAP.md](ROADMAP.md)** — communes alentours, autres villes, et le chemin
  vers une application mobile (la PWA est déjà là, Capacitor ensuite).
- **[ETUDE-COMMERCIALE.md](ETUDE-COMMERCIALE.md)** — ce que ça peut rapporter,
  ce que ça ne rapportera pas, et dans quel ordre le tester.

## Données

- Limites communales, quartiers de Montpellier, cours d'eau, parcs et
  coordonnées des lieux : **OpenStreetMap**, © les contributeurs, sous ODbL.
- Arrondissements de Paris : **Ville de Paris**, portail Open Data.
