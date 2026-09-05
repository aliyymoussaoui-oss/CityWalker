/* CityWalker — lecteur EXIF minimal (JPEG uniquement) : date de prise de vue + GPS.
 *
 * Tout est défensif : la moindre incohérence renvoie simplement des champs nuls.
 * On ne lit que l'en-tête (les 256 premiers Ko suffisent toujours pour l'APP1).
 */
(function () {
  'use strict';
  const CW = window.CW;

  const TAG_EXIF_IFD = 0x8769;
  const TAG_GPS_IFD = 0x8825;
  const TAG_DATE_ORIGINAL = 0x9003;
  const TAG_DATE_DIGITIZED = 0x9004;
  const TAG_DATETIME = 0x0132;
  const GPS_LAT_REF = 0x0001, GPS_LAT = 0x0002, GPS_LON_REF = 0x0003, GPS_LON = 0x0004;

  const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };

  /** Cherche le segment APP1 Exif dans un JPEG ; renvoie l'offset du TIFF ou -1. */
  function findTiff(view) {
    if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) return -1;
    let offset = 2;
    while (offset + 4 <= view.byteLength) {
      if (view.getUint8(offset) !== 0xff) return -1;
      const marker = view.getUint8(offset + 1);
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { offset += 2; continue; }
      if (marker === 0xda || marker === 0xd9) return -1;                 // début des données image : pas d'EXIF
      const size = view.getUint16(offset + 2);
      if (size < 2) return -1;
      if (marker === 0xe1 && offset + 10 <= view.byteLength) {
        // "Exif\0\0"
        if (view.getUint32(offset + 4) === 0x45786966 && view.getUint16(offset + 8) === 0x0000) {
          return offset + 10;
        }
      }
      offset += 2 + size;
    }
    return -1;
  }

  function parseTiff(view, tiff) {
    if (tiff + 8 > view.byteLength) return null;
    const bom = view.getUint16(tiff);
    let little;
    if (bom === 0x4949) little = true;
    else if (bom === 0x4d4d) little = false;
    else return null;
    if (view.getUint16(tiff + 2, little) !== 0x002a) return null;
    const ifd0 = view.getUint32(tiff + 4, little);
    if (ifd0 < 8 || tiff + ifd0 + 2 > view.byteLength) return null;
    return { little, ifd0: tiff + ifd0 };
  }

  function readIFD(view, tiff, start, little) {
    const entries = {};
    if (start + 2 > view.byteLength) return entries;
    const count = view.getUint16(start, little);
    if (count > 512) return entries;
    for (let i = 0; i < count; i++) {
      const e = start + 2 + i * 12;
      if (e + 12 > view.byteLength) break;
      const tag = view.getUint16(e, little);
      const type = view.getUint16(e + 2, little);
      const n = view.getUint32(e + 4, little);
      const size = TYPE_SIZE[type];
      if (!size || n > 1e6) continue;
      const total = size * n;
      const valueOffset = total <= 4 ? e + 8 : tiff + view.getUint32(e + 8, little);
      if (valueOffset < 0 || valueOffset + total > view.byteLength) continue;
      entries[tag] = { type, n, offset: valueOffset };
    }
    return entries;
  }

  function readAscii(view, entry) {
    let s = '';
    for (let i = 0; i < entry.n; i++) {
      const c = view.getUint8(entry.offset + i);
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s;
  }

  function readRationals(view, entry, little) {
    const out = [];
    if (entry.type !== 5 && entry.type !== 10) return out;
    for (let i = 0; i < entry.n; i++) {
      const o = entry.offset + i * 8;
      const num = entry.type === 5 ? view.getUint32(o, little) : view.getInt32(o, little);
      const den = entry.type === 5 ? view.getUint32(o + 4, little) : view.getInt32(o + 4, little);
      out.push(den === 0 ? NaN : num / den);
    }
    return out;
  }

  function readLong(view, entry, little) {
    if (entry.type === 4) return view.getUint32(entry.offset, little);
    if (entry.type === 3) return view.getUint16(entry.offset, little);
    return null;
  }

  /** "YYYY:MM:DD HH:MM:SS" -> Date locale, ou null. */
  function parseExifDate(s) {
    const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(s || '');
    if (!m) return null;
    const [y, mo, d, h, mi, se] = m.slice(1).map(Number);
    if (y < 1900 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    const date = new Date(y, mo - 1, d, h, mi, se);
    return isNaN(date.getTime()) ? null : date;
  }

  function dmsToDeg(parts, ref) {
    if (!parts || parts.length < 2 || parts.some((x) => !Number.isFinite(x))) return null;
    const deg = parts[0] + (parts[1] || 0) / 60 + (parts[2] || 0) / 3600;
    if (!Number.isFinite(deg)) return null;
    const sign = ref === 'S' || ref === 'W' ? -1 : 1;
    return sign * deg;
  }

  /**
   * Lit les métadonnées d'un fichier image.
   * @returns {Promise<{takenAt: Date|null, lat: number|null, lon: number|null}>}
   */
  CW.readExif = async function readExif(file) {
    const empty = { takenAt: null, lat: null, lon: null };
    try {
      if (!file || !(file.type === 'image/jpeg' || /\.jpe?g$/i.test(file.name || ''))) return empty;
      const head = file.slice(0, 256 * 1024);
      const buf = await CW.readFileAsArrayBuffer(head);
      const view = new DataView(buf);
      const tiff = findTiff(view);
      if (tiff < 0) return empty;
      const hdr = parseTiff(view, tiff);
      if (!hdr) return empty;
      const { little } = hdr;
      const ifd0 = readIFD(view, tiff, hdr.ifd0, little);
      const result = Object.assign({}, empty);

      let dateStr = '';
      if (ifd0[TAG_EXIF_IFD]) {
        const p = readLong(view, ifd0[TAG_EXIF_IFD], little);
        if (p !== null && tiff + p < view.byteLength) {
          const exif = readIFD(view, tiff, tiff + p, little);
          const e = exif[TAG_DATE_ORIGINAL] || exif[TAG_DATE_DIGITIZED];
          if (e && e.type === 2) dateStr = readAscii(view, e);
        }
      }
      if (!dateStr && ifd0[TAG_DATETIME] && ifd0[TAG_DATETIME].type === 2) dateStr = readAscii(view, ifd0[TAG_DATETIME]);
      result.takenAt = parseExifDate(dateStr);

      if (ifd0[TAG_GPS_IFD]) {
        const p = readLong(view, ifd0[TAG_GPS_IFD], little);
        if (p !== null && tiff + p < view.byteLength) {
          const gps = readIFD(view, tiff, tiff + p, little);
          const latRef = gps[GPS_LAT_REF] ? readAscii(view, gps[GPS_LAT_REF]) : 'N';
          const lonRef = gps[GPS_LON_REF] ? readAscii(view, gps[GPS_LON_REF]) : 'E';
          const lat = gps[GPS_LAT] ? dmsToDeg(readRationals(view, gps[GPS_LAT], little), latRef) : null;
          const lon = gps[GPS_LON] ? dmsToDeg(readRationals(view, gps[GPS_LON], little), lonRef) : null;
          if (lat !== null && lon !== null && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && !(lat === 0 && lon === 0)) {
            result.lat = lat;
            result.lon = lon;
          }
        }
      }
      return result;
    } catch (_) {
      return empty;
    }
  };

  // Exposé pour les tests unitaires.
  CW._exif = { findTiff, parseTiff, readIFD, parseExifDate, dmsToDeg };
})();
