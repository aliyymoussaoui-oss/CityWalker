/**
 * CityWalker — serveur de synchronisation (Cloudflare Worker + D1 + R2).
 *
 * Comptes, progression par ville et photos, rien de plus. L'application reste
 * « local d'abord » : chaque appareil garde tout, ce serveur ne fait que
 * relayer entre appareils. S'il disparaissait, personne ne perdrait rien.
 *
 * Mots de passe. Le navigateur dérive une clé PBKDF2-SHA256 (600 000 tours,
 * sel tiré de l'adresse) et n'envoie que cette clé ; le serveur la hache à son
 * tour, avec un sel aléatoire. Deux raisons à ce partage :
 *   - le plan gratuit des Workers n'accorde que 10 ms de CPU par requête, bien
 *     moins qu'un hachage lent — il échouerait une fois sur deux ;
 *   - le mot de passe lui-même ne quitte jamais l'appareil.
 * Une fuite de la base n'en devient pas moins coûteuse : pour tester un mot de
 * passe, un attaquant doit toujours payer les 600 000 tours.
 *
 * Aucun e-mail n'est envoyé. Un mot de passe oublié se remplace avec la clé de
 * secours affichée à la création du compte.
 *
 * Coûts. Des plafonds (octets par compte, octets au total, envois par jour)
 * font échouer les envois bien avant l'offre gratuite de R2 : mieux vaut un
 * refus poli qu'une facture.
 */

const VERSION = '2026-09-28';

const DEFAULTS = {
  MAX_PROGRESS_BYTES: 1_000_000,
  MAX_PHOTO_BYTES: 15 * 1024 * 1024,
  MAX_USER_BYTES: 4 * 1024 ** 3,           // 4 Go par compte
  MAX_TOTAL_BYTES: 9 * 1024 ** 3,          // 9 Go en tout : sous les 10 Go gratuits de R2
  MAX_CITIES: 50,
  UPLOADS_PER_USER_PER_DAY: 3000,
  UPLOADS_PER_DAY: 20000,                  // 600 000 par mois : sous le million d'écritures gratuites
  // Tentatives de connexion (et de récupération, de suppression…) par quart
  // d'heure ; une réussite remet l'adresse à zéro.
  LOGIN_ATTEMPTS_PER_ACCOUNT_IP: 10,       // pour une adresse depuis une IP
  LOGIN_ATTEMPTS_PER_ACCOUNT: 30,          // pour une adresse, toutes IP confondues
  LOGIN_ATTEMPTS_PER_IP: 50,               // depuis une IP, tous comptes confondus
  SIGNUPS_PER_IP: 10,                      // par heure
  MAX_SESSIONS_PER_USER: 30,
};

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;
const LOGIN_WINDOW = 15 * MINUTE;
const SIGNUP_WINDOW = 60 * MINUTE;
const SESSION_IDLE = 400 * DAY;            // une session inutilisée plus d'un an expire

const CITY_RE = /^[a-z][a-z0-9-]{0,31}$/;
const PHOTO_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;     // 32 octets en base64url
const RECOVERY_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';   // base32 de Crockford
const RECOVERY_LENGTH = 25;

function limit(env, name) {
  const v = Number(env && env[name]);
  return Number.isFinite(v) && v > 0 ? v : DEFAULTS[name];
}

// ------------------------------------------------------------------ réponses

// Les jetons voyagent dans l'en-tête Authorization, jamais dans un cookie : un
// site tiers ne peut rien faire au nom d'un utilisateur, l'origine « * » est
// donc sans risque — et indispensable au fichier autonome, d'origine « null ».
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, PUT, POST, DELETE, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-expose-headers': 'retry-after',
  'access-control-max-age': '86400',
};

function json(status, body, extra) {
  return new Response(JSON.stringify(body), {
    status,
    headers: Object.assign({}, CORS, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    }, extra || {}),
  });
}

function rawJson(status, text) {
  return new Response(text, {
    status,
    headers: Object.assign({}, CORS, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    }),
  });
}

// Jamais de 204 : certains intermédiaires (dont le serveur de développement)
// ajoutent « Content-Encoding: gzip » à une réponse vide, et Chromium, qui
// tente de décompresser un corps inexistant, interrompt alors la requête.
// Un petit corps JSON ne laisse aucune place à l'ambiguïté.
function done() {
  return json(200, { ok: true });
}

