/* CityWalker — partage : lien en lecture seule, export / import de sauvegarde, fusion. */
(function () {
  'use strict';
  const CW = window.CW;

  const LINK_PREFIX = 'cw1';          // version du format de lien

  // ------------------------------------------------------------ compression

  async function deflate(bytes) {
    if (typeof CompressionStream !== 'function') return null;
    try {
      const cs = new CompressionStream('deflate-raw');
      const stream = new Blob([bytes]).stream().pipeThrough(cs);
      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch (_) {
      return null;
    }
  }
  async function inflate(bytes) {
    if (typeof DecompressionStream !== 'function') {
      throw new Error("Ce navigateur ne sait pas lire les liens compressés — ouvre le lien avec un navigateur récent.");
    }
    const ds = new DecompressionStream('deflate-raw');
    const stream = new Blob([bytes]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  // ---------------------------------------------------------- lien de partage

  function tagsToBits(tags) {
    let bits = 0;
    for (const t of tags || []) {
      const i = CW.TAG_INDEX[t];
      if (i !== undefined) bits |= 1 << i;
    }
    return bits;
  }
  function bitsToTags(bits) {
    const out = [];
    for (let i = 0; i < CW.TAGS.length; i++) if (bits & (1 << i)) out.push(CW.TAGS[i].id);
    return out;
  }

  /** Charge utile compacte : uniquement ce qui est utile à la lecture. */
  function compactPayload(cityId, progress, opts) {
    const s = {};
    for (const id of Object.keys(progress.spots)) {
      const e = progress.spots[id];
      if (!CW.isDone(e) && !e.tags.length && !e.note) continue;
      const row = [CW.isDone(e) ? 1 : 0, tagsToBits(e.tags), e.photos.length, e.date || ''];
      if (opts && opts.notes && e.note) row.push(e.note);
      s[id] = row;
    }
    // Les lieux posés à la main voyagent aussi : c'est souvent le plus intéressant.
    const x = (progress.custom || []).map((c) => [c.id, c.name, c.cat, c.x, c.y, c.lat, c.lon, c.zone || '']);
    return { v: 1, c: cityId, o: (progress.owner || (opts && opts.owner) || '').slice(0, 40), t: progress.updatedAt || Date.now(), s, x };
  }

  /** Construit le fragment `#p=...` à coller après l'URL de l'application. */
  CW.encodeShare = async function encodeShare(cityId, progress, opts) {
    const json = JSON.stringify(compactPayload(cityId, progress, opts));
    const raw = new TextEncoder().encode(json);
    const packed = await deflate(raw);
    if (packed && packed.length < raw.length) return `${LINK_PREFIX}d.${CW.b64url.encode(packed)}`;
    return `${LINK_PREFIX}r.${CW.b64url.encode(raw)}`;
  };

  /** Décode un fragment de partage ; renvoie {city, owner, updatedAt, progress} ou lève. */
  CW.decodeShare = async function decodeShare(token) {
    const m = /^cw1([dr])\.([A-Za-z0-9_-]+)$/.exec(String(token || '').trim());
    if (!m) throw new Error('Lien de partage illisible.');
    let bytes = CW.b64url.decode(m[2]);
    if (m[1] === 'd') bytes = await inflate(bytes);
    let payload;
    try { payload = JSON.parse(new TextDecoder().decode(bytes)); } catch (_) { throw new Error('Lien de partage corrompu.'); }
    if (!payload || payload.v !== 1 || !CW.CITY_ORDER.includes(payload.c) || typeof payload.s !== 'object') {
      throw new Error('Lien de partage incompatible.');
    }
    const progress = CW.emptyProgress(payload.c);
    progress.owner = typeof payload.o === 'string' ? payload.o.slice(0, 40) : '';
    progress.updatedAt = Number.isFinite(payload.t) ? payload.t : 0;
    for (const id of Object.keys(payload.s)) {
      const row = payload.s[id];
      if (!Array.isArray(row)) continue;
      const entry = CW.emptyEntry();
      entry.done = row[0] === 1;
      entry.tags = bitsToTags(Number(row[1]) || 0);
      const count = Math.max(0, Math.min(999, Number(row[2]) || 0));
      // Les photos ne voyagent pas dans le lien : on garde seulement leur nombre.
      entry.photos = [];
      entry.photoCount = count;
      entry.date = typeof row[3] === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(row[3]) ? row[3] : '';
      entry.note = typeof row[4] === 'string' ? row[4].slice(0, 2000) : '';
      progress.spots[id] = entry;
    }
    if (Array.isArray(payload.x)) {
      for (const row of payload.x.slice(0, 500)) {
        if (!Array.isArray(row)) continue;
        const c = CW.normalizeCustom({ id: row[0], name: row[1], cat: row[2], x: row[3], y: row[4], lat: row[5], lon: row[6], zone: row[7] });
        if (c) progress.custom.push(c);
      }
    }
    return { city: payload.c, owner: progress.owner, updatedAt: progress.updatedAt, progress };
  };

  CW.shareURL = function shareURL(token) {
    const base = location.href.split('#')[0];
    return `${base}#p=${token}`;
  };

  CW.readShareFromLocation = function readShareFromLocation() {
    const h = location.hash || '';
    const m = /[#&]p=([^&]+)/.exec(h);
    return m ? decodeURIComponent(m[1]) : null;
  };

  // ------------------------------------------------------------ fusion

  /** Fusionne `theirs` dans `mine` (union : rien n'est jamais retiré). */
  CW.mergeProgress = function mergeProgress(mine, theirs) {
    const out = CW.normalizeProgress(mine, mine.city);
    let changed = 0;
    for (const id of Object.keys(theirs.spots || {})) {
      const t = theirs.spots[id];
      const m = out.spots[id] || CW.emptyEntry();
      const before = JSON.stringify(m);
      m.done = m.done || !!t.done || (t.photoCount > 0);
      m.tags = Array.from(new Set([...(m.tags || []), ...(t.tags || [])]));
      if (!m.date && t.date) m.date = t.date;
      if (t.note && !m.note) m.note = t.note;
      else if (t.note && m.note && !m.note.includes(t.note)) m.note = `${m.note}\n— ${t.note}`;
      m.photos = Array.from(new Set([...(m.photos || []), ...(t.photos || [])]));
      m.rating = Math.max(m.rating || 0, t.rating || 0);
      if (JSON.stringify(m) !== before) changed++;
      out.spots[id] = m;
    }
    const known = new Set(out.custom.map((c) => c.id));
    for (const c of theirs.custom || []) {
      if (known.has(c.id)) continue;
      const clean = CW.normalizeCustom(c);
      if (clean) { out.custom.push(clean); known.add(clean.id); changed++; }
    }
    if (!out.owner && theirs.owner) out.owner = theirs.owner;
    return { progress: out, changed };
  };

  // ------------------------------------------------------- export / import

  /** Sauvegarde complète (progression + photos) d'une ou plusieurs villes. */
  CW.exportBundle = async function exportBundle(cityIds, onProgress) {
    const bundle = { app: 'citywalker', v: 1, exportedAt: new Date().toISOString(), cities: {}, photos: [] };
    let n = 0;
    for (const cityId of cityIds) {
      bundle.cities[cityId] = CW.store.loadProgress(cityId);
      const rows = await CW.store.photosForCity(cityId);
      for (const r of rows) {
        bundle.photos.push({
          id: r.id, city: r.city, spot: r.spot, w: r.w, h: r.h,
          takenAt: r.takenAt || '', caption: r.caption || '', createdAt: r.createdAt || 0,
          full: await CW.blobToDataURL(r.full),
          thumb: r.thumb ? await CW.blobToDataURL(r.thumb) : '',
        });
        n++;
        if (onProgress) onProgress(n);
      }
    }
    return bundle;
  };

  /** Lit et valide un fichier de sauvegarde. */
  CW.parseBundle = async function parseBundle(file) {
    const text = await CW.readFileAsText(file);
    let data;
    try { data = JSON.parse(text); } catch (_) { throw new Error("Ce fichier n'est pas une sauvegarde CityWalker."); }
    if (!data || data.app !== 'citywalker' || !data.cities || typeof data.cities !== 'object') {
      throw new Error("Ce fichier n'est pas une sauvegarde CityWalker.");
    }
    const cities = {};
    for (const id of Object.keys(data.cities)) {
      if (CW.CITY_ORDER.includes(id)) cities[id] = CW.normalizeProgress(data.cities[id], id);
    }
    const photos = Array.isArray(data.photos) ? data.photos.filter((p) => p && typeof p.id === 'string' && CW.CITY_ORDER.includes(p.city) && typeof p.spot === 'string' && typeof p.full === 'string') : [];
    return { cities, photos, exportedAt: data.exportedAt || '' };
  };

  /** Applique une sauvegarde : fusionne la progression, ajoute les photos manquantes. */
  CW.applyBundle = async function applyBundle(bundle, onProgress) {
    const report = { cities: 0, changed: 0, photosAdded: 0, photosSkipped: 0 };
    const seen = new Set();
    for (const cityId of Object.keys(bundle.cities)) {
      const mine = CW.store.loadProgress(cityId);
      const { progress, changed } = CW.mergeProgress(mine, bundle.cities[cityId]);
      CW.store.replaceProgress(cityId, progress);
      report.cities++;
      report.changed += changed;
    }
    let n = 0;
    for (const p of bundle.photos) {
      n++;
      if (onProgress) onProgress(n, bundle.photos.length);
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      try {
        const existing = await CW.store.getPhoto(p.id);
        if (existing) { report.photosSkipped++; continue; }
        const full = CW.dataURLToBlob(p.full);
        const thumb = p.thumb ? CW.dataURLToBlob(p.thumb) : full;
        await CW.store.putPhoto({
          id: p.id, city: p.city, spot: p.spot, w: p.w || 0, h: p.h || 0,
          takenAt: p.takenAt || '', caption: p.caption || '', createdAt: p.createdAt || Date.now(),
          full, thumb,
        });
        const entry = CW.store.ensureEntry(p.city, p.spot);
        if (!entry.photos.includes(p.id)) entry.photos.push(p.id);
        entry.done = true;
        CW.store.saveProgress(p.city);
        report.photosAdded++;
      } catch (_) {
        report.photosSkipped++;
      }
    }
    CW.store.flushAll();
    return report;
  };

  CW._share = { tagsToBits, bitsToTags, compactPayload };
})();
