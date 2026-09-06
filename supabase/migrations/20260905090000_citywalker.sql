-- CityWalker — schéma de synchronisation.
--
-- Appliqué automatiquement par l'intégration GitHub de Supabase à chaque
-- poussée. Entièrement idempotent : le rejouer ne casse rien.
--
-- Deux tables et un bac de stockage privé. Chaque personne ne voit et n'écrit
-- que ses propres lignes et son propre dossier de photos : ce sont ces règles,
-- et non le secret de la clé « anon », qui protègent les données.

-- ---------------------------------------------------------------- progression

create table if not exists public.progress (
  user_id    uuid        not null references auth.users on delete cascade,
  city       text        not null,
  data       jsonb       not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, city)
);

alter table public.progress enable row level security;

drop policy if exists "progress : chacun ses lignes" on public.progress;
create policy "progress : chacun ses lignes"
  on public.progress for all
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- --------------------------------------------------------------------- photos
-- Le catalogue ; les fichiers eux-mêmes vont dans le stockage.

create table if not exists public.photos (
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

drop policy if exists "photos : chacun ses lignes" on public.photos;
create policy "photos : chacun ses lignes"
  on public.photos for all
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create index if not exists photos_user_city_idx on public.photos (user_id, city);

-- ------------------------------------------------------------------ stockage
-- Bac privé : chaque personne n'accède qu'au dossier qui porte son identifiant.

insert into storage.buckets (id, name, public)
values ('photos', 'photos', false)
on conflict (id) do nothing;

drop policy if exists "photos : lecture de son dossier" on storage.objects;
create policy "photos : lecture de son dossier"
  on storage.objects for select
  to authenticated
  using (bucket_id = 'photos' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "photos : dépôt dans son dossier" on storage.objects;
create policy "photos : dépôt dans son dossier"
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'photos' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "photos : remplacement dans son dossier" on storage.objects;
create policy "photos : remplacement dans son dossier"
  on storage.objects for update
  to authenticated
  using (bucket_id = 'photos' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'photos' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "photos : suppression dans son dossier" on storage.objects;
create policy "photos : suppression dans son dossier"
  on storage.objects for delete
  to authenticated
  using (bucket_id = 'photos' and (storage.foldername(name))[1] = auth.uid()::text);
