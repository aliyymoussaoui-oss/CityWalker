/**
 * Comptes et synchronisation, de bout en bout.
 *
 *   node tests/cloud.mjs
 *
 * Un serveur imite les points d'entrée Supabase réellement utilisés par
 * assets/js/cloud.js (auth, REST, stockage). Deux navigateurs distincts jouent
 * deux appareils : le premier crée un compte et envoie sa carte, le second se
 * connecte et doit la retrouver, photo comprise.
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CHROME = process.env.CW_CHROME
  || (existsSync('/opt/pw-browsers/chromium-1194/chrome-linux/chrome') ? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' : undefined);
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8' };

let passed = 0;
const failures = [];
const check = (name, cond, detail) => {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failures.push(`${name}${detail ? ' — ' + detail : ''}`); console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
};

// ------------------------------------------------------------ site statique

function serveSite() {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      try {
        const url = decodeURIComponent((req.url || '/').split('?')[0]);
        const file = join(ROOT, normalize(url === '/' ? '/index.html' : url));
        if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
        await stat(file);
        res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
        res.end(await readFile(file));
      } catch { res.writeHead(404).end(); }
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

// -------------------------------------------------- imitation de Supabase

function serveApi() {
  const users = new Map();      // email -> {id, password}
  const tokens = new Map();     // access token -> userId
  const refresh = new Map();    // refresh token -> userId
  const progress = new Map();   // `${uid}|${city}` -> {data, updated_at}
  const photos = new Map();     // `${uid}|${id}` -> row
  const blobs = new Map();      // path -> Buffer
  let seq = 0;

  const CORS = {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': '*',
    'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'access-control-expose-headers': '*',
  };

  const body = (req) => new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });

  function issue(userId, email) {
    const access = `at${++seq}`;
    const refreshToken = `rt${seq}`;
    tokens.set(access, userId);
    refresh.set(refreshToken, userId);
    return { access_token: access, refresh_token: refreshToken, expires_in: 3600, user: { id: userId, email } };
  }
  const userOf = (req) => {
    const h = req.headers.authorization || '';
    return tokens.get(h.replace(/^Bearer\s+/i, '')) || null;
  };
  const json = (res, code, value) => {
    res.writeHead(code, Object.assign({ 'content-type': 'application/json' }, CORS));
    res.end(JSON.stringify(value));
  };

  const server = createServer(async (req, res) => {
    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }
    const url = new URL(req.url, 'http://x');
    const path = url.pathname;

    if (path === '/auth/v1/signup') {
      const { email, password } = JSON.parse((await body(req)).toString() || '{}');
      if (users.has(email)) return json(res, 400, { msg: 'User already registered' });
      const id = `u${++seq}`;
      users.set(email, { id, password });
      return json(res, 200, issue(id, email));
    }
    if (path === '/auth/v1/token') {
      const payload = JSON.parse((await body(req)).toString() || '{}');
      if (url.searchParams.get('grant_type') === 'refresh_token') {
        const uid = refresh.get(payload.refresh_token);
        if (!uid) return json(res, 400, { msg: 'Invalid refresh token' });
        const email = [...users.entries()].find(([, u]) => u.id === uid)[0];
        return json(res, 200, issue(uid, email));
      }
      const user = users.get(payload.email);
      if (!user || user.password !== payload.password) return json(res, 400, { msg: 'Invalid login credentials' });
      return json(res, 200, issue(user.id, payload.email));
    }
    if (path === '/auth/v1/logout') { res.writeHead(204, CORS); res.end(); return; }

    const uid = userOf(req);
    if (!uid) return json(res, 401, { msg: 'Unauthorized' });

    if (path === '/rest/v1/progress') {
      if (req.method === 'GET') {
        const city = (url.searchParams.get('city') || '').replace(/^eq\./, '');
        const row = progress.get(`${uid}|${city}`);
        return json(res, 200, row ? [row] : []);
      }
      for (const row of JSON.parse((await body(req)).toString() || '[]')) {
        progress.set(`${uid}|${row.city}`, { data: row.data, updated_at: row.updated_at });
      }
      res.writeHead(201, CORS); res.end(); return;
    }

    if (path === '/rest/v1/photos') {
      if (req.method === 'GET') {
        return json(res, 200, [...photos.entries()].filter(([k]) => k.startsWith(`${uid}|`)).map(([, v]) => v));
      }
      for (const row of JSON.parse((await body(req)).toString() || '[]')) photos.set(`${uid}|${row.id}`, row);
      res.writeHead(201, CORS); res.end(); return;
    }

    const m = /^\/storage\/v1\/object\/photos\/(.+)$/.exec(path);
    if (m) {
      if (req.method === 'GET') {
        const buf = blobs.get(m[1]);
        if (!buf) return json(res, 404, { msg: 'Not found' });
        res.writeHead(200, Object.assign({ 'content-type': 'image/jpeg' }, CORS));
        res.end(buf);
        return;
      }
      blobs.set(m[1], await body(req));
      return json(res, 200, { Key: m[1] });
    }

    return json(res, 404, { msg: `no route ${path}` });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, state: { users, progress, photos, blobs } }));
  });
}

// ---------------------------------------------------------------- scénario

const site = await serveSite();
const api = await serveApi();
const base = `http://127.0.0.1:${site.port}/`;
const apiUrl = `http://127.0.0.1:${api.port}`;
const browser = await chromium.launch({ executablePath: CHROME });
const errors = [];
// Le refus de connexion attendu produit un 400 que le navigateur journalise :
// on cesse de compter les erreurs pendant cette étape volontaire.
let collectErrors = true;

async function open() {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error' && collectErrors) errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(base, { waitUntil: 'load' });
  await page.waitForSelector('#app[aria-busy="false"]');
  return page;
}

async function configure(page) {
  await page.locator('#btn-settings').click();
  await page.waitForSelector('#modal[open]');
  await page.locator('.account input[type="url"]').fill(apiUrl);
  await page.locator('.account input[type="text"]').fill('cle-anon-de-test-suffisamment-longue');
  await page.locator('.account button', { hasText: 'Enregistrer la configuration' }).click();
  await page.waitForSelector('.account input[type="email"]');
}

const CREDS = { email: 'souad@example.test', password: 'motdepasse123' };

console.log('\n— Appareil 1 : création du compte —');
const a = await open();
await configure(a);
check('le formulaire de compte apparaît une fois configuré', await a.locator('.account input[type="email"]').count() === 1);
await a.locator('.account input[type="email"]').fill(CREDS.email);
await a.locator('.account input[type="password"]').fill(CREDS.password);
await a.locator('.account button', { hasText: 'Créer un compte' }).click();
await a.waitForSelector('.account-who', { timeout: 15000 });
check('le compte est créé et connecté', (await a.locator('.account-who').textContent()).includes(CREDS.email));
await a.locator('.modal-close').click();

console.log('\n— Appareil 1 : une carte à envoyer —');
await a.locator('.spot-row').first().click();
await a.waitForSelector('#sheet:not([hidden])');
const spotName = await a.locator('.sheet-title').textContent();
await a.locator('.done-toggle').click();
await a.waitForSelector('.done-toggle.is-on');
await a.locator('.tag-row .tag-chip').nth(2).click();
await a.waitForTimeout(150);
await a.setInputFiles('#photo-input', [`${ROOT}tests/fixtures/comedie-1.jpg`]);
await a.waitForTimeout(2500);
check('une photo est enregistrée localement', await a.locator('.photo-grid .photo').count() === 1);
await a.locator('.sheet-close').click();

await a.locator('#btn-settings').click();
await a.waitForSelector('#modal[open]');
await a.locator('.account button', { hasText: 'Synchroniser maintenant' }).click();
await a.waitForFunction(() => document.querySelector('.toast') && /Synchronisé/.test(document.querySelector('.toast').textContent), null, { timeout: 30000 });
const toastA = await a.locator('.toast').first().textContent();
check('la synchronisation annonce un envoi de photo', /1 photo envoyée/.test(toastA), toastA);
check('le serveur a reçu la progression des deux villes', api.state.progress.size === 2, String(api.state.progress.size));
check('le serveur a reçu le fichier image', api.state.blobs.size === 1, String(api.state.blobs.size));
await a.locator('.modal-close').click();

console.log('\n— Appareil 2 : on retrouve tout —');
const b = await open();
check('le second appareil part vierge', await b.locator('#map .pin.is-done').count() === 0);
await configure(b);
await b.locator('.account input[type="email"]').fill(CREDS.email);
await b.locator('.account input[type="password"]').fill(CREDS.password);
await b.locator('.account button', { hasText: 'Se connecter' }).click();
await b.waitForSelector('.account-who', { timeout: 15000 });
check('la connexion réussit avec les mêmes identifiants', (await b.locator('.account-who').textContent()).includes(CREDS.email));
await b.locator('.account button', { hasText: 'Synchroniser maintenant' }).click();
await b.waitForFunction(() => document.querySelector('.toast') && /Synchronisé/.test(document.querySelector('.toast').textContent), null, { timeout: 30000 });
const toastB = await b.locator('.toast').first().textContent();
check('la synchronisation annonce une photo reçue', /1 photo reçue/.test(toastB), toastB);
await b.locator('.modal-close').click();
check('le lieu coché est arrivé', await b.locator('#map .pin.is-done').count() === 1);
await b.locator('.spot-row.is-done').first().click();
await b.waitForSelector('#sheet:not([hidden])');
check('c’est bien le même lieu', (await b.locator('.sheet-title').textContent()) === spotName);
check('l’ambiance a suivi', await b.locator('.tag-row .tag-chip.is-on').count() === 1);
check('la photo a suivi', await b.locator('.photo-grid .photo').count() === 1);

console.log('\n— Mauvais mot de passe —');
collectErrors = false;
const c = await open();
await configure(c);
await c.locator('.account input[type="email"]').fill(CREDS.email);
await c.locator('.account input[type="password"]').fill('mauvaismotdepasse');
await c.locator('.account button', { hasText: 'Se connecter' }).click();
await c.waitForSelector('.toast-error', { timeout: 15000 });
check('le refus est expliqué en français', (await c.locator('.toast-error').textContent()).includes('incorrect'));

collectErrors = true;

console.log('\n— Console —');
check('aucune erreur console inattendue', errors.length === 0, errors.join(' | '));

await browser.close();
site.server.close();
api.server.close();

console.log(`\n${passed} vérifications passées, ${failures.length} échec(s).`);
if (failures.length) process.exit(1);
