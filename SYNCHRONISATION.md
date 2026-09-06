# Comptes et synchronisation

Par défaut CityWalker ne demande aucun compte et n'envoie rien nulle part. Un
compte ne sert qu'à une chose : **retrouver sa carte et ses photos sur un autre
appareil**. Sans configuration, tout fonctionne en local, comme avant.

Le dépôt contient tout ce qu'il faut côté base. Il ne reste que deux valeurs à
renseigner.

## 1. Le schéma s'applique tout seul

`supabase/migrations/` contient la migration complète : les tables `progress` et
`photos`, leurs règles RLS, le bac de stockage privé `photos` et ses politiques.
L'intégration GitHub de Supabase l'applique à chaque poussée sur la branche
raccordée.

Pour vérifier : tableau de bord Supabase → **Database → Migrations**, la
migration `citywalker` doit apparaître comme appliquée. Sinon, **Table Editor**
doit montrer `progress` et `photos`, et **Storage** un bac `photos` privé.

Si l'intégration n'est pas active, le même fichier se colle tel quel dans
**SQL Editor** → *Run*. Il est idempotent : le rejouer ne casse rien.

## 2. Les deux valeurs à renseigner

Dans Supabase, **Project Settings → API** :

- l'**URL du projet**, `https://xxxx.supabase.co` ;
- la clé **anon public**. Elle est publique par conception : ce sont les règles
  RLS ci-dessus qui protègent les données. Ne colle jamais la clé
  `service_role`.

Trois façons de les fournir, de la plus durable à la plus rapide.

**a. Variables de dépôt GitHub — recommandé.** Dépôt → *Settings* → *Secrets and
variables* → *Actions* → onglet **Variables** → *New repository variable* :

| Nom | Valeur |
| --- | --- |
| `SUPABASE_URL` | `https://xxxx.supabase.co` |
| `SUPABASE_ANON_KEY` | la clé anon |

Le workflow de publication réécrit `assets/js/config.js` au déploiement. Rien à
committer, rien à saisir sur chaque appareil, et la synchronisation est active
pour tout le monde dès la poussée suivante.

**Condition indispensable** : dépôt → *Settings* → *Pages* → *Build and
deployment* → **Source : GitHub Actions**. Avec « Deploy from a branch », GitHub
republie le dépôt brut par-dessus l'artefact du workflow, et le fichier injecté
n'atteint jamais le visiteur — l'injection réussit dans le journal, mais le site
sert quand même une configuration vide.

Peu importe laquelle des adresses Supabase est collée : celle du projet, de
l'API REST ou de l'auth. Elle est ramenée à l'origine du projet, à l'injection
comme à l'exécution.

**b. Dans le dépôt.** Écrire les deux valeurs dans `assets/js/config.js` et
pousser.

**c. Sur l'appareil.** **⚙ Réglages → Compte et synchronisation** : coller les
deux valeurs. Utile pour essayer sans toucher au dépôt, mais à refaire sur
chaque appareil.

## 3. Autoriser le site

**Authentication → URL Configuration** : mettre
`https://aliyymoussaoui-oss.github.io/CityWalker/` dans *Site URL* et dans
*Redirect URLs*. Sans cela, le lien de connexion et la réinitialisation de mot
de passe renverront vers la mauvaise adresse.

Pour essayer sans attendre le mail de confirmation :
**Authentication → Providers → Email** → décocher *Confirm email*.

## 4. Utiliser

**⚙ Réglages → Compte et synchronisation** → créer un compte, puis
*Synchroniser maintenant*. La case « synchroniser automatiquement à l'ouverture »
est cochée par défaut.

Mot de passe oublié et connexion par lien sans mot de passe sont sur le même
écran.

## Ce qui se passe à la synchronisation

1. Pour chaque ville, la progression distante est récupérée et **fusionnée**
   avec la locale. La fusion ne retire jamais rien : si deux appareils
   divergent, l'union des deux gagne.
2. Le résultat est renvoyé au serveur.
3. Les photos présentes ici mais pas là-bas sont envoyées ; celles présentes
   là-bas mais pas ici sont téléchargées.

## Ce qui n'est pas fait

- Pas de partage de compte à plusieurs. Pour montrer sa carte à quelqu'un, le
  lien de partage reste la bonne réponse, et il ne demande aucun compte.
- Les photos téléchargées depuis le serveur n'ont pas de vignette séparée : la
  version pleine sert des deux côtés.

## Tester sans Supabase

`node tests/cloud.mjs` lance un serveur qui imite les points d'entrée utilisés
et rejoue le scénario complet : création de compte, envoi, connexion depuis un
second navigateur, réception de la carte et de la photo, refus d'un mauvais mot
de passe. Aucun compte réel n'est nécessaire.
