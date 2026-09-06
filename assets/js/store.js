/* CityWalker — persistance locale.
 *
 * - Progression (cases cochées, ambiances, notes, dates) : localStorage, synchrone,
 *   petit, et donc disponible dès le premier rendu.
 * - Photos (blobs) : IndexedDB. Si IndexedDB est indisponible (navigation privée
 *   sur certains navigateurs), l'application fonctionne sans photos et le dit.
 */
(function () {
  'use strict';
  const CW = window.CW;

  const LS_PREFIX = 'citywalker:v1:';
  const DB_NAME = 'citywalker';
  const DB_VERSION = 1;
  const PHOTO_STORE = 'photos';

  const memoryFallback = {};      // repli si localStorage lève (quota, mode privé strict)

  function lsGet(key) {
    try {
      const raw = localStorage.getItem(LS_PREFIX + key);
      return raw === null ? memoryFallback[key] ?? null : raw;
    } catch (_) {
      return memoryFallback[key] ?? null;
    }
  }
  function lsSet(key, value) {
    memoryFallback[key] = value;
    try {
      localStorage.setItem(LS_PREFIX + key, value);
      return true;
    } catch (_) {
      return false;
    }
  }
  function lsRemove(key) {
    delete memoryFallback[key];
    try { localStorage.removeItem(LS_PREFIX + key); } catch (_) { /* rien */ }
  }

  // ---------------------------------------------------------------- réglages

  const DEFAULT_SETTINGS = { owner: '', theme: 'auto', lastCity: 'paris', labels: true, hint: true, autoSync: true, tiles: true, mapStyle: 'auto' };

  function getSettings() {
    const raw = lsGet('settings');
    let parsed = {};
    if (raw) {
      try { parsed = JSON.parse(raw) || {}; } catch (_) { parsed = {}; }
    }
    const s = Object.assign({}, DEFAULT_SETTINGS, parsed);
    if (!['auto', 'light', 'dark'].includes(s.theme)) s.theme = 'auto';
    if (!CW.CITY_ORDER.includes(s.lastCity)) s.lastCity = 'paris';
    s.owner = typeof s.owner === 'string' ? s.owner.slice(0, 40) : '';
    return s;
  }
  function setSettings(patch) {
    const next = Object.assign(getSettings(), patch || {});
    lsSet('settings', JSON.stringify(next));
    return next;
  }

  // ------------------------------------------------------------- progression

  const cache = {};
  const savers = {};
  let storageWarned = false;

  function loadProgress(cityId) {
    if (cache[cityId]) return cache[cityId];
    const raw = lsGet('progress:' + cityId);
    let parsed = null;
    if (raw) {
      try { parsed = JSON.parse(raw); } catch (_) { parsed = null; }
    }
    cache[cityId] = CW.normalizeProgress(parsed, cityId);
    return cache[cityId];
  }

  function persist(cityId) {
    const p = cache[cityId];
    if (!p) return;
    const ok = lsSet('progress:' + cityId, JSON.stringify(p));
    if (!ok && !storageWarned) {
      storageWarned = true;
      CW.toast("Impossible d'enregistrer sur cet appareil (stockage plein ou bloqué). Exporte ta carte pour ne rien perdre.", 'error', 9000);
    }
  }

  function saveProgress(cityId) {
    const p = loadProgress(cityId);
    p.updatedAt = Date.now();
    if (!savers[cityId]) savers[cityId] = CW.debounce(() => persist(cityId), 150);
    savers[cityId]();
  }

  function flushAll() {
    for (const id of Object.keys(savers)) savers[id].flush();
  }

  function replaceProgress(cityId, progress) {
    cache[cityId] = CW.normalizeProgress(progress, cityId);
    cache[cityId].updatedAt = Date.now();
    persist(cityId);
    return cache[cityId];
  }

  function getEntry(cityId, spotId) {
    const p = loadProgress(cityId);
    return p.spots[spotId] || null;
  }

  function ensureEntry(cityId, spotId) {
    const p = loadProgress(cityId);
    if (!p.spots[spotId]) p.spots[spotId] = CW.emptyEntry();
    return p.spots[spotId];
  }

  function updateEntry(cityId, spotId, patch) {
    const e = ensureEntry(cityId, spotId);
    Object.assign(e, patch);
    // Une entrée totalement vide est supprimée pour garder le stockage propre.
    if (!e.done && !e.date && !e.tags.length && !e.note && !e.photos.length && !e.rating) {
      delete loadProgress(cityId).spots[spotId];
    }
    saveProgress(cityId);
    return e;
  }

  function resetCity(cityId) {
    cache[cityId] = CW.emptyProgress(cityId);
    lsRemove('progress:' + cityId);
  }

  // ------------------------------------------------------------------ photos

  let dbPromise = null;
  let photosAvailable = !!window.indexedDB;

  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (!window.indexedDB) { photosAvailable = false; resolve(null); return; }
      let req;
      try {
        req = indexedDB.open(DB_NAME, DB_VERSION);
      } catch (err) {
        photosAvailable = false; resolve(null); return;
      }
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(PHOTO_STORE)) {
          const store = db.createObjectStore(PHOTO_STORE, { keyPath: 'id' });
          store.createIndex('bySpot', ['city', 'spot'], { unique: false });
          store.createIndex('byCity', 'city', { unique: false });
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => db.close();
        resolve(db);
      };
      req.onerror = () => { photosAvailable = false; resolve(null); };
      req.onblocked = () => { photosAvailable = false; resolve(null); };
    });
    return dbPromise;
  }

  function tx(db, mode) {
    return db.transaction(PHOTO_STORE, mode).objectStore(PHOTO_STORE);
  }
  const reqToPromise = (req) => new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('Erreur IndexedDB'));
  });

  async function putPhoto(record) {
    const db = await openDB();
    if (!db) throw new Error('Les photos ne peuvent pas être enregistrées sur cet appareil (IndexedDB indisponible).');
    await reqToPromise(tx(db, 'readwrite').put(record));
    return record.id;
  }

  async function getPhoto(id) {
    const db = await openDB();
    if (!db) return null;
    return (await reqToPromise(tx(db, 'readonly').get(id))) || null;
  }

  async function deletePhoto(id) {
    const db = await openDB();
    if (!db) return;
    await reqToPromise(tx(db, 'readwrite').delete(id));
    revokeURL(id);
  }

  async function photosForSpot(cityId, spotId) {
    const db = await openDB();
    if (!db) return [];
    const idx = tx(db, 'readonly').index('bySpot');
    const rows = await reqToPromise(idx.getAll(IDBKeyRange.only([cityId, spotId])));
    rows.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    return rows;
  }

  async function photosForCity(cityId) {
    const db = await openDB();
    if (!db) return [];
    const idx = tx(db, 'readonly').index('byCity');
    return reqToPromise(idx.getAll(IDBKeyRange.only(cityId)));
  }

  async function deletePhotosForCity(cityId) {
    const rows = await photosForCity(cityId);
    for (const r of rows) await deletePhoto(r.id);
  }

  /** Estimation de l'espace utilisé (si l'API existe). */
  async function storageEstimate() {
    try {
      if (navigator.storage && navigator.storage.estimate) return await navigator.storage.estimate();
    } catch (_) { /* rien */ }
    return null;
  }

  // Cache d'URL d'objets : une URL par (photo, variante), révoquée à la demande.
  const urlCache = new Map();
  function objectURL(record, variant) {
    const key = record.id + ':' + variant;
    if (urlCache.has(key)) return urlCache.get(key);
    const blob = record[variant] || record.full;
    if (!blob) return '';
    const url = URL.createObjectURL(blob);
    urlCache.set(key, url);
    return url;
  }
  function revokeURL(id) {
    for (const key of Array.from(urlCache.keys())) {
      if (key.startsWith(id + ':')) {
        URL.revokeObjectURL(urlCache.get(key));
        urlCache.delete(key);
      }
    }
  }

  window.addEventListener('pagehide', flushAll);
  window.addEventListener('beforeunload', flushAll);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushAll(); });

  CW.store = {
    getSettings, setSettings,
    loadProgress, saveProgress, flushAll, replaceProgress, resetCity,
    getEntry, ensureEntry, updateEntry,
    openDB, putPhoto, getPhoto, deletePhoto, photosForSpot, photosForCity, deletePhotosForCity,
    objectURL, revokeURL, storageEstimate,
    get photosAvailable() { return photosAvailable; },
  };
})();
