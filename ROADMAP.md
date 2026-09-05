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
- Installable depuis le navigateur (PWA) et utilisable hors ligne.

## v1.1 — communes alentours

La carte est aujourd'hui bornée à la commune. Ajouter les alentours demande :

1. élargir la bbox et la projection de chaque ville dans `tools/fetch_geo.py` ;
2. ajouter une couche « communes voisines » dessinée en retrait, sous les
   quartiers, avec son propre style discret ;
3. décider du comptage : les lieux hors commune forment un groupe séparé, comme
   « Mes lieux », pour ne pas diluer le pourcentage de la ville.

Cibles : Vincennes, Boulogne, Saint-Ouen, Saint-Denis côté Paris ;
Palavas-les-Flots, Villeneuve-lès-Maguelone, Lattes, Pic Saint-Loup côté
Montpellier.

## v1.2 — autres villes

Le pipeline coûte environ une heure par ville : écrire `tools/spots/<ville>.json`
puis lancer les trois commandes. Lyon, Bordeaux, Marseille, Toulouse, Nantes,
Lisbonne, Séville. C'est l'atout principal du projet : ajouter cinquante villes
est un week-end, pas une équipe.

## v2 — application mobile

L'application est déjà une PWA : installable, plein écran, hors ligne. C'est
90 % de la valeur pour 0 € et zéro validation de store. Les étapes suivantes ne
se justifient que par des capacités réellement natives.

### Étape 1 — PWA (fait)

`manifest.webmanifest`, `sw.js`, icônes. Sur Android, Chrome propose
« Installer ». Sur iOS, *Partager → Sur l'écran d'accueil*.
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

- **Scan de la photothèque** : parcourir les photos géolocalisées de l'appareil
  et proposer « ces 34 photos sont sur des lieux de ta carte, on les épingle ? ».
  C'est la fonctionnalité qui transforme l'outil : la carte se remplit toute
  seule au premier lancement. À faire entièrement sur l'appareil, sans envoi.
- **Alerte de proximité** : « tu es à 120 m du parc de Belleville, jamais
  photographié, et le soleil se couche dans 25 minutes ».
- **Éphémérides par lieu** : heure du lever et du coucher, azimut du soleil,
  calculés localement. Prolongement naturel des ambiances déjà en place.
- **Widget** : le pourcentage de la ville sur l'écran d'accueil.

### Étape 4 — comptes et synchronisation

À ne faire qu'une fois qu'il y a des utilisateurs qui le réclament. Tout ce qui
existe aujourd'hui fonctionne sans serveur, donc sans coût ni fuite de données.
Un compte apporte la synchronisation multi-appareils et le partage des photos ;
il apporte aussi de l'hébergement à payer, de la modération et du RGPD.

## Idées non planifiées

- Vue « pellicule » : toutes les photos d'une ville sur une page.
- Export d'une image de la carte, format carré, à publier.
- Itinéraire : enchaîner cinq lieux non faits en une balade.
- Mode duo : deux cartes côte à côte, la tienne et celle de quelqu'un d'autre.
