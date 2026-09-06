/**
 * Tests de bout en bout de CityWalker (Chromium headless).
 *
 *   node tests/smoke.mjs
 *
 * Le test échoue au moindre message d'erreur console ou exception de page :
 * un rendu qui « marche à l'écran » mais jette une erreur est considéré cassé.
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml' };

let passed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failures.push(`${name}${detail ? ' — ' + detail : ''}`); console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

function serve() {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      try {
        const url = decodeURIComponent((req.url || '/').split('?')[0]);
        const rel = normalize(url === '/' ? '/index.html' : url).replace(/^(\.\.[/\\])+/, '');
        // Fausses tuiles : un pixel PNG, pour vérifier la géométrie sans réseau.
        if (rel.startsWith('/faketiles/') || rel.startsWith('faketiles/')) {
          res.writeHead(200, { 'content-type': 'image/png' });
          res.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
          return;
        }
        const file = join(ROOT, rel);
        if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
        await stat(file);
        const body = await readFile(file);
        res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
        res.end(body);
      } catch {
        res.writeHead(404).end('not found');
      }
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

// Chrome local de cette machine ; sur une machine sans lui, Playwright utilise le sien.
const DEFAULT_CHROME = existsSync('/opt/pw-browsers/chromium-1194/chrome-linux/chrome')
  ? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' : undefined;

const { server, port } = await serve();
const base = `http://127.0.0.1:${port}/`;
const browser = await chromium.launch({ executablePath: process.env.CW_CHROME || DEFAULT_CHROME });

async function newPage(ctx) {
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('requestfailed', (r) => errors.push(`requête échouée: ${r.url()}`));
  page.errors = errors;
  return page;
}

const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await newPage(ctx);
await page.goto(base, { waitUntil: 'load' });
await page.waitForSelector('#app[aria-busy="false"]', { timeout: 25000 });

console.log('\n— Chargement —');
check('la carte de Paris est rendue', await page.locator('#map .pin').count() === 155, `${await page.locator('#map .pin').count()} épingles`);
check('20 arrondissements dessinés', await page.locator('#map .zone').count() === 20);
check('les couches eau et vert sont là', (await page.locator('#map .layer-water path').count()) > 20 && (await page.locator('#map .layer-green path').count()) > 50);
check('la liste liste les 155 lieux', await page.locator('.spot-row').count() === 155);
check('titre de la ville', (await page.locator('.map-city-name').textContent()) === 'Paris');

console.log('\n— Cocher un lieu —');
await page.locator('.spot-row').first().click();
await page.waitForSelector('#sheet:not([hidden])');
const spotName = await page.locator('.sheet-title').textContent();
await page.locator('.done-toggle').click();
await page.waitForSelector('.done-toggle.is-on');
check('l’épingle passe en « fait »', await page.locator('#map .pin.is-done').count() === 1);
check('le compteur ville se met à jour', (await page.locator('[data-pct-for="paris"]').textContent()).trim() === '1 %');
check('la date du jour est pré-remplie', /\d{4}-\d{2}-\d{2}/.test(await page.locator('.field input[type="date"]').inputValue()));

console.log('\n— Ambiances —');
await page.locator('.tag-row .tag-chip').nth(2).click();      // coucher de soleil
await page.waitForTimeout(80);
check('l’ambiance est enregistrée', await page.locator('.tag-row .tag-chip.is-on').count() === 1);
await page.locator('.side-tab[data-tab="progress"]').click();
await page.waitForSelector('#tab-progress:not([hidden])');
const sunsetRow = await page.locator('.prog-tag', { hasText: 'Au coucher du soleil' }).textContent();
check('la progression compte l’ambiance', /1\/10/.test(sunsetRow), sunsetRow);
check('le pourcentage global est affiché', (await page.locator('.ring-text').first().textContent()).includes('1'));

console.log('\n— Filtres —');
await page.locator('.side-tab[data-tab="lieux"]').click();
await page.locator('#filter-state .chip[data-state="done"]').click();
await page.waitForTimeout(120);
check('le filtre « photographiés » ne garde qu’un lieu', await page.locator('.spot-row').count() === 1);
await page.locator('#filter-state .chip[data-state="tous"]').click();
await page.fill('#search', 'abreuvoir');
await page.waitForTimeout(250);
check('la recherche sans accent fonctionne', await page.locator('.spot-row').count() === 1, await page.locator('.spot-name').first().textContent());
await page.fill('#search', '');
await page.waitForTimeout(250);

console.log('\n— Persistance —');
await page.reload({ waitUntil: 'load' });
await page.waitForSelector('#app[aria-busy="false"]');
check('la progression survit au rechargement', await page.locator('#map .pin.is-done').count() === 1);

console.log('\n— Changement de ville —');
await page.locator('.city-tab[data-city="montpellier"]').click();
await page.waitForFunction(() => document.querySelector('.map-city-name').textContent === 'Montpellier');
check('Montpellier : 85 lieux', await page.locator('#map .pin').count() === 85, String(await page.locator('#map .pin').count()));
check('Montpellier : 7 quartiers', await page.locator('#map .zone').count() === 7);
check('sous-quartiers étiquetés', (await page.locator('#map .sub-label').count()) === 17);
check('Montpellier repart de zéro', await page.locator('#map .pin.is-done').count() === 0);

console.log('\n— Zoom et déplacement —');
const before = await page.locator('#map .scene').getAttribute('transform');
await page.locator('#btn-zoom-in').click();
await page.waitForTimeout(420);
const after = await page.locator('#map .scene').getAttribute('transform');
check('le zoom modifie la transformation', before !== after, `${before} → ${after}`);
await page.locator('#btn-zoom-reset').click();
await page.waitForTimeout(420);
check('le recentrage revient à l’échelle 1', /scale\(1\)/.test(await page.locator('#map .scene').getAttribute('transform')));

console.log('\n— Lieu posé à la main —');
await page.locator('.city-tab[data-city="montpellier"]').click();
await page.waitForFunction(() => document.querySelector('.map-city-name').textContent === 'Montpellier');
await page.locator('#btn-add-spot').click();
check('le mode « poser un lieu » s’annonce', await page.locator('#add-hint').isVisible());
const box = await page.locator('#map').boundingBox();
await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
await page.waitForSelector('#sheet:not([hidden])');
check('l’indication disparaît après la pose', await page.locator('#add-hint').isHidden());
check('une épingle personnelle est née', await page.locator('#map .pin.is-custom').count() === 1);
await page.fill('#sheet .custom-name', 'Le muret derrière la gare');
await page.waitForTimeout(550);
check('le nom est enregistré', (await page.locator('#map .pin.is-custom').getAttribute('aria-label')) === 'Le muret derrière la gare');
const customGroup = await page.locator('.group', { hasText: 'Mes lieux' }).count();
check('le lieu apparaît sous « Mes lieux »', customGroup === 1);
const geo = await page.locator('#sheet .hint').first().textContent();
check('les coordonnées sont plausibles à Montpellier', /Posé à 43\.\d+, 3\.\d+/.test(geo), geo);
await page.locator('.done-toggle').click();
await page.waitForSelector('.done-toggle.is-on');
await page.locator('.side-tab[data-tab="progress"]').click();
const customLine = await page.locator('.prog-sub', { hasText: 'lieu à toi' }).textContent();
check('les lieux perso sont comptés hors pourcentage', /1\/1 lieu à toi/.test(customLine), customLine);
check('le pourcentage de la ville reste à 0', (await page.locator('[data-pct-for="montpellier"]').textContent()).trim() === '0 %');
await page.locator('.side-tab[data-tab="lieux"]').click();

console.log('\n— Au hasard —');
await page.locator('#btn-random').click();
await page.waitForSelector('#sheet:not([hidden])');
check('un lieu au hasard est sélectionné', (await page.locator('.sheet-title').textContent()).length > 0);
await page.locator('.sheet-close').click();

console.log('\n— Persistance du lieu posé —');
await page.reload({ waitUntil: 'load' });
await page.waitForSelector('#app[aria-busy="false"]');
await page.locator('.city-tab[data-city="montpellier"]').click();
await page.waitForFunction(() => document.querySelector('.map-city-name').textContent === 'Montpellier');
check('le lieu posé survit au rechargement', await page.locator('#map .pin.is-custom.is-done').count() === 1);

console.log('\n— Import de la photothèque —');
const fixtures = ['comedie-1.jpg', 'comedie-2.jpg', 'comedie-3.jpg', 'ailleurs-1.jpg', 'ailleurs-2.jpg', 'sans-gps.jpg']
  .map((n) => new URL(`fixtures/${n}`, import.meta.url).pathname);
await page.locator('#btn-import').click();
await page.waitForSelector('#modal[open]');
await page.setInputFiles('#modal input[type="file"]', fixtures);
await page.waitForSelector('.import-list', { timeout: 20000 });
const rows = await page.locator('.import-row').count();
check('deux groupes proposés', rows === 2, `${rows} groupes`);
const statusTxt = await page.locator('.import-status').textContent();
check('la place de la Comédie est reconnue', (await page.locator('.import-row', { hasText: 'Place de la Comédie' }).count()) === 1);
check('un nouveau lieu est proposé pour les photos isolées', (await page.locator('.import-row.is-new').count()) === 1);
check('la photo sans GPS est signalée et ignorée', /1 sans position GPS/.test(statusTxt), statusTxt);
await page.locator('#modal .btn-primary', { hasText: 'Enregistrer' }).click();
await page.waitForFunction(() => !document.getElementById('modal').open, null, { timeout: 30000 });
await page.waitForTimeout(400);
check('la Comédie est passée en photographiée', await page.locator('.spot-row.is-done', { hasText: 'Place de la Comédie' }).count() === 1);
check('un second lieu personnel a été créé', await page.locator('#map .pin.is-custom').count() === 2, String(await page.locator('#map .pin.is-custom').count()));
await page.locator('.spot-row', { hasText: 'Place de la Comédie' }).click();
await page.waitForSelector('#sheet:not([hidden])');
check('les trois photos sont attachées', await page.locator('.photo-grid .photo').count() === 3, String(await page.locator('.photo-grid .photo').count()));
check('la date retenue est la plus ancienne des trois', (await page.locator('#sheet input[type="date"]').inputValue()) === '2025-11-02', await page.locator('#sheet input[type="date"]').inputValue());
await page.locator('.sheet-close').click();

console.log('\n— Lien de partage —');
await page.locator('.city-tab[data-city="paris"]').click();
await page.waitForFunction(() => document.querySelector('.map-city-name').textContent === 'Paris');
await page.locator('#btn-share').click();
await page.waitForSelector('#modal[open]');
await page.fill('.modal-inner .field input[type="text"]', 'Souad');
await page.waitForTimeout(500);
const link = await page.locator('.link-out').inputValue();
check('le lien est bien formé', /#p=cw1[dr]\./.test(link), link.slice(0, 60));
check('le lien reste court', link.length < 900, `${link.length} caractères`);
await page.locator('.modal-close').click();

const page2 = await newPage(await browser.newContext({ viewport: { width: 1440, height: 900 } }));
await page2.goto(link, { waitUntil: 'load' });
await page2.waitForSelector('#app[aria-busy="false"]');
check('la carte partagée s’ouvre en lecture seule', !(await page2.locator('#shared-banner').isHidden()));
check('la carte partagée nomme son auteur', (await page2.locator('.shared-banner-text').textContent()).includes('Souad'));
check('la carte partagée montre le lieu coché', await page2.locator('#map .pin.is-done').count() === 1);
await page2.locator('#map .pin.is-done').dispatchEvent('click');
await page2.waitForSelector('#sheet:not([hidden])');
check('la fiche partagée est en lecture seule', await page2.locator('.done-toggle').count() === 0);
check('le lieu partagé est le bon', (await page2.locator('.sheet-title').textContent()) === spotName);
await page2.locator('#btn-merge-shared').click();
await page2.waitForFunction(() => document.getElementById('shared-banner').hidden);
check('la fusion recopie la progression', await page2.locator('#map .pin.is-done').count() === 1);
await page2.locator('.city-tab[data-city="montpellier"]').click();
await page2.waitForFunction(() => document.querySelector('.map-city-name').textContent === 'Montpellier');
check('le lieu posé n’a pas fui vers l’autre ville', await page2.locator('#map .pin.is-custom').count() === 0);

console.log('\n— Fond détaillé et couches —');
const t = await newPage(await browser.newContext({ viewport: { width: 1200, height: 800 } }));
await t.addInitScript(() => {
  window.CW_TILE_SOURCES = {
    light: { url: (z, x, y) => `faketiles/${z}/${x}/${y}.png`, credit: 'tuiles de test' },
    dark: { url: (z, x, y) => `faketiles/${z}/${x}/${y}.png`, credit: 'tuiles de test' },
  };
});
await t.goto(base, { waitUntil: 'load' });
await t.waitForSelector('#app[aria-busy="false"]');
check('aucune tuile avant activation', await t.locator('#map .tile').count() === 0);
await t.locator('#btn-tiles').click();
await t.waitForTimeout(600);
const tileCount = await t.locator('#map .tile').count();
check('les tuiles sont posées', tileCount > 0 && tileCount <= 260, `${tileCount} tuiles`);
check('la carte signale son fond', await t.locator('#map.has-tiles').count() === 1);
check('le crédit des données est affiché', (await t.locator('#map-credit').textContent()).includes('test'));
const tileGeo = await t.evaluate(() => {
  const app = window.CityWalker;
  const spot = app.city.spots.find((s) => s.id === 'tour-eiffel');
  const layer = app.map.tiles;
  for (const [key, node] of layer.nodes) {
    const x = parseFloat(node.getAttribute('x')), y = parseFloat(node.getAttribute('y'));
    const w = parseFloat(node.getAttribute('width')), h = parseFloat(node.getAttribute('height'));
    if (spot.x >= x && spot.x <= x + w && spot.y >= y && spot.y <= y + h) {
      const [z, i, j] = key.split('/').map(Number);
      // Tuile attendue pour cette latitude et cette longitude, formule slippy map.
      const n = 2 ** z;
      const ei = Math.floor(((spot.lon + 180) / 360) * n);
      const lat = (spot.lat * Math.PI) / 180;
      const ej = Math.floor(((1 - Math.log(Math.tan(lat) + 1 / Math.cos(lat)) / Math.PI) / 2) * n);
      return { z, i, j, ei, ej };
    }
  }
  return null;
});
check('la tuile sous la Tour Eiffel est la bonne', tileGeo && tileGeo.i === tileGeo.ei && tileGeo.j === tileGeo.ej, JSON.stringify(tileGeo));
await t.locator('#btn-tiles').click();
await t.waitForTimeout(200);
check('la désactivation retire les tuiles', await t.locator('#map .tile:visible').count() === 0);

await t.locator('.layer-chip[data-pins="mine"]').click();
await t.waitForTimeout(200);
check('la couche « mes lieux » n’affiche que les lieux posés', await t.locator('#map .pin:not(.is-dim)').count() === 0);
await t.locator('.layer-chip[data-pins="curated"]').click();
await t.waitForTimeout(200);
check('la couche « touristiques » affiche les 155 lieux', await t.locator('#map .pin:not(.is-dim)').count() === 155);
await t.locator('.layer-chip[data-pins="tous"]').click();
await t.waitForTimeout(200);
check('la couche « tout » revient à l’ensemble', await t.locator('.spot-row').count() === 155);

console.log('\n— Accessibilité de base —');
check('la carte est focusable au clavier', await page.locator('#map[tabindex="0"]').count() === 1);
check('les onglets ville portent aria-pressed', await page.locator('.city-tab[aria-pressed]').count() === 2);

console.log('\n— Console —');
const allErrors = [...page.errors, ...page2.errors, ...t.errors];
check('aucune erreur console ni exception', allErrors.length === 0, allErrors.join(' | '));

await browser.close();
server.close();

console.log(`\n${passed} vérifications passées, ${failures.length} échec(s).`);
if (failures.length) { failures.forEach((f) => console.log('  ✗ ' + f)); process.exit(1); }
