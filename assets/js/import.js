/* CityWalker — import de photothèque : lire les positions GPS et replacer chaque
 * photo là où elle a été prise.
 *
 * Déroulé : l'utilisateur autorise l'accès (sélection de fichiers ou de dossier),
 * on lit uniquement l'en-tête EXIF de chaque image — rien n'est envoyé nulle part —
 * puis on propose un rapport à valider avant d'écrire quoi que ce soit.
 */
(function () {
  'use strict';
  const CW = window.CW;

  const MAX_FILES = 5000;
  const CLUSTER_M = 80;          // deux photos plus proches que ça forment un même lieu
  const NEW_SPOT_MIN = 2;        // il faut au moins deux photos pour proposer un nouveau lieu

  const isImage = (f) => /^image\//.test(f.type || '') || /\.(jpe?g|png|heic|heif|webp)$/i.test(f.name || '');

  /**
   * Lit les métadonnées d'un lot de fichiers.
   * @param {File[]} files
   * @param {(done:number,total:number)=>void} onProgress
   * @returns {Promise<Array<{file: File, lat: number|null, lon: number|null, takenAt: Date|null}>>}
   */
  async function readAll(files, onProgress, signal) {
    const out = [];
    let done = 0;
    for (const file of files) {
      if (signal && signal.aborted) break;
      let meta = { lat: null, lon: null, takenAt: null };
      try { meta = await CW.readExif(file); } catch (_) { /* photo illisible : sans position */ }
      out.push({ file, lat: meta.lat, lon: meta.lon, takenAt: meta.takenAt });
      done++;
      if (onProgress && (done % 10 === 0 || done === files.length)) onProgress(done, files.length);
      // On rend la main au navigateur pour que la barre de progression avance.
      if (done % 25 === 0) await new Promise((r) => setTimeout(r, 0));
    }
    return out;
  }

  /** Regroupe des photos sans lieu connu en amas géographiques. */
  function cluster(items) {
    const clusters = [];
    for (const item of items) {
      let host = null;
      for (const c of clusters) {
        if (CW.distanceM(c.lat, c.lon, item.lat, item.lon) <= CLUSTER_M) { host = c; break; }
      }
      if (host) {
        host.items.push(item);
        host.lat = host.items.reduce((a, b) => a + b.lat, 0) / host.items.length;
        host.lon = host.items.reduce((a, b) => a + b.lon, 0) / host.items.length;
      } else {
        clusters.push({ lat: item.lat, lon: item.lon, items: [item] });
      }
    }
    return clusters;
  }

  /**
   * Classe des photos lues par rapport aux lieux d'une ville.
   * @returns {{groups: Array, noGps: number, elsewhere: Array, otherCity: string}}
   */
  function classify(read, city, spots, radiusM) {
    const groups = [];
    const bySpot = new Map();
    const unmatched = [];
    let noGps = 0;

    for (const item of read) {
      if (item.lat === null || item.lon === null) { noGps++; continue; }
      let best = null, bestD = Infinity;
      for (const s of spots) {
        const d = CW.distanceM(item.lat, item.lon, s.lat, s.lon);
        if (d < bestD) { bestD = d; best = s; }
      }
      if (best && bestD <= radiusM) {
        if (!bySpot.has(best.id)) bySpot.set(best.id, { kind: 'spot', spot: best, items: [], distance: 0 });
        const g = bySpot.get(best.id);
        g.items.push(item);
        g.distance = Math.max(g.distance, Math.round(bestD));
      } else {
        unmatched.push(item);
      }
    }

    // Ce qui tombe hors de la ville n'a rien à y faire.
    const inCity = [], elsewhere = [];
    for (const item of unmatched) {
      (insideBBox(city, item.lat, item.lon) ? inCity : elsewhere).push(item);
    }

    for (const g of bySpot.values()) groups.push(g);
    for (const c of cluster(inCity)) {
      if (c.items.length < NEW_SPOT_MIN) { elsewhere.push(...c.items); continue; }
      groups.push({ kind: 'new', lat: c.lat, lon: c.lon, items: c.items });
    }
    groups.sort((a, b) => b.items.length - a.items.length);
    return { groups, noGps, elsewhere };
  }

  /** Boîte englobante d'une ville, avec une marge d'un kilomètre. */
  function insideBBox(city, lat, lon) {
    if (!city._bbox) {
      let latMin = 90, latMax = -90, lonMin = 180, lonMax = -180;
      for (const s of city.spots) {
        latMin = Math.min(latMin, s.lat); latMax = Math.max(latMax, s.lat);
        lonMin = Math.min(lonMin, s.lon); lonMax = Math.max(lonMax, s.lon);
      }
      const padLat = 0.012;                                  // ~1,3 km
      const padLon = padLat / Math.cos((latMin * Math.PI) / 180);
      city._bbox = { latMin: latMin - padLat, latMax: latMax + padLat, lonMin: lonMin - padLon, lonMax: lonMax + padLon };
    }
    const b = city._bbox;
    return lat >= b.latMin && lat <= b.latMax && lon >= b.lonMin && lon <= b.lonMax;
  }

  /** Dans quelle ville connue tombe cette position ? */
  function cityOf(cities, lat, lon) {
    for (const id of CW.CITY_ORDER) {
      const c = cities[id];
      if (c && insideBBox(c, lat, lon)) return id;
    }
    return null;
  }

  /** Ouvre un dossier avec l'API File System Access, quand le navigateur la fournit. */
  async function pickDirectory(onFound) {
    if (typeof window.showDirectoryPicker !== 'function') return null;
    let handle;
    try {
      handle = await window.showDirectoryPicker({ id: 'citywalker-photos', mode: 'read' });
    } catch (_) {
      return null;              // l'utilisateur a refusé ou annulé
    }
    const files = [];
    async function walk(dir, depth) {
      if (depth > 4 || files.length >= MAX_FILES) return;
      for await (const entry of dir.values()) {
        if (files.length >= MAX_FILES) return;
        if (entry.kind === 'file') {
          const file = await entry.getFile();
          if (isImage(file)) { files.push(file); if (onFound) onFound(files.length); }
        } else if (entry.kind === 'directory') {
          await walk(entry, depth + 1);
        }
      }
    }
    await walk(handle, 0);
    return files;
  }

  CW.photoImport = {
    MAX_FILES, CLUSTER_M, NEW_SPOT_MIN,
    isImage, readAll, classify, cityOf, pickDirectory, insideBBox,
    supportsDirectory: () => typeof window.showDirectoryPicker === 'function',
  };
})();
