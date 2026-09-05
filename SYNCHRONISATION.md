# Comptes et synchronisation

Par défaut CityWalker ne demande aucun compte et n'envoie rien nulle part. Un
compte ne sert qu'à une chose : **retrouver sa carte et ses photos sur un autre
appareil**. Tant que rien n'est configuré, l'application fonctionne exactement
comme avant, en local.

La synchronisation s'appuie sur [Supabase](https://supabase.com), dont l'offre
gratuite (500 Mo de base, 1 Go de fichiers) suffit largement. CityWalker parle à
son API REST directement, sans SDK ni dépendance.

## Mise en place, une fois pour toutes

### 1. Créer le projet

[supabase.com](https://supabase.com) → *New project*. Note deux valeurs dans
*Project Settings → API* :

- l'**URL du projet** (`https://xxxx.supabase.co`) ;
- la clé **anon public**. Elle est publique par conception : ce sont les règles
  RLS ci-dessous qui protègent les données, pas le secret de cette clé. Ne colle
  jamais la clé `service_role`.

### 2. Créer les tables

*SQL Editor* → coller ceci → *Run*.

```sql
-- Une ligne de progression par utilisateur et par ville.
create table public.progress (
  user_id    uuid        not null references auth.users on delete cascade,
  city       text        not null,
  data       jsonb       not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, city)
);

alter table public.progress enable row level security;

create policy "chacun ne voit et n'écrit que ses lignes"
  on public.progress for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Le catalogue des photos ; les fichiers eux-mêmes vont dans le stockage.
create table public.photos (
  id         text   not null,
  user_id    uuid   not null references auth.users on delete cascade,
  city       text   not null,
  spot       text   not null,
  w          int,
  h          int,
  taken_at   text,
  created_at bigint,
  primary key (user_id, id)
);

alter table public.photos enable row level security;

create policy "chacun ne voit et n'écrit que ses photos"
  on public.photos for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
```

### 3. Créer le bac de stockage

*Storage* → *New bucket* → nom `photos`, **privé** (ne pas cocher « Public
bucket »). Puis, de nouveau dans *SQL Editor* :

```sql
-- Chaque utilisateur n'accède qu'au dossier qui porte son identifiant.
create policy "photos : lecture de son dossier"
  on storage.objects for select
  using (bucket_id = 'photos' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "photos : écriture dans son dossier"
  on storage.objects for insert
  with check (bucket_id = 'photos' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "photos : remplacement dans son dossier"
  on storage.objects for update
  using (bucket_id = 'photos' and (storage.foldername(name))[1] = auth.uid()::text);
```

### 4. Autoriser le site

*Authentication → URL Configuration* : ajoute l'adresse du site dans *Site URL*
et dans *Redirect URLs*.

Si tu veux te connecter sans passer par la confirmation par e-mail pendant les
essais : *Authentication → Providers → Email* → décocher *Confirm email*.

### 5. Renseigner l'application

Dans CityWalker : **⚙ Réglages → Compte et synchronisation**, coller l'URL et la
clé anon, puis créer un compte. Les deux valeurs restent dans le navigateur ; il
n'y a rien à modifier dans le code ni à redéployer.

Pour figer la configuration dans le site plutôt que la saisir sur chaque
appareil, définis-la avant le chargement des scripts :

```html
<script>window.CW_CONFIG = { supabaseUrl: 'https://xxxx.supabase.co', supabaseAnonKey: '…' };</script>
```

## Ce qui se passe à la synchronisation

1. Pour chaque ville, la progression distante est récupérée et **fusionnée** avec
   la locale. La fusion ne retire jamais rien : si deux appareils divergent,
   l'union des deux gagne. Un lieu coché quelque part reste coché partout.
2. Le résultat est renvoyé au serveur.
3. Les photos présentes ici mais pas là-bas sont envoyées ; celles présentes
   là-bas mais pas ici sont téléchargées.

Il n'y a pas de synchronisation automatique en arrière-plan : elle se déclenche
au bouton. C'est volontaire — pas de trafic surprise, pas de conflit invisible.

## Ce qui n'est pas fait

- Pas de réinitialisation de mot de passe dans l'interface : elle passe par
  Supabase.
- Pas de partage de compte à plusieurs. Pour montrer sa carte à quelqu'un, le
  lien de partage reste la bonne réponse, et il ne demande aucun compte.
- Les photos téléchargées depuis le serveur n'ont pas de vignette séparée : la
  version pleine sert des deux côtés.

## Tester sans Supabase

`node tests/cloud.mjs` lance un serveur qui imite les points d'entrée utilisés
et rejoue le scénario complet : création de compte, envoi, connexion depuis un
second navigateur, réception de la carte et de la photo, refus d'un mauvais mot
de passe. Aucun compte réel n'est nécessaire.
