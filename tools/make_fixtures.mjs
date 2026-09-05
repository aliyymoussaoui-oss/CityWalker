/**
 * Fabrique des JPEG de test porteurs d'un vrai segment EXIF (GPS + date).
 *
 *   node tools/make_fixtures.mjs
 *
 * Les positions sont calculées depuis data/montpellier.json : un groupe posé sur
 * la place de la Comédie, un autre à l'écart de tout lieu connu, et une photo
 * sans aucune métadonnée.
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';

const OUT = 'tests/fixtures';
const city = JSON.parse(readFileSync('data/montpellier.json', 'utf8'));

// ---------------------------------------------------------------- EXIF

function rational(view, off, value, den) {
  view.setUint32(off, Math.round(value * den), true);
  view.setUint32(off + 4, den, true);
}

function dmsBytes(view, off, deg) {
  const d = Math.floor(Math.abs(deg));
  const mFloat = (Math.abs(deg) - d) * 60;
  const m = Math.floor(mFloat);
  const s = (mFloat - m) * 60;
  rational(view, off, d, 1);
  rational(view, off + 8, m, 1);
  rational(view, off + 16, s, 1000);
}

/** Segment APP1 « Exif » complet, en little-endian. */
function buildExif(lat, lon, dateStr) {
  const TIFF_LEN = 160;
  const buf = new ArrayBuffer(TIFF_LEN);
  const v = new DataView(buf);
  const b = new Uint8Array(buf);
  b[0] = 0x49; b[1] = 0x49;              // "II"
  v.setUint16(2, 0x002a, true);
  v.setUint32(4, 8, true);               // IFD0 à l'offset 8

  v.setUint16(8, 2, true);               // deux entrées dans IFD0
  // 0x0132 DateTime, ASCII, 20 octets, stockés à l'offset 92
  v.setUint16(10, 0x0132, true); v.setUint16(12, 2, true); v.setUint32(14, 20, true); v.setUint32(18, 92, true);
  // 0x8825 pointeur vers l'IFD GPS, à l'offset 38
  v.setUint16(22, 0x8825, true); v.setUint16(24, 4, true); v.setUint32(26, 1, true); v.setUint32(30, 38, true);
  v.setUint32(34, 0, true);              // pas d'IFD1

  v.setUint16(38, 4, true);              // quatre entrées GPS
  const latRef = lat >= 0 ? 'N' : 'S';
  const lonRef = lon >= 0 ? 'E' : 'W';
  v.setUint16(40, 0x0001, true); v.setUint16(42, 2, true); v.setUint32(44, 2, true);
  b[48] = latRef.charCodeAt(0); b[49] = 0;
  v.setUint16(52, 0x0002, true); v.setUint16(54, 5, true); v.setUint32(56, 3, true); v.setUint32(60, 112, true);
  v.setUint16(64, 0x0003, true); v.setUint16(66, 2, true); v.setUint32(68, 2, true);
  b[72] = lonRef.charCodeAt(0); b[73] = 0;
  v.setUint16(76, 0x0004, true); v.setUint16(78, 5, true); v.setUint32(80, 3, true); v.setUint32(84, 136, true);
  v.setUint32(88, 0, true);

  for (let i = 0; i < 19; i++) b[92 + i] = dateStr.charCodeAt(i) || 0;
  b[111] = 0;
  dmsBytes(v, 112, lat);
  dmsBytes(v, 136, lon);

  const header = new Uint8Array(10);
  const hv = new DataView(header.buffer);
  hv.setUint16(0, 0xffe1);
  hv.setUint16(2, 8 + TIFF_LEN);          // longueur = 2 + "Exif\0\0" (6) + TIFF
  header.set([0x45, 0x78, 0x69, 0x66, 0x00, 0x00], 4);
  const out = new Uint8Array(header.length + TIFF_LEN);
  out.set(header, 0);
  out.set(b, header.length);
  return out;
}