class HttpError extends Error {
  constructor(status, code, message, extra) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra || {};
  }
}

function fail(status, code, message, extra) {
  throw new HttpError(status, code, message, extra);
}

const unauthorized = () => fail(401, 'unauthorized', 'Session absente ou expirée : reconnecte-toi.');

// ------------------------------------------------------------------ octets

const encoder = new TextEncoder();

function toHex(bytes) {
  let out = '';
  for (const b of new Uint8Array(bytes)) out += b.toString(16).padStart(2, '0');
  return out;
}

function fromHex(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function toBase64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64url(str) {
  try {
    const bin = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch (_) {
    return null;
  }
}

const randomBytes = (n) => crypto.getRandomValues(new Uint8Array(n));

async function sha256Hex(...parts) {
  let size = 0;
  for (const p of parts) size += p.byteLength;
  const all = new Uint8Array(size);
  let at = 0;
  for (const p of parts) { all.set(p, at); at += p.byteLength; }
  return toHex(await crypto.subtle.digest('SHA-256', all));
}

/** Comparaison à temps constant de deux empreintes hexadécimales. */
function sameHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---------------------------------------------------------------- validation

function normEmail(raw) {
  const email = String(raw == null ? '' : raw).trim().toLowerCase();
  if (email.length < 3 || email.length > 254) return '';
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '';
}

/** Clé dérivée par le navigateur : exactement 32 octets en base64url. */
function parseKey(raw) {
  if (typeof raw !== 'string' || !TOKEN_RE.test(raw)) return null;
  const bytes = fromBase64url(raw);
  return bytes && bytes.length === 32 ? bytes : null;
}

/** Clé de secours : tolère espaces, tirets, minuscules et les confusions O/0, I/L/1. */
function normRecovery(raw) {
  if (typeof raw !== 'string' || raw.length > 100) return '';
  const code = raw.toUpperCase().replace(/O/g, '0').replace(/[IL]/g, '1').replace(/[\s-]/g, '');
  if (code.length !== RECOVERY_LENGTH) return '';
  for (const c of code) if (!RECOVERY_ALPHABET.includes(c)) return '';
  return code;
}

function clientIp(request) {
  return request.headers.get('cf-connecting-ip') || 'local';
}

/** Lit le corps en flux et coupe dès que la limite est franchie. */
async function readBytes(request, max) {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) fail(413, 'too_large', 'Envoi trop volumineux.');
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      try { await reader.cancel(); } catch (_) { /* rien */ }
      fail(413, 'too_large', 'Envoi trop volumineux.');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.byteLength; }
  return out;
}

async function readJson(request, max) {
  const bytes = await readBytes(request, max || 16 * 1024);
  let value;
  try { value = JSON.parse(new TextDecoder().decode(bytes)); } catch (_) { value = null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'bad_request', 'Requête illisible.');
  return value;
}

/** Type d'image d'après ses premiers octets : le serveur ne stocke que des images. */
function sniffImage(b) {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.length > 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
      && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  return null;
}

function intParam(v, min, max) {
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}

// ------------------------------------------------------------------ compteurs

/**
 * Compteurs à fenêtre. Chaque tentative est comptée AVANT d'être examinée, et
 * la décision porte sur la valeur que renvoie l'écriture elle-même : cent
 * requêtes simultanées ne peuvent plus toutes lire « 0 » avant qu'aucune
 * n'écrive. `limits` : [{ key, window, max }]. Renvoie les secondes à attendre
 * si l'un des compteurs dépasse son plafond, sinon 0.
 */
async function hit(env, limits) {
  const now = Date.now();
  const results = await env.DB.batch(limits.map((l) => env.DB.prepare(
    `INSERT INTO throttle (key, count, reset_at) VALUES (?1, 1, ?2)
     ON CONFLICT(key) DO UPDATE SET
       count = CASE WHEN throttle.reset_at <= ?3 THEN 1 ELSE throttle.count + 1 END,
       reset_at = CASE WHEN throttle.reset_at <= ?3 THEN ?2 ELSE throttle.reset_at END
     RETURNING count, reset_at`,
  ).bind(l.key, now + l.window, now)));
  let wait = 0;
  results.forEach((r, i) => {
    const row = r.results && r.results[0];
    if (row && row.count > limits[i].max) wait = Math.max(wait, Math.ceil((row.reset_at - now) / 1000), 1);
  });
  return wait;
}

