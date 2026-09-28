# Comptes et synchronisation

Facultatif : sans rien faire, CityWalker fonctionne entièrement sur l'appareil.
La synchronisation sert à retrouver sa carte — progression, ambiances, notes et
photos — sur un autre téléphone ou ordinateur, avec un compte.

## Pourquoi Cloudflare, et plus Supabase

Le projet Supabase gratuit s'est mis en pause tout seul après une semaine sans
activité ; son adresse a même disparu du DNS. C'est la règle de leur offre
gratuite, et elle aurait recommencé.

Le serveur tourne désormais chez **Cloudflare** (Workers + D1 + R2), dont l'offre
gratuite ne met rien en pause pour inactivité. Il fait moins de 700 lignes
(`server/src/index.js`) ; une base SQL (D1) garde les comptes et la
progression, un stockage d'objets (R2) garde les photos.

Et surtout, rien n'en dépend vraiment : chaque appareil garde toutes ses
données. Le serveur ne fait que relayer entre appareils. S'il disparaissait,
personne ne perdrait rien — il suffirait d'en remettre un en ligne et de
resynchroniser.

## Mise en route (une fois, dix minutes)

Tout le reste est automatique : à chaque poussée sur la branche par défaut, le
workflow « Publier sur GitHub Pages » crée ce qui manque chez Cloudflare (base,
stockage, adresse), met le serveur à jour, vérifie qu'il répond, puis publie le
site branché dessus.

1. **Créer un compte** sur [dash.cloudflare.com](https://dash.cloudflare.com/sign-up)
   (gratuit, aucune carte demandée à ce stade).

2. **Activer R2** pour les photos : menu **R2 Object Storage** → **Purchase R2
   Plan**. Cloudflare exige un moyen de paiement, mais l'offre gratuite couvre
   10 Go et un million d'envois par mois. Le serveur s'interdit de dépasser
   9 Go au total, 4 Go par compte et 20 000 envois par jour : il refuse
   poliment un envoi plutôt que de coûter quoi que ce soit.
   *Étape facultative* : sans R2, comptes et progression se synchronisent quand
   même, et les photos restent sur chaque appareil. Activer R2 plus tard suffit,
   le déploiement suivant s'en aperçoit tout seul.

3. **Créer un jeton d'API** : icône de profil → **My Profile → API Tokens →
   Create Token** → modèle **« Edit Cloudflare Workers »** → **Use template**.
   Dans « Permissions », ajouter une ligne **Account · D1 · Edit**. Dans
   « Account Resources », choisir ton compte. **Continue to summary → Create
   Token**, puis copier le jeton (il ne sera plus affiché).

4. **Noter l'identifiant de compte** : page d'accueil du tableau de bord, menu
   « ⋯ » à côté du nom du compte → **Copy account ID** (32 caractères).

5. **Les donner au dépôt GitHub** : **Settings → Secrets and variables → Actions
   → New repository secret**, deux fois :

   | Nom | Valeur |
   | --- | --- |
   | `CLOUDFLARE_API_TOKEN` | le jeton de l'étape 3 |
   | `CLOUDFLARE_ACCOUNT_ID` | l'identifiant de l'étape 4 |

6. **Relancer le déploiement** : onglet **Actions → Publier sur GitHub Pages →
   Run workflow**. Deux à cinq minutes plus tard, le journal de l'étape
   « Déployer le serveur de synchronisation » se termine par
   `en ligne : {"ok":true,…}` et le site est branché.

Ensuite, sur chaque appareil : **⚙ Réglages → Compte et synchronisation**.

## Côté utilisateur

- **Créer un compte** : une adresse e-mail et un mot de passe de 8 caractères.
  Aucun e-mail n'est jamais envoyé : l'adresse sert d'identifiant.
- **La clé de secours** s'affiche une seule fois, à la création du compte (ou à
  la demande, « Nouvelle clé de secours », mot de passe redemandé). Sans e-mail, c'est elle qui permet
  de choisir un nouveau mot de passe : **Mot de passe oublié ?** Elle se copie
  ou se télécharge en fichier texte.
- **Synchroniser** fusionne dans les deux sens ; la fusion ne retire jamais
  rien. La synchronisation automatique à l'ouverture se coche dans le même
  panneau.
- **Supprimer mon compte** efface tout ce qui est en ligne (le mot de passe est
  redemandé). Ce qui est sur l'appareil reste.

## Sécurité, en bref

- Le mot de passe ne quitte jamais l'appareil : le navigateur en dérive une clé
  (PBKDF2-SHA256, 600 000 tours) et n'envoie qu'elle. Le serveur la hache à son
  tour avec un sel aléatoire. Le calcul lent se fait sur l'appareil parce que le
  plan gratuit des Workers n'accorde que 10 ms de calcul par requête ; une fuite
  de la base n'en oblige pas moins un attaquant à payer les 600 000 tours pour
  chaque mot de passe essayé.
- Les sessions sont des jetons aléatoires ; la base n'en garde que l'empreinte.
- Les essais de connexion sont limités (par adresse, par IP) ; les créations de
  compte aussi. Chaque tentative est comptée avant d'être examinée, en une
  seule écriture : des requêtes lancées en rafale ne passent pas entre les
  mailles.
- Les plafonds de stockage sont réservés avant l'envoi par des écritures
  atomiques : des envois simultanés ne peuvent pas les dépasser.
- Changer la clé de secours ou supprimer le compte redemande le mot de passe :
  un jeton de session volé ne suffit pas à prendre le compte.
- Chaque photo est rangée sous l'identifiant de son compte : impossible
  d'atteindre celle d'un autre, même en devinant son nom. Seules les images
  (JPEG, PNG, WebP) sont acceptées.

## Et les données de l'ancien Supabase ?

Elles sont toujours sur les appareils qui s'étaient synchronisés. Crée ton
compte sur le nouveau serveur depuis l'un d'eux et synchronise : tout repart en
ligne. Si un appareil a été vidé entre-temps, le projet Supabase en pause peut
encore être réactivé depuis son tableau de bord (Supabase le permet pendant
90 jours) le temps de récupérer une sauvegarde.

## Développer et tester en local

Aucun compte Cloudflare n'est nécessaire : `wrangler dev` fait tourner le
serveur dans le moteur de Cloudflare, avec une base et un stockage locaux.

```sh
npm install
cd server && npx wrangler d1 migrations apply citywalker --local && npx wrangler dev
```

```sh
node tests/api.mjs      # le serveur seul : 70 vérifications, attaques en parallèle comprises
node tests/cloud.mjs    # de vrais navigateurs contre le vrai serveur local
node tests/deploy.mjs   # server/deploy.sh face à une imitation de l'API Cloudflare
```
