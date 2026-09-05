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
| `dist/citywalker.html` | l'application entière en **un seul fichier** (250 Ko), qui s'ouvre même par double-clic |
| `dist/site/` | le même fichier nommé `index.html` : un dossier prêt à déposer tel quel |

## Le plus rapide : glisser un dossier

[app.netlify.com/drop](https://app.netlify.com/drop) : glisse le dossier
`dist/site/` dans la page. Une URL publique apparaît en quelques secondes, sans
compte. C'est la voie la plus courte pour avoir un lien à envoyer aujourd'hui.
Elle ne donne ni installation en application ni mode hors ligne — pour ça, il
faut publier le site complet, ci-dessous.

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

## GitHub Pages — le dépôt est déjà prêt

Le dépôt est public, la branche `public` porte le site, et le workflow
`.github/workflows/pages.yml` attend. **Il reste un seul réglage, que seule une
personne propriétaire du dépôt peut faire** : l'API qui crée un site Pages
n'accepte ni le jeton d'un agent ni celui d'un workflow tant que Pages n'a jamais
été activé.

1. `github.com/aliyymoussaoui-oss/CityWalker` → **Settings** → **Pages**
2. *Build and deployment* → **Source : GitHub Actions**

C'est tout. Le workflow se déclenche à la poussée suivante — ou tout de suite
depuis l'onglet *Actions* → *Publier sur GitHub Pages* → *Run workflow*.

L'adresse sera `https://aliyymoussaoui-oss.github.io/CityWalker/`.

### L'ancienne méthode

## GitHub Pages

`Settings → Pages → Deploy from a branch`, branche `public`, dossier `/ (root)`.
Fonctionne aussi, mais sans les vérifications du workflow.

## Vérifier après déploiement

1. La carte de Paris s'affiche avec ses épingles.
2. Cocher un lieu, recharger la page : le lieu reste coché.
3. **Partager → Copier le lien**, ouvrir ce lien dans une fenêtre privée : la
   carte s'ouvre en lecture seule avec le bandeau de l'auteur.

Le partage repose sur le fragment d'URL (`#p=…`), qui n'est jamais envoyé au
serveur : un lien partagé reste lisible même si l'hébergeur change.
