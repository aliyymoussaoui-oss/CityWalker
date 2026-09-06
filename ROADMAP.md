# Roadmap

## v1 — livrée

- Deux cartes vectorielles autonomes, Paris (155 lieux, 20 arrondissements) et
  Montpellier (85 lieux, 7 quartiers).
- Lieux cochés, 14 ambiances, date, note, coup de cœur, photos.
- **Lieux posés à la main** n'importe où sur la carte, avec nom, catégorie,
  quartier déduit de la géométrie et coordonnées réelles.
- **Tirage au hasard** parmi les lieux qui restent à faire.
- Progression globale, par quartier, catégorie et ambiance.
- Lien de partage en lecture seule, fusion sans perte, export/import complet.
- **Import de photothèque** : les photos géolocalisées sont replacées toutes
  seules sur les lieux où elles ont été prises, et regroupées en nouveaux lieux
  quand elles tombent loin de tout.
- **Comptes et synchronisation** facultatifs entre appareils.
- **Fond détaillé** en tuiles CARTO : rues, noms de rues et communes alentours,
  en trois styles. Facultatif, la carte vectorielle suffit sans lui.
- Installable depuis le navigateur (PWA) et utilisable hors ligne.

## v1.1 — communes alentours (fait)

La projection englobe désormais les lieux des communes voisines, regroupés sous
un quartier « Alentours ». Un lieu posé à la main hors de la commune y tombe
tout seul, comme une photo importée dont le GPS pointe au-delà.

Côté Paris : château de Vincennes, basilique de Saint-Denis, puces de
Saint-Ouen, Grande Arche, domaine de Saint-Cloud, jardins Albert-Kahn.
Côté Montpellier : Palavas-les-Flots, Carnon-Plage, cathédrale de Maguelone,
site archéologique Lattara.

Il n'y a volontairement pas de polygone pour ces communes : le fond détaillé
les montre bien mieux qu'un tracé de plus, et le pourcentage de la ville reste
celui de la commune.

## v1.3 — vue France

Une carte de France en entrée, les villes couvertes en épingles, un clic ouvre
la ville. Même mécanique que les cartes existantes : silhouette de l'Hexagone
depuis OpenStreetMap, projection Mercator, et le fond détaillé par-dessus.
La couche de tuiles fonctionne déjà à tous les niveaux de zoom, il n'y a que la
géométrie de la France et la navigation entre les deux échelles à écrire.

## v1.2 — Lyon (fait)

Le pipeline est générique : une ville se déclare par un bloc dans `CITY_META`
(nom, accent, tolérances, d'où viennent ses quartiers) et une liste
`tools/spots/<ville>.json`. Paris garde sa source Open Data ; toutes les autres
villes lisent leurs quartiers depuis OpenStreetMap avec la même fonction.

**Lyon est livré** : 9 arrondissements (niveau administratif 9 dans
OpenStreetMap — le niveau 10 y désigne les conseils de quartier, qui ne
couvrent pas la ville), 53 lieux dont Bron, Collonges-au-Mont-d'Or et
Vaulx-en-Velin sous « Alentours ».

Deux défauts du pipeline sont tombés au passage :

- les calques eau et verdure lisaient toujours le cache de Montpellier, quelle
  que soit la ville demandée ;
- ils étaient filtrés élément par élément, sur le centroïde. « Le Rhône » est
  une seule relation OpenStreetMap qui descend jusqu'à la Méditerranée : son
  centroïde tombe près d'Arles, et le fleuve disparaissait de Lyon. Le filtre
  travaille désormais anneau par anneau, sur le cadre réellement affiché. Paris
  y gagne la Marne et la Seine hors les murs, Montpellier ses étangs.

Ajouter une ville :

```sh
# 1. écrire tools/spots/<ville>.json  (~50 lieux, une heure de curation)
#    et son bloc CITY_META + ses requêtes Overpass
python3 tools/fetch_geo.py
python3 tools/geocode.py <ville>
python3 tools/build_geo.py
# 2. ajouter '<ville>' à CW.CITY_ORDER dans assets/js/model.js
#    et son onglet dans index.html
```

Restent ensuite Bordeaux, Marseille, Toulouse, Nantes, Lisbonne, Séville : même
recette, une heure de curation chacune. C'est l'atout principal du projet —
ajouter cinquante villes est un week-end de curation, pas une équipe.

## v2 — application mobile

L'application est déjà une PWA : installable, plein écran, hors ligne. C'est
90 % de la valeur pour 0 € et zéro validation de store. Les étapes suivantes ne
se justifient que par des capacités réellement natives.

### Étape 1 — PWA et interface téléphone (fait)

`manifest.webmanifest`, `sw.js`, icônes, et un parcours d'installation guidé
(Menu → Installer) qui utilise l'invite native sur Android et donne les étapes
exactes sur iOS.

L'interface téléphone a été refaite : barre du haut réduite à la marque et aux
villes, le reste dans un menu ; carte à sa proportion réelle avec, sous elle, un
aperçu de progression et les prochains lieux à faire ; fiche en feuille du bas
que l'on referme en la tirant ; cibles tactiles élargies sur les épingles.
Limite iOS à connaître : le stockage d'un site web peut être purgé après
plusieurs semaines sans visite. L'export reste donc la vraie sauvegarde tant
qu'il n'y a pas de compte.

### Étape 2 — Capacitor

[Capacitor](https://capacitorjs.com) emballe le site tel quel dans un binaire
iOS et Android. Aucun code à réécrire : le dossier du site devient le `webDir`.
Ce que ça débloque :

- présence sur l'App Store et le Play Store ;
- stockage durable, sans purge ;
- accès direct à l'appareil photo et à la photothèque ;
- géolocalisation en tâche de fond.

Coût : 99 $/an (Apple), 25 $ une fois (Google), plus le temps de publication.

### Étape 3 — ce qui justifie vraiment le natif

- **Accès complet à la photothèque.** C'est la limite dure du web : aucun
  navigateur, iOS compris, ne donne à un site l'accès à toute la photothèque.
  Le sélecteur système est le seul chemin — on peut y faire « Tout sélectionner »,
  et l'import gère des milliers de photos, mais l'utilisateur doit passer par ce
  geste. Seule une application native (étape 2) peut lire la photothèque
  directement et surveiller les nouvelles photos.
- **Alerte de proximité** : « tu es à 120 m du parc de Belleville, jamais
  photographié, et le soleil se couche dans 25 minutes ».
- **Éphémérides par lieu** : heure du lever et du coucher, azimut du soleil,
  calculés localement. Prolongement naturel des ambiances déjà en place.
- **Widget** : le pourcentage de la ville sur l'écran d'accueil.

### Étape 4 — comptes et synchronisation (fait)

Comptes par e-mail et mot de passe, progression et photos synchronisées, fusion
sans perte. Éteint par défaut : sans configuration, rien ne sort de l'appareil.
Voir [SYNCHRONISATION.md](SYNCHRONISATION.md).

Ce qui reste : réinitialisation du mot de passe dans l'interface, connexion par
lien magique, et synchronisation automatique en arrière-plan plutôt qu'au bouton.

## Idées non planifiées

Faites : la pellicule, l'image carrée de la carte, la balade en cinq lieux.

Reste : le mode duo, deux cartes côte à côte, la tienne et celle de quelqu'un
d'autre — le lien de partage en donne déjà l'essentiel.
