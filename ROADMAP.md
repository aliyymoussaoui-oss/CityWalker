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

## v1.2 — autres villes (à faire)

Le pipeline coûte environ une heure par ville : écrire `tools/spots/<ville>.json`
puis lancer les trois commandes. Lyon, Bordeaux, Marseille, Toulouse, Nantes,
Lisbonne, Séville. C'est l'atout principal du projet : ajouter cinquante villes
est un week-end, pas une équipe.

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
