/* CityWalker — comptes et synchronisation.
 *
 * Parle à une instance Supabase par son API REST, sans SDK : quelques appels
 * `fetch` suffisent et l'application reste sans dépendance.
 *
 * Rien n'est obligatoire : tant qu'aucune instance n'est configurée, toute
 * l'application fonctionne exactement comme avant, en local. La configuration
 * (URL + clé publique « anon ») se saisit dans les réglages et vit dans le
 * navigateur — cette clé est publique par conception, ce sont les règles RLS
 * de la base qui protègent les données.
 *
 * Le schéma SQL à exécuter une fois est dans SYNCHRONISATION.md.
 */
(function () {
  'use strict';
  const CW = window.CW;

  const CONFIG_KEY = 'citywalker:v1:cloud-config';
  const SESSION_KEY = 'citywalker:v1:cloud-session';
  const BUCKET = 'photos';

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

  let config = null;
  let session = null;

  function loadConfig() {
    if (config) return config;
    const stored = readJSON(CONFIG_KEY, null);
    const baked = window.CW_CONFIG || {};
    const url = (stored && stored.url) || baked.supabaseUrl || '';
    const key = (stored && stored.key) || baked.supabaseAnonKey || '';
    config = { url: String(url).replace(/\/+$/, ''), key: String(key) };
    return config;
  }
  function setConfig(url, key) {
    config = { url: String(url || '').trim().replace(/\/+$/, ''), key: String(key || '').trim() };
    writeJSON(CONFIG_KEY, config.url && config.key ? config : null);
    if (!config.url || !config.key) clearSession();
    return config;
  }
  const configured = () => !!(loadConfig().url && loadConfig().key);

  function loadSession() {
    if (session === null) session = readJSON(SESSION_KEY, false) || false;
    return session || null;
  }
  function saveSession(s) {
    session = s || false;
    writeJSON(SESSION_KEY, s || null);
  }
  function clearSession() { saveSession(null); }

  function normalizeSession(payload) {
    if (!payload || !payload.access_token) return null;
    return {
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token || '',
      expiresAt: Date.now() + (Number(payload.expires_in) || 3600) * 1000,
      userId: (payload.user && payload.user.id) || '',
      email: (payload.user && payload.user.email) || '',
    };
  }

  async function readError(res, fallback) {
    let detail = '';
    try {
      const body = await res.json();
      detail = body.msg || body.message || body.error_description || body.error || '';
    } catch (_) { /* corps illisible */ }
    const known = {
      'Invalid login credentials': 'Adresse ou mot de passe incorrect.',
      'User already registered': 'Un compte existe déjà avec cette adresse.',
      'Email not confirmed': 'Confirme d’abord l’adresse depuis le mail reçu.',
    };
    return new Error(known[detail] || detail || `${fallback} (${res.status})`);
  }

  // ------------------------------------------------------------------ auth

  async function auth(path, body) {
    const cfg = loadConfig();
    if (!cfg.url) throw new Error('Synchronisation non configurée.');
    const res = await fetch(`${cfg.url}/auth/v1/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', apikey: cfg.key },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw await readError(res, 'Authentification refusée');
    return res.json();
  }

  async function signUp(email, password) {
    const payload = await auth('signup', { email, password });
    const s = normalizeSession(payload);
    if (!s) {
      // Confirmation par mail activée : pas de session tout de suite.
      return { pending: true };
    }
    saveSession(s);
    return { pending: false, session: s };
  }

  async function signIn(email, password) {
    const payload = await auth('token?grant_type=password', { email, password });
    const s = normalizeSession(payload);
    if (!s) throw new Error('Réponse d’authentification inattendue.');
    saveSession(s);
    return s;
  }

  async function refresh() {
    const s = loadSession();
    if (!s || !s.refreshToken) return null;
    try {
      const payload = await auth('token?grant_type=refresh_token', { refresh_token: s.refreshToken });
      const next = normalizeSession(payload);
      if (next) { saveSession(next); return next; }
    } catch (_) { /* jeton périmé */ }
    clearSession();
    return null;
  }

  async function signOut() {
    const s = loadSession();
    const cfg = loadConfig();
    clearSession();
    if (!s || !cfg.url) return;
    try {
      await fetch(`${cfg.url}/auth/v1/logout`, {
        method: 'POST',
        headers: { apikey: cfg.key, authorization: `Bearer ${s.accessToken}` },
      });
    } catch (_) { /* la session locale est déjà effacée, c'est l'essentiel */ }
  }

  // ------------------------------------------------------------- requêtes

  async function api(path, opts, retry) {
    const cfg = loadConfig();
    let s = loadSession();
    if (!s) throw new Error('Pas connecté.');
    if (s.expiresAt - Date.now() < 60000) s = (await refresh()) || s;
    const headers = Object.assign({
      apikey: cfg.key,
      authorization: `Bearer ${s.accessToken}`,
    }, (opts && opts.headers) || {});
    const res = await fetch(`${cfg.url}${path}`, Object.assign({}, opts, { headers }));
    if (res.status === 401 && !retry) {
      if (await refresh()) return api(path, opts, true);
      clearSession();
      throw new Error('Session expirée, reconnecte-toi.');
    }
    if (!res.ok) throw await readError(res, 'Requête refusée');
    return res;
  }

  const jsonHeaders = { 'content-type': 'application/json', accept: 'application/json' };

  async function pullCity(cityId) {
    const res = await api(`/rest/v1/progress?select=data,updated_at&city=eq.${encodeURIComponent(cityId)}`,
      { method: 'GET', headers: jsonHeaders });
    const rows = await res.json();
    if (!Array.isArray(rows) || !rows.length) return null;
    return CW.normalizeProgress(rows[0].data, cityId);
  }

  async function pushCity(cityId, progress) {
    const s = loadSession();
    await api('/rest/v1/progress', {
      method: 'POST',
      headers: Object.assign({}, jsonHeaders, { prefer: 'resolution=merge-duplicates,return=minimal' }),
      body: JSON.stringify([{ user_id: s.userId, city: cityId, data: progress, updated_at: new Date().toISOString() }]),
    });
  }

  async function listPhotos() {
    const res = await api('/rest/v1/photos?select=id,city,spot,w,h,taken_at,created_at',
      { method: 'GET', headers: jsonHeaders });
    const rows = await res.json();
    return Array.isArray(rows) ? rows : [];
  }

  const photoPath = (userId, id) => `${userId}/${id}.jpg`;

  async function uploadPhoto(record) {
    const s = loadSession();
    await api(`/storage/v1/object/${BUCKET}/${photoPath(s.userId, record.id)}`, {
      method: 'POST',
      headers: { 'content-type': 'image/jpeg', 'x-upsert': 'true' },
      body: record.full,
    });
    await api('/rest/v1/photos', {
      method: 'POST',
      headers: Object.assign({}, jsonHeaders, { prefer: 'resolution=merge-duplicates,return=minimal' }),
      body: JSON.stringify([{
        id: record.id, user_id: s.userId, city: record.city, spot: record.spot,
        w: record.w || 0, h: record.h || 0, taken_at: record.takenAt || '',
        created_at: record.createdAt || Date.now(),
      }]),
    });
  }

  async function downloadPhoto(row) {
    const s = loadSession();
    const res = await api(`/storage/v1/object/${BUCKET}/${photoPath(s.userId, row.id)}`, { method: 'GET' });
    return res.blob();
  }

  // ---------------------------------------------------------- orchestration

  /**
   * Synchronise dans les deux sens. La fusion ne retire jamais rien :
   * en cas de divergence entre deux appareils, l'union gagne.
   */
  async function sync(cityIds, onProgress) {
    const report = { cities: 0, merged: 0, uploaded: 0, downloaded: 0 };
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

    step('Comparaison des photos…');
    const remotePhotos = await listPhotos();
    const remoteIds = new Set(remotePhotos.map((r) => r.id));
    for (const cityId of cityIds) {
      const localRows = await CW.store.photosForCity(cityId);
      const localIds = new Set(localRows.map((r) => r.id));
      for (const row of localRows) {
        if (remoteIds.has(row.id)) continue;
        step(`Envoi des photos… (${report.uploaded + 1})`);
        await uploadPhoto(row);
        report.uploaded++;
      }
      for (const row of remotePhotos) {
        if (row.city !== cityId || localIds.has(row.id)) continue;
        step(`Réception des photos… (${report.downloaded + 1})`);
        const blob = await downloadPhoto(row);
        await CW.store.putPhoto({
          id: row.id, city: row.city, spot: row.spot, w: row.w || 0, h: row.h || 0,
          takenAt: row.taken_at || '', caption: '', createdAt: row.created_at || Date.now(),
          full: blob, thumb: blob,
        });
        const entry = CW.store.ensureEntry(row.city, row.spot);
        if (!entry.photos.includes(row.id)) {
          CW.store.updateEntry(row.city, row.spot, { photos: entry.photos.concat([row.id]), done: true });
        }
        report.downloaded++;
      }
    }
    CW.store.flushAll();
    writeJSON('citywalker:v1:last-sync', Date.now());
    return report;
  }

  const lastSync = () => readJSON('citywalker:v1:last-sync', 0);

  CW.cloud = {
    loadConfig, setConfig, configured,
    session: loadSession, signUp, signIn, signOut, refresh,
    pullCity, pushCity, listPhotos, uploadPhoto, downloadPhoto, sync, lastSync,
  };
})();
