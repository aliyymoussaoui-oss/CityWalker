/* CityWalker — comptes et synchronisation.
 *
 * Parle au serveur CityWalker (un Cloudflare Worker, voir server/) par
 * quelques appels `fetch`, sans SDK. Rien n'est obligatoire : tant que le site
 * n'indique pas d'adresse de serveur, tout fonctionne en local, comme avant.
 *
 * Le mot de passe ne quitte jamais l'appareil. Le navigateur en dérive une clé
 * (PBKDF2-SHA256, 600 000 tours, sel tiré de l'adresse) et n'envoie qu'elle.
 * Aucun e-mail n'est envoyé : un mot de passe oublié se remplace avec la clé
 * de secours affichée à la création du compte.
 */
(function () {
  'use strict';
  const CW = window.CW;

  const SESSION_KEY = 'citywalker:v2:session';
  const LAST_SYNC_KEY = 'citywalker:v1:last-sync';
  const PBKDF2_ITERATIONS = 600000;
  const RECOVERY_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';   // base32 de Crockford

  function readJSON(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (_) {
      return fallback;
    }
  }
  function writeJSON(key, value) {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (_) {
      return false;
    }
  }

  // L'ancienne synchronisation (Supabase) a laissé une configuration et une
  // session qui ne mènent plus nulle part.
  try {
    localStorage.removeItem('citywalker:v1:cloud-config');
    localStorage.removeItem('citywalker:v1:cloud-session');
  } catch (_) { /* stockage indisponible */ }

  const apiUrl = () => String((window.CW_CONFIG && window.CW_CONFIG.apiUrl) || '').trim().replace(/\/+$/, '');
  const configured = () => !!apiUrl();

  // La session est relue à chaque appel : plusieurs onglets (ou l'application
  // installée et un onglet) partagent le même stockage, et une copie en
  // mémoire finirait par écraser la session plus récente d'un autre onglet.
  // La mémoire ne sert que si le stockage est indisponible.
  let memory = null;
  function loadSession() {
    let s = memory;
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      s = raw ? JSON.parse(raw) : null;
    } catch (_) { /* stockage indisponible : on garde la copie en mémoire */ }
    return s && typeof s.token === 'string' && s.token.length === 43 ? s : null;
  }
  function saveSession(s) {
    memory = s || null;
    writeJSON(SESSION_KEY, s || null);
  }

  const normEmail = (email) => String(email || '').trim().toLowerCase();

  // ------------------------------------------------------------ cryptographie

  function base64url(bytes) {
    let s = '';
    for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  /** Clé envoyée au serveur à la place du mot de passe. */
  async function deriveKey(email, password) {
    if (!(window.crypto && crypto.subtle)) {
      throw new Error('Ce navigateur ne sait pas protéger le mot de passe : ouvre le site en https.');
    }
    const enc = new TextEncoder();
    const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits({
      name: 'PBKDF2', hash: 'SHA-256', iterations: PBKDF2_ITERATIONS,
      salt: enc.encode(`citywalker/v1/${normEmail(email)}`),
    }, base, 256);
    return base64url(bits);
  }

  /** 25 caractères aléatoires (125 bits), en cinq groupes lisibles. */
  function newRecoveryCode() {
    const bytes = crypto.getRandomValues(new Uint8Array(25));
    let code = '';
    for (let i = 0; i < 25; i++) {
      code += RECOVERY_ALPHABET[bytes[i] & 31];
      if (i % 5 === 4 && i < 24) code += '-';
    }
    return code;
  }

  // ------------------------------------------------------------------ requêtes

  const MESSAGES = {
    invalid_credentials: 'Adresse ou mot de passe incorrect.',
    email_taken: 'Un compte existe déjà avec cette adresse.',
    invalid_recovery: 'Adresse ou clé de secours incorrecte.',
    bad_email: 'Adresse e-mail invalide.',
    unauthorized: 'Session expirée : reconnecte-toi.',
  };

  async function request(method, path, opts) {
    const o = opts || {};
    const url = apiUrl();
    if (!url) throw new Error('La synchronisation n’est pas activée sur ce site.');
    const headers = {};
    let sent = '';
    if (o.auth !== false) {
      const s = loadSession();
      if (!s) {
        const err = new Error(MESSAGES.unauthorized);
        err.code = 'unauthorized';
        throw err;
      }
      sent = s.token;
      headers.authorization = `Bearer ${s.token}`;
    }
    let body;
    if (o.json !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(o.json); }
    if (o.blob !== undefined) { headers['content-type'] = o.blob.type || 'image/jpeg'; body = o.blob; }
    let res;
    try {
      res = await fetch(url + path, { method, headers, body });
    } catch (_) {
      throw new Error('Serveur injoignable. Rien n’est perdu : tout reste sur cet appareil.');
    }
    if (res.ok) {
      // Réponse JSON : lue ici, entièrement, pour que chaque requête se
      // termine proprement ; une photo, elle, revient telle quelle.
      if (/json/.test(res.headers.get('content-type') || '')) return res.json();
      return res;
    }
    let data = {};
    try { data = await res.json(); } catch (_) { /* corps illisible */ }
    // Seule une session refusée déconnecte (un mauvais mot de passe au moment
    // de supprimer le compte ne doit pas faire perdre la session), et seulement
    // si c'est encore elle qui est enregistrée : un autre onglet a pu se
    // reconnecter entre-temps.
    if (data.error === 'unauthorized') {
      const current = loadSession();
      if (current && current.token === sent) saveSession(null);
    }
    const err = new Error(MESSAGES[data.error] || data.message || `Le serveur a refusé la requête (${res.status}).`);
    err.code = data.error || String(res.status);
    throw err;
  }

  // ---------------------------------------------------------------------- compte

  function adopt(payload) {
    if (!payload || typeof payload.token !== 'string' || !payload.user) throw new Error('Réponse inattendue du serveur.');
    const s = { token: payload.token, userId: payload.user.id, email: payload.user.email };
    saveSession(s);
    return s;
  }

  /** Crée le compte ; renvoie la clé de secours, à montrer une seule fois. */
  async function signUp(email, password) {
    const recovery = newRecoveryCode();
    const key = await deriveKey(email, password);
    const s = adopt(await request('POST', '/v1/auth/signup', { auth: false, json: { email: normEmail(email), key, recovery } }));
    return { session: s, recovery };
  }

  async function signIn(email, password) {
    const key = await deriveKey(email, password);
    return adopt(await request('POST', '/v1/auth/login', { auth: false, json: { email: normEmail(email), key } }));
  }

  /** Nouveau mot de passe grâce à la clé de secours. */
  async function recover(email, recoveryCode, newPassword) {
    const key = await deriveKey(email, newPassword);
    return adopt(await request('POST', '/v1/auth/recover', { auth: false, json: { email: normEmail(email), recovery: recoveryCode, key } }));
  }

  /** Remplace la clé de secours (mot de passe redemandé) ; l'ancienne cesse de fonctionner. */
  async function renewRecovery(password) {
    const s = loadSession();
    if (!s) throw new Error(MESSAGES.unauthorized);
    const recovery = newRecoveryCode();
    const key = await deriveKey(s.email, password);
    await request('PUT', '/v1/account/recovery', { json: { recovery, key } });
    return recovery;
  }

  function account() {
    return request('GET', '/v1/me');
  }

  async function deleteAccount(password) {
    const s = loadSession();
    if (!s) throw new Error(MESSAGES.unauthorized);
    const key = await deriveKey(s.email, password);
    await request('DELETE', '/v1/account', { json: { key } });
    saveSession(null);
    writeJSON(LAST_SYNC_KEY, null);
  }

  async function signOut() {
    const s = loadSession();
    if (!s) return;
    try { await request('POST', '/v1/auth/logout'); } catch (_) { /* la session locale tombe quand même */ }
    saveSession(null);
  }

  // ------------------------------------------------------------ progression

  async function pullCity(cityId) {
    const body = await request('GET', `/v1/progress/${encodeURIComponent(cityId)}`);
    return body && body.data ? CW.normalizeProgress(body.data, cityId) : null;
  }

  async function pushCity(cityId, progress) {
    await request('PUT', `/v1/progress/${encodeURIComponent(cityId)}`, { json: { data: progress } });
  }

  // ------------------------------------------------------------------ photos

  async function listPhotos() {
    const all = [];
    let after = '';
    for (;;) {
      const body = await request('GET', `/v1/photos${after ? `?after=${encodeURIComponent(after)}` : ''}`);
      all.push(...(body.photos || []));
      if (!body.next) return all;
      after = body.next;
    }
  }

  async function uploadPhoto(record) {
    const q = new URLSearchParams({
      city: record.city, spot: record.spot,
      w: String(record.w || 0), h: String(record.h || 0),
      takenAt: record.takenAt ? String(record.takenAt).slice(0, 40) : '',
      // Peut être négatif (photo d'avant 1970) : le serveur l'accepte.
      createdAt: String(Math.round(Number.isFinite(record.createdAt) ? record.createdAt : Date.now())),
    });
    await request('PUT', `/v1/photos/${encodeURIComponent(record.id)}?${q}`, { blob: record.full });
  }

  async function downloadPhoto(row) {
    const res = await request('GET', `/v1/photos/${encodeURIComponent(row.id)}`);
    return res.blob();
  }

  // ---------------------------------------------------------- orchestration

  // Un refus qui vaudra pour toutes les photos suivantes : inutile d'insister.
  const STOP_UPLOADS = new Set(['quota_user', 'quota_total', 'quota_daily', 'photos_disabled']);

  /**
   * Photos, dans les deux sens. Les réceptions passent d'abord : un compte
   * plein, ou une photo que le serveur refuse, n'empêche jamais de recevoir
   * celles des autres appareils. Chaque photo échoue seule ; seuls une
   * session expirée ou un serveur injoignable arrêtent tout.
   */
  async function syncPhotos(cityIds, report, step) {
    const note = (msg) => { if (!report.photoIssue) report.photoIssue = msg; };
    const fatal = (err) => !err || !err.code || err.code === 'unauthorized' || err.code === 'photos_disabled';

    step('Comparaison des photos…');
    const remotePhotos = await listPhotos();
    const remoteIds = new Set(remotePhotos.map((r) => r.id));
    const local = new Map();
    for (const cityId of cityIds) local.set(cityId, await CW.store.photosForCity(cityId));

    for (const cityId of cityIds) {
      const localIds = new Set(local.get(cityId).map((r) => r.id));
      for (const row of remotePhotos) {
        if (row.city !== cityId || localIds.has(row.id)) continue;
        step(`Réception des photos… (${report.downloaded + 1})`);
        try {
          const blob = await downloadPhoto(row);
          await CW.store.putPhoto({
            id: row.id, city: row.city, spot: row.spot, w: row.w || 0, h: row.h || 0,
            takenAt: row.takenAt || '', caption: '', createdAt: row.createdAt || Date.now(),
            full: blob, thumb: blob,
          });
          const entry = CW.store.ensureEntry(row.city, row.spot);
          if (!entry.photos.includes(row.id)) {
            CW.store.updateEntry(row.city, row.spot, { photos: entry.photos.concat([row.id]), done: true });
          }
          report.downloaded++;
        } catch (err) {
          if (fatal(err)) throw err;
          note(`Une photo n’a pas pu être reçue : ${err.message}`);
        }
      }
    }

    for (const cityId of cityIds) {
      for (const row of local.get(cityId)) {
        if (remoteIds.has(row.id) || !row.full) continue;
        step(`Envoi des photos… (${report.uploaded + 1})`);
        try {
          await uploadPhoto(row);
          report.uploaded++;
        } catch (err) {
          if (fatal(err)) throw err;
          if (STOP_UPLOADS.has(err.code)) { note(err.message); return; }
          note(`Une photo n’a pas pu être envoyée : ${err.message}`);
        }
      }
    }
  }

  /**
   * Synchronise dans les deux sens. La fusion ne retire jamais rien : en cas
   * de divergence entre deux appareils, l'union gagne. La progression passe
   * d'abord ; un souci de photos (quota, stockage non activé) n'empêche pas
   * qu'elle soit à jour, il est simplement signalé dans le rapport.
   */
  async function sync(cityIds, onProgress) {
    const report = { cities: 0, merged: 0, uploaded: 0, downloaded: 0, photoIssue: '' };
    const step = (t) => { if (onProgress) onProgress(t); };

    for (const cityId of cityIds) {
      step(`Synchronisation de ${cityId}…`);
      const local = CW.store.loadProgress(cityId);
      const remote = await pullCity(cityId);
      let merged = local;
      if (remote) {
        const res = CW.mergeProgress(local, remote);
        merged = res.progress;
        report.merged += res.changed;
        CW.store.replaceProgress(cityId, merged);
      }
      await pushCity(cityId, merged);
      report.cities++;
    }

    try {
      await syncPhotos(cityIds, report, step);
    } catch (err) {
      if (err && err.code === 'unauthorized') throw err;
      report.photoIssue = err && err.code === 'photos_disabled'
        ? 'Les photos ne sont pas encore synchronisées par ce serveur ; elles restent sur cet appareil.'
        : (err && err.message) || 'Les photos n’ont pas pu être synchronisées.';
    }
    CW.store.flushAll();
    writeJSON(LAST_SYNC_KEY, Date.now());
    return report;
  }

  const lastSync = () => readJSON(LAST_SYNC_KEY, 0);

  CW.cloud = {
    configured, session: loadSession,
    signUp, signIn, signOut, recover, renewRecovery, account, deleteAccount,
    newRecoveryCode, deriveKey,
    pullCity, pushCity, listPhotos, uploadPhoto, downloadPhoto, sync, lastSync,
  };
})();