function tooMany(seconds) {
  const minutes = Math.ceil(seconds / 60);
  fail(429, 'too_many_attempts',
    `Trop d’essais. Réessaie dans ${minutes} minute${minutes > 1 ? 's' : ''}.`,
    { retryAfter: seconds });
}

/** Compte la tentative (adresse+IP, adresse, IP) et refuse au-delà des plafonds. */
async function guardLogin(env, scope, email, ip) {
  const wait = await hit(env, [
    { key: `${scope}:${email}:${ip}`, window: LOGIN_WINDOW, max: limit(env, 'LOGIN_ATTEMPTS_PER_ACCOUNT_IP') },
    { key: `${scope}:${email}`, window: LOGIN_WINDOW, max: limit(env, 'LOGIN_ATTEMPTS_PER_ACCOUNT') },
    { key: `ip:${ip}`, window: LOGIN_WINDOW, max: limit(env, 'LOGIN_ATTEMPTS_PER_IP') },
  ]);
  if (wait) tooMany(wait);
}

/** Après une réussite, l'adresse repart de zéro (l'IP garde son compte). */
function clearAttempts(env, scope, email, ip) {
  return env.DB.prepare('DELETE FROM throttle WHERE key IN (?, ?)').bind(`${scope}:${email}:${ip}`, `${scope}:${email}`);
}

/** Vérifie le mot de passe d'un compte déjà authentifié (actions sensibles). */
async function confirmPassword(env, user, key, ip, scope) {
  await guardLogin(env, scope, user.email, ip);
  const row = await env.DB.prepare('SELECT pw_salt, pw_hash FROM users WHERE id = ?').bind(user.id).first();
  if (!row || !sameHex(await sha256Hex(fromHex(row.pw_salt), key), row.pw_hash)) {
    fail(401, 'invalid_credentials', 'Mot de passe incorrect.');
  }
  await clearAttempts(env, scope, user.email, ip).run();
}

// ------------------------------------------------------------------ sessions

async function createSession(env, userId) {
  const token = toBase64url(randomBytes(32));
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO sessions (token_hash, user_id, created_at, last_used_at) VALUES (?, ?, ?, ?)')
      .bind(await sha256Hex(encoder.encode(token)), userId, now, now),
    // Un appareil perdu ne garde pas éternellement une place : seules les
    // sessions les plus récentes survivent.
    env.DB.prepare(
      `DELETE FROM sessions WHERE user_id = ?1 AND token_hash NOT IN
         (SELECT token_hash FROM sessions WHERE user_id = ?1 ORDER BY last_used_at DESC LIMIT ?2)`,
    ).bind(userId, limit(env, 'MAX_SESSIONS_PER_USER')),
  ]);
  return token;
}

async function authenticate(request, env) {
  const m = /^Bearer (\S+)$/.exec(request.headers.get('authorization') || '');
  if (!m || !TOKEN_RE.test(m[1])) unauthorized();
  const tokenHash = await sha256Hex(encoder.encode(m[1]));
  const row = await env.DB.prepare(
    `SELECT s.user_id, s.last_used_at, u.email, u.bytes
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?`,
  ).bind(tokenHash).first();
  if (!row) unauthorized();
  const now = Date.now();
  if (now - row.last_used_at > SESSION_IDLE) {
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(tokenHash).run();
    unauthorized();
  }
  // Une écriture par jour au plus : le quota gratuit de D1 compte les écritures.
  if (now - row.last_used_at > DAY) {
    await env.DB.prepare('UPDATE sessions SET last_used_at = ? WHERE token_hash = ?').bind(now, tokenHash).run();
  }
  return { id: row.user_id, email: row.email, bytes: row.bytes, tokenHash };
}

const publicUser = (u) => ({ id: u.id, email: u.email });

// -------------------------------------------------------------------- comptes

