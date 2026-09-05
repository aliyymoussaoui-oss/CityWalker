# Mettre CityWalker en ligne

CityWalker est un site **statique** : des fichiers, aucun serveur, aucune base de
données. Il n'y a donc rien à dimensionner — les fichiers sont servis par le CDN
de l'hébergeur, et le coût comme la charge restent les mêmes que la carte soit
ouverte par deux personnes ou par cent mille. Les données de chacun (lieux
cochés, notes, photos) vivent dans son propre navigateur et ne transitent jamais
par l'hébergeur.

Il y a deux formes livrées :

| Fichier | Usage |
| --- | --- |
| `index.html` + `assets/` + `data/` | le site complet, à publier sur un hébergement |
| `dist/citywalker.html` | l'application entière en **un seul fichier** (237 Ko), qui s'ouvre même par double-clic |

Régénérer le fichier unique après une modification :

```sh
python3 tools/build_single.py
```

## Cloudflare Pages — recommandé

Gratuit, CDN mondial, fonctionne avec un **dépôt privé**, domaine personnalisé
inclus.

1. [dash.cloudflare.com](https://dash.cloudflare.com) → **Workers & Pages** →
   *Create* → *Pages* → *Connect to Git*.
2. Autoriser GitHub, choisir `aliyymoussaoui-oss/CityWalker`.
3. Branche de production : `claude/paris-montpellier-photo-maps-7nh7q2`.
4. **Framework preset** : *None*. **Build command** : laisser vide.
   **Build output directory** : `/`.
5. *Save and Deploy*.

L'adresse obtenue ressemble à `https://citywalker.pages.dev` — c'est le lien à
envoyer. Chaque `git push` redéploie tout seul. Un domaine à toi s'ajoute dans
*Custom domains*.

## Netlify

Même principe : *Add new site* → *Import an existing project* → GitHub → dépôt →
build command vide, publish directory `.`.

Pour un lien **immédiat sans connecter le dépôt**, [netlify.com/drop](https://app.netlify.com/drop) :
glisser le dossier du projet dans la page suffit à obtenir une URL.

## Vercel

*Add New* → *Project* → dépôt → framework *Other* → build command vide → *Deploy*.

## GitHub Pages

`Settings → Pages → Deploy from a branch`, branche
`claude/paris-montpellier-photo-maps-7nh7q2`, dossier `/ (root)`.

Attention : **sur un dépôt privé, GitHub Pages n'est pas disponible en accès
public** avec un compte gratuit. Il faut soit rendre le dépôt public, soit passer
par un des hébergeurs ci-dessus. Rendre ce dépôt public n'expose rien de
personnel : il ne contient que le code et les données cartographiques ouvertes,
jamais de photos ni de progression.

## Vérifier après déploiement

1. La carte de Paris s'affiche avec ses épingles.
2. Cocher un lieu, recharger la page : le lieu reste coché.
3. **Partager → Copier le lien**, ouvrir ce lien dans une fenêtre privée : la
   carte s'ouvre en lecture seule avec le bandeau de l'auteur.

Le partage repose sur le fragment d'URL (`#p=…`), qui n'est jamais envoyé au
serveur : un lien partagé reste lisible même si l'hébergeur change.