function withExif(jpeg, exif) {
  if (!(jpeg[0] === 0xff && jpeg[1] === 0xd8)) throw new Error('pas un JPEG');
  const out = new Uint8Array(jpeg.length + exif.length);
  out.set(jpeg.subarray(0, 2), 0);
  out.set(exif, 2);
  out.set(jpeg.subarray(2), 2 + exif.length);
  return out;
}

// ------------------------------------------------- un point loin de tout

function distanceM(lat1, lon1, lat2, lon2) {
  const R = 6371000, rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(lat2 - lat1), dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

function farFromEverything() {
  const lats = city.spots.map((s) => s.lat), lons = city.spots.map((s) => s.lon);
  const latMin = Math.min(...lats), latMax = Math.max(...lats);
  const lonMin = Math.min(...lons), lonMax = Math.max(...lons);
  let best = null, bestD = 0;
  for (let i = 1; i < 40; i++) {
    for (let j = 1; j < 40; j++) {
      const lat = latMin + ((latMax - latMin) * i) / 40;
      const lon = lonMin + ((lonMax - lonMin) * j) / 40;
      let d = Infinity;
      for (const s of city.spots) d = Math.min(d, distanceM(lat, lon, s.lat, s.lon));
      if (d > bestD && d < 3000) { bestD = d; best = { lat, lon }; }
    }
  }
  return { ...best, distance: Math.round(bestD) };
}

// ---------------------------------------------------------------- rendu

const browser = await chromium.launch({ executablePath: process.env.CW_CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await (await browser.newContext()).newPage();
await page.setContent('<canvas id="c" width="600" height="400"></canvas>');

async function baseJpeg(hue) {
  const dataUrl = await page.evaluate((h) => {
    const c = document.getElementById('c');
    const ctx = c.getContext('2d');
    const g = ctx.createLinearGradient(0, 0, 600, 400);
    g.addColorStop(0, `hsl(${h},60%,70%)`);
    g.addColorStop(1, `hsl(${(h + 60) % 360},60%,35%)`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 600, 400);
    ctx.fillStyle = '#fff';
    ctx.font = '40px sans-serif';
    ctx.fillText(String(h), 30, 220);
    return c.toDataURL('image/jpeg', 0.8);
  }, hue);
  return Buffer.from(dataUrl.split(',')[1], 'base64');
}

mkdirSync(OUT, { recursive: true });
const comedie = city.spots.find((s) => s.id === 'place-comedie');
const far = farFromEverything();
const manifest = { comedie: { lat: comedie.lat, lon: comedie.lon, name: comedie.name }, far, files: [] };

let hue = 0;
async function write(name, lat, lon, date) {
  const jpeg = await baseJpeg((hue += 47) % 360);
  const bytes = lat === null ? jpeg : Buffer.from(withExif(new Uint8Array(jpeg), buildExif(lat, lon, date)));
  writeFileSync(`${OUT}/${name}`, bytes);
  manifest.files.push({ name, lat, lon, date });
}

// Trois photos sur la place de la Comédie, à quelques dizaines de mètres près.
await write('comedie-1.jpg', comedie.lat, comedie.lon, '2026:04:11 19:42:10');
await write('comedie-2.jpg', comedie.lat + 0.0004, comedie.lon, '2026:04:11 19:48:02');
await write('comedie-3.jpg', comedie.lat, comedie.lon + 0.0004, '2025:11:02 08:15:00');
// Deux photos loin de tout lieu connu : elles doivent créer un nouveau lieu.
await write('ailleurs-1.jpg', far.lat, far.lon, '2026:06:01 12:00:00');
await write('ailleurs-2.jpg', far.lat + 0.0002, far.lon, '2026:06:01 12:04:00');
// Une photo sans la moindre métadonnée.
await write('sans-gps.jpg', null, null, '');

writeFileSync(`${OUT}/manifest.json`, JSON.stringify(manifest, null, 1));
await browser.close();
console.log(`${manifest.files.length} fixtures dans ${OUT}/ — point isolé à ${far.distance} m du lieu le plus proche`);
