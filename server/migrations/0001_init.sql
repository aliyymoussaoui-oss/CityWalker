-- CityWalker — schéma du serveur de synchronisation (Cloudflare D1, SQLite).
--
-- Les photos elles-mêmes vivent dans R2 sous « <user_id>/<photo_id> » ; cette
-- base n'en garde que la description et la taille, pour tenir les quotas.

CREATE TABLE users (
  id          TEXT PRIMARY KEY,           -- UUID aléatoire
  email       TEXT NOT NULL UNIQUE,       -- en minuscules ; sert d'identifiant, aucun mail n'est envoyé
  pw_salt     TEXT NOT NULL,              -- 16 octets aléatoires, en hexadécimal
  pw_hash     TEXT NOT NULL,              -- SHA-256(sel ‖ clé PBKDF2 dérivée par le navigateur)
  rc_salt     TEXT NOT NULL,
  rc_hash     TEXT NOT NULL,              -- SHA-256(sel ‖ clé de secours)
  bytes       INTEGER NOT NULL DEFAULT 0, -- octets de photos stockés
  created_at  INTEGER NOT NULL
);

CREATE TABLE sessions (
  token_hash   TEXT PRIMARY KEY,          -- SHA-256 du jeton : une fuite de la base ne donne aucune session
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL
);
CREATE INDEX sessions_by_user ON sessions(user_id, last_used_at);

CREATE TABLE progress (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  city       TEXT NOT NULL,
  data       TEXT NOT NULL,               -- JSON validé et resérialisé par le serveur
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, city)
);

CREATE TABLE photos (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id         TEXT NOT NULL,
  city       TEXT NOT NULL,
  spot       TEXT NOT NULL,
  w          INTEGER NOT NULL DEFAULT 0,
  h          INTEGER NOT NULL DEFAULT 0,
  taken_at   TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  size       INTEGER NOT NULL,
  type       TEXT NOT NULL,
  PRIMARY KEY (user_id, id)
);

-- Compteurs à fenêtre : essais de connexion, créations de compte, envois du jour.
CREATE TABLE throttle (
  key      TEXT PRIMARY KEY,
  count    INTEGER NOT NULL,
  reset_at INTEGER NOT NULL
);

-- Totaux globaux (octets stockés) : de quoi refuser un envoi plutôt que de
-- dépasser l'offre gratuite de R2.
CREATE TABLE usage (
  key   TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);

-- La ligne existe dès le départ : les réservations d'espace sont de simples
-- UPDATE conditionnels, atomiques.
INSERT INTO usage (key, value) VALUES ('bytes', 0);
