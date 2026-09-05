/* CityWalker — ingestion des photos : décodage, redimensionnement, vignette, EXIF. */
(function () {
  'use strict';
  const CW = window.CW;

  const MAX_FULL = 1600;     // côté le plus long de la version « pleine »
  const MAX_THUMB = 420;     // vignette
  const MAX_INPUT_BYTES = 60 * 1024 * 1024;

  function isHeic(file) {
    const t = (file.type || '').toLowerCase();
    return t === 'image/heic' || t === 'image/heif' || /\.hei[cf]$/i.test(file.name || '');
  }

  async function decode(file) {
    // 1. createImageBitmap (rapide, respecte l'orientation EXIF quand supporté)
    if (typeof createImageBitmap === 'function') {
      try {
        return await createImageBitmap(file, { imageOrientation: 'from-image' });
      } catch (_) {
        try { return await createImageBitmap(file); } catch (_2) { /* repli */ }
      }
    }
    // 2. <img> classique : les navigateurs modernes appliquent l'orientation EXIF par défaut
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('decode')); };
      img.src = url;
    });
  }

  function sizeOf(source) {
    return {
      w: source.naturalWidth || source.width,
      h: source.naturalHeight || source.height,
    };
  }

  function canvasToBlob(canvas, type, quality) {
    return new Promise((resolve, reject) => {
      if (canvas.toBlob) {
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob'))), type, quality);
      } else {
        try { resolve(CW.dataURLToBlob(canvas.toDataURL(type, quality))); } catch (e) { reject(e); }
      }
    });
  }

  async function resize(source, maxSide, quality) {
    const { w, h } = sizeOf(source);
    if (!(w > 0 && h > 0)) throw new Error('dimensions');
    const ratio = Math.min(1, maxSide / Math.max(w, h));
    const tw = Math.max(1, Math.round(w * ratio));
    const th = Math.max(1, Math.round(h * ratio));
    const canvas = document.createElement('canvas');
    canvas.width = tw;
    canvas.height = th;
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, tw, th);
    ctx.drawImage(source, 0, 0, tw, th);
    const blob = await canvasToBlob(canvas, 'image/jpeg', quality);
    return { blob, w: tw, h: th };
  }

  /**
   * Prépare une photo pour le stockage.
   * @returns {Promise<{full: Blob, thumb: Blob, w: number, h: number, takenAt: Date|null, lat: number|null, lon: number|null}>}
   */
  CW.ingestPhoto = async function ingestPhoto(file) {
    if (!file) throw new Error('Aucun fichier.');
    if (file.size > MAX_INPUT_BYTES) throw new Error(`« ${file.name} » dépasse 60 Mo.`);
    if (isHeic(file)) {
      // Safari décode le HEIC nativement ; ailleurs on prévient clairement.
      try {
        const bmp = await decode(file);
        return finish(bmp, file);
      } catch (_) {
        throw new Error(`« ${file.name} » est en HEIC, que ce navigateur ne sait pas lire. Sur iPhone : Réglages → Appareil photo → Formats → « Le plus compatible », ou exporte la photo en JPEG.`);
      }
    }
    let source;
    try {
      source = await decode(file);
    } catch (_) {
      throw new Error(`« ${file.name} » n'a pas pu être lue comme une image.`);
    }
    return finish(source, file);
  };

  async function finish(source, file) {
    const [exif, full, thumb] = await Promise.all([
      CW.readExif(file),
      resize(source, MAX_FULL, 0.84),
      resize(source, MAX_THUMB, 0.78),
    ]);
    if (source.close) { try { source.close(); } catch (_) { /* rien */ } }
    return { full: full.blob, thumb: thumb.blob, w: full.w, h: full.h, takenAt: exif.takenAt, lat: exif.lat, lon: exif.lon };
  }

  /** Distance approximative (m) entre deux points lat/lon. */
  CW.distanceM = function distanceM(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
  };

  /** Lieu le plus proche d'une position GPS (dans un rayon donné), ou null. */
  CW.nearestSpot = function nearestSpot(city, lat, lon, maxM) {
    let best = null;
    let bestD = Infinity;
    for (const s of city.spots) {
      const d = CW.distanceM(lat, lon, s.lat, s.lon);
      if (d < bestD) { bestD = d; best = s; }
    }
    if (!best || bestD > (maxM || 350)) return null;
    return { spot: best, distance: Math.round(bestD) };
  };
})();