async function signup(request, env) {
  const body = await readJson(request);
  const email = normEmail(body.email);
  const key = parseKey(body.key);
  const recovery = normRecovery(body.recovery);
  if (!email) fail(400, 'bad_email', 'Adresse e-mail invalide.');
  if (!key) fail(400, 'bad_key', 'Mot de passe illisible : recharge la page et réessaie.');
  if (!recovery) fail(400, 'bad_recovery', 'Clé de secours illisible : recharge la page et réessaie.');

  const ip = clientIp(request);
  const wait = await hit(env, [{ key: `signup:${ip}`, window: SIGNUP_WINDOW, max: limit(env, 'SIGNUPS_PER_IP') }]);
  if (wait) tooMany(wait);

  const id = crypto.randomUUID();
  const pwSalt = randomBytes(16);
  const rcSalt = randomBytes(16);
  try {
    await env.DB.prepare(
      `INSERT INTO users (id, email, pw_salt, pw_hash, rc_salt, rc_hash, bytes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
    ).bind(
      id, email,
      toHex(pwSalt), await sha256Hex(pwSalt, key),
      toHex(rcSalt), await sha256Hex(rcSalt, encoder.encode(recovery)),
      Date.now(),
    ).run();
  } catch (err) {
    if (/UNIQUE/i.test(String(err && err.message))) fail(409, 'email_taken', 'Un compte existe déjà avec cette adresse.');
    throw err;
  }
  const token = await createSession(env, id);
  return json(201, { token, user: { id, email } });
}

async function login(request, env) {
  const body = await readJson(request);
  const email = normEmail(body.email);
  const key = parseKey(body.key);
  if (!email || !key) fail(400, 'bad_request', 'Adresse ou mot de passe manquant.');
  const ip = clientIp(request);
  await guardLogin(env, 'login', email, ip);

  const user = await env.DB.prepare('SELECT id, email, pw_salt, pw_hash FROM users WHERE email = ?').bind(email).first();
  const ok = !!user && sameHex(await sha256Hex(fromHex(user.pw_salt), key), user.pw_hash);
  if (!ok) fail(401, 'invalid_credentials', 'Adresse ou mot de passe incorrect.');
  await clearAttempts(env, 'login', email, ip).run();
  const token = await createSession(env, user.id);
  return json(200, { token, user: publicUser(user) });
}

/** Nouveau mot de passe grâce à la clé de secours ; toutes les autres sessions tombent. */
async function recover(request, env) {
  const body = await readJson(request);
  const email = normEmail(body.email);
  const recovery = normRecovery(body.recovery);
  const key = parseKey(body.key);
  if (!email || !key) fail(400, 'bad_request', 'Adresse ou nouveau mot de passe manquant.');
  const ip = clientIp(request);
  await guardLogin(env, 'recover', email, ip);

  const user = await env.DB.prepare('SELECT id, email, rc_salt, rc_hash FROM users WHERE email = ?').bind(email).first();
  const ok = !!user && !!recovery && sameHex(await sha256Hex(fromHex(user.rc_salt), encoder.encode(recovery)), user.rc_hash);
  if (!ok) fail(401, 'invalid_recovery', 'Adresse ou clé de secours incorrecte.');
  const pwSalt = randomBytes(16);
  await env.DB.batch([
    env.DB.prepare('UPDATE users SET pw_salt = ?, pw_hash = ? WHERE id = ?')
      .bind(toHex(pwSalt), await sha256Hex(pwSalt, key), user.id),
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(user.id),
    clearAttempts(env, 'recover', email, ip),
    clearAttempts(env, 'login', email, ip),
  ]);
  const token = await createSession(env, user.id);
  return json(200, { token, user: publicUser(user) });
}

async function logout(request, env) {
  const user = await authenticate(request, env);
  await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(user.tokenHash).run();
  return done();
}

async function me(request, env) {
  const user = await authenticate(request, env);
  return json(200, {
    user: publicUser(user),
    bytes: user.bytes,
    maxBytes: limit(env, 'MAX_USER_BYTES'),
    photos: !!env.PHOTOS,
  });
}

/**
 * Nouvelle clé de secours. Le mot de passe est redemandé : sans lui, un jeton
 * de session volé suffirait à poser sa propre clé, puis à changer le mot de
 * passe et à enfermer le propriétaire dehors.
 */
async function replaceRecovery(request, env) {
  const user = await authenticate(request, env);
  const body = await readJson(request);
  const recovery = normRecovery(body.recovery);
  const key = parseKey(body.key);
  if (!recovery) fail(400, 'bad_recovery', 'Clé de secours illisible.');
  if (!key) fail(400, 'bad_request', 'Mot de passe manquant.');
  await confirmPassword(env, user, key, clientIp(request), 'recovery');
  const rcSalt = randomBytes(16);
  await env.DB.prepare('UPDATE users SET rc_salt = ?, rc_hash = ? WHERE id = ?')
    .bind(toHex(rcSalt), await sha256Hex(rcSalt, encoder.encode(recovery)), user.id).run();
  return done();
}

/** Supprime le compte et tout ce qu'il contient ; le mot de passe est redemandé. */
async function deleteAccount(request, env) {
  const user = await authenticate(request, env);
  const body = await readJson(request);
  const key = parseKey(body.key);
  if (!key) fail(400, 'bad_request', 'Mot de passe manquant.');
  await confirmPassword(env, user, key, clientIp(request), 'delete');
  if (env.PHOTOS) {
    let cursor;
    do {
      const page = await env.PHOTOS.list({ prefix: `${user.id}/`, limit: 1000, cursor });
      const keys = page.objects.map((o) => o.key);
      if (keys.length) await env.PHOTOS.delete(keys);
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  }
  await env.DB.batch([
    // Le total est lu dans la même transaction : un envoi concurrent ne le fausse pas.
    env.DB.prepare(`UPDATE usage SET value = value - COALESCE((SELECT bytes FROM users WHERE id = ?), 0)
                    WHERE key = 'bytes'`).bind(user.id),
    env.DB.prepare('DELETE FROM photos WHERE user_id = ?').bind(user.id),
    env.DB.prepare('DELETE FROM progress WHERE user_id = ?').bind(user.id),
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(user.id),
    env.DB.prepare('DELETE FROM users WHERE id = ?').bind(user.id),
  ]);
  return done();
}

// ----------------------------------------------------------------- progression

async function getProgress(request, env, city) {
  const user = await authenticate(request, env);
  const row = await env.DB.prepare('SELECT data, updated_at FROM progress WHERE user_id = ? AND city = ?')
    .bind(user.id, city).first();
  // `data` a été validé puis resérialisé à l'écriture : il se recolle tel quel.
  return rawJson(200, `{"city":${JSON.stringify(city)},"updatedAt":${row ? row.updated_at : 0},"data":${row ? row.data : 'null'}}`);
}

async function putProgress(request, env, city) {
  const user = await authenticate(request, env);
  const body = await readJson(request, limit(env, 'MAX_PROGRESS_BYTES'));
  const data = body.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) fail(400, 'bad_request', 'Progression illisible.');
  // Le plafond de villes est vérifié par l'écriture elle-même : une ville déjà
  // connue se met à jour, une nouvelle n'entre que s'il reste de la place.
  const res = await env.DB.prepare(
    `INSERT INTO progress (user_id, city, data, updated_at)
     SELECT ?1, ?2, ?3, ?4
      WHERE EXISTS (SELECT 1 FROM progress WHERE user_id = ?1 AND city = ?2)
         OR (SELECT COUNT(*) FROM progress WHERE user_id = ?1) < ?5
     ON CONFLICT(user_id, city) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
  ).bind(user.id, city, JSON.stringify(data), Date.now(), limit(env, 'MAX_CITIES')).run();
  if (!res.meta || !res.meta.changes) fail(413, 'too_many_cities', 'Trop de villes pour un seul compte.');
  return done();
}

// ---------------------------------------------------------------------- photos

const photoKey = (userId, id) => `${userId}/${id}`;

function requirePhotos(env) {
  if (!env.PHOTOS) fail(503, 'photos_disabled', 'Le stockage des photos n’est pas activé sur ce serveur.');
}

/** Liste paginée, par identifiant croissant : 1000 par page reste loin des 10 ms de CPU. */
async function listPhotos(request, env, url) {
  const user = await authenticate(request, env);
  const after = url.searchParams.get('after') || '';
  if (after && !PHOTO_ID_RE.test(after)) fail(400, 'bad_request', 'Curseur invalide.');
  const { results } = await env.DB.prepare(
    `SELECT id, city, spot, w, h, taken_at AS takenAt, created_at AS createdAt, size, type
       FROM photos WHERE user_id = ? AND id > ? ORDER BY id LIMIT 1000`,
  ).bind(user.id, after).all();
  const rows = results || [];
  return json(200, { photos: rows, next: rows.length === 1000 ? rows[rows.length - 1].id : null });
}

async function putPhoto(request, env, url, id) {
  const user = await authenticate(request, env);
  requirePhotos(env);
  const q = url.searchParams;
  const city = q.get('city') || '';
  const spot = q.get('spot') || '';
  const w = intParam(q.get('w') || '0', 0, 100000);
  const h = intParam(q.get('h') || '0', 0, 100000);
  const takenAt = q.get('takenAt') || '';
  // Une photo scannée peut dater d'avant 1970 : horodatage négatif accepté.
  const createdAt = intParam(q.get('createdAt') || String(Date.now()), -8.64e15, 8.64e15);
  if (!CITY_RE.test(city) || !spot || spot.length > 64 || w === null || h === null
      || takenAt.length > 40 || createdAt === null) {
    fail(400, 'bad_request', 'Description de photo invalide.');
  }

  const daily = await hit(env, [
    { key: `up:${user.id}`, window: DAY, max: limit(env, 'UPLOADS_PER_USER_PER_DAY') },
    { key: 'up:all', window: DAY, max: limit(env, 'UPLOADS_PER_DAY') },
  ]);
  if (daily) {
    fail(429, 'quota_daily', 'Assez de photos envoyées pour aujourd’hui : la suite partira demain.', { retryAfter: daily });
  }

  const bytes = await readBytes(request, limit(env, 'MAX_PHOTO_BYTES'));
  const type = sniffImage(bytes);
  if (!type) fail(415, 'not_an_image', 'Seules les images JPEG, PNG ou WebP sont acceptées.');
  const size = bytes.byteLength;

  // 1. Réserver la place. Chaque UPDATE conditionnel est atomique : deux envois
  //    simultanés ne peuvent pas tous deux se glisser sous le plafond. Pour un
  //    remplacement, seule la croissance est réservée ; l'ajustement exact se
  //    fait à l'étape 3.
  const before = await env.DB.prepare('SELECT size FROM photos WHERE user_id = ? AND id = ?').bind(user.id, id).first();
  const reserved = Math.max(0, size - (before ? before.size : 0));
  const release = () => env.DB.batch([
    env.DB.prepare(`UPDATE usage SET value = value - ? WHERE key = 'bytes'`).bind(reserved),
    env.DB.prepare('UPDATE users SET bytes = bytes - ? WHERE id = ?').bind(reserved, user.id),
  ]);
  if (reserved > 0) {
    const total = await env.DB.prepare(`UPDATE usage SET value = value + ?1 WHERE key = 'bytes' AND value + ?1 <= ?2`)
      .bind(reserved, limit(env, 'MAX_TOTAL_BYTES')).run();
    if (!total.meta.changes) {
      fail(507, 'quota_total', 'Le serveur a atteint sa limite de stockage gratuite. Tes photos restent sur cet appareil.');
    }
    const mine = await env.DB.prepare('UPDATE users SET bytes = bytes + ?1 WHERE id = ?2 AND bytes + ?1 <= ?3')
      .bind(reserved, user.id, limit(env, 'MAX_USER_BYTES')).run();
    if (!mine.meta.changes) {
      await env.DB.prepare(`UPDATE usage SET value = value - ? WHERE key = 'bytes'`).bind(reserved).run();
      fail(507, 'quota_user', 'Ton espace photo en ligne est plein. Tes photos restent sur cet appareil.');
    }
  }

  // 2. Stocker l'image ; en cas d'échec, rendre la place réservée.
  try {
    await env.PHOTOS.put(photoKey(user.id, id), bytes, { httpMetadata: { contentType: type } });
  } catch (err) {
    if (reserved > 0) await release();
    throw err;
  }

  // 3. Enregistrer, dans une seule transaction : l'ancienne taille est relue au
  //    moment même de l'écriture, si bien que des remplacements concurrents
  //    retirent chacun la taille réellement présente, jamais deux fois la même.
  const adjust = size - reserved;
  await env.DB.batch([
    env.DB.prepare(`UPDATE users SET bytes = bytes + ?3 - COALESCE((SELECT size FROM photos WHERE user_id = ?1 AND id = ?2), 0)
                    WHERE id = ?1`).bind(user.id, id, adjust),
    env.DB.prepare(`UPDATE usage SET value = value + ?3 - COALESCE((SELECT size FROM photos WHERE user_id = ?1 AND id = ?2), 0)
                    WHERE key = 'bytes'`).bind(user.id, id, adjust),
    env.DB.prepare(
      `INSERT INTO photos (user_id, id, city, spot, w, h, taken_at, created_at, size, type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, id) DO UPDATE SET
         city = excluded.city, spot = excluded.spot, w = excluded.w, h = excluded.h,
         taken_at = excluded.taken_at, size = excluded.size, type = excluded.type`,
    ).bind(user.id, id, city, spot, w, h, takenAt, createdAt, size, type),
  ]);
  return done();
}

async function getPhoto(request, env, id) {
  const user = await authenticate(request, env);
  requirePhotos(env);
  // La clé commence par l'identifiant du compte : impossible d'atteindre la
  // photo d'un autre, même en devinant son identifiant.
  const obj = await env.PHOTOS.get(photoKey(user.id, id));
  if (!obj) fail(404, 'not_found', 'Photo introuvable.');
  return new Response(obj.body, {
    status: 200,
    headers: Object.assign({}, CORS, {
      'content-type': (obj.httpMetadata && obj.httpMetadata.contentType) || 'application/octet-stream',
      'content-length': String(obj.size),
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
    }),
  });
}

// ---------------------------------------------------------------------- routes

async function health(env) {
  const row = await env.DB.prepare('SELECT 1 AS ok').first();
  return json(200, { ok: !!row, service: 'citywalker', version: VERSION, photos: !!env.PHOTOS });
}

async function route(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = request.method;
  const only = (m) => { if (method !== m) fail(405, 'method_not_allowed', 'Méthode non autorisée.'); };

  switch (path) {
    case '/':
    case '/v1/health': only('GET'); return health(env);
    case '/v1/auth/signup': only('POST'); return signup(request, env);
    case '/v1/auth/login': only('POST'); return login(request, env);
    case '/v1/auth/recover': only('POST'); return recover(request, env);
    case '/v1/auth/logout': only('POST'); return logout(request, env);
    case '/v1/me': only('GET'); return me(request, env);
    case '/v1/account/recovery': only('PUT'); return replaceRecovery(request, env);
    case '/v1/account': only('DELETE'); return deleteAccount(request, env);
    case '/v1/photos': only('GET'); return listPhotos(request, env, url);
    default: break;
  }

  let m = /^\/v1\/progress\/([^/]+)$/.exec(path);
  if (m) {
    const city = safeDecode(m[1]);
    if (!CITY_RE.test(city)) fail(400, 'bad_request', 'Ville inconnue.');
    if (method === 'GET') return getProgress(request, env, city);
    if (method === 'PUT') return putProgress(request, env, city);
    fail(405, 'method_not_allowed', 'Méthode non autorisée.');
  }

  m = /^\/v1\/photos\/([^/]+)$/.exec(path);
  if (m) {
    const id = safeDecode(m[1]);
    if (!PHOTO_ID_RE.test(id)) fail(400, 'bad_request', 'Identifiant de photo invalide.');
    if (method === 'GET') return getPhoto(request, env, id);
    if (method === 'PUT') return putPhoto(request, env, url, id);
    fail(405, 'method_not_allowed', 'Méthode non autorisée.');
  }

  fail(404, 'not_found', 'Adresse inconnue.');
}

function safeDecode(s) {
  try { return decodeURIComponent(s); } catch (_) { return ''; }
}

/** Ménage quotidien : compteurs échus et sessions abandonnées. */
async function housekeeping(env) {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM throttle WHERE reset_at < ?').bind(now),
    env.DB.prepare('DELETE FROM sessions WHERE last_used_at < ?').bind(now - SESSION_IDLE),
  ]);
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    try {
      return await route(request, env);
    } catch (err) {
      if (err instanceof HttpError) {
        const extra = err.extra && err.extra.retryAfter ? { 'retry-after': String(err.extra.retryAfter) } : undefined;
        return json(err.status, Object.assign({ error: err.code, message: err.message }, err.extra), extra);
      }
      console.error('Erreur inattendue', err && err.stack ? err.stack : err);
      return json(500, { error: 'server_error', message: 'Erreur du serveur, réessaie plus tard.' });
    }
  },

  async scheduled(_event, env) {
    await housekeeping(env);
  },
};

