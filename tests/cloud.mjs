/**
 * Comptes et synchronisation, de bout en bout.
 *
 *   node tests/cloud.mjs
 *
 * Le vrai serveur (server/, dans le moteur de Cloudflare via `wrangler dev`,
 * base D1 et stockage R2 locaux) face à de vrais navigateurs. Plusieurs
 * contextes jouent plusieurs appareils : le premier crée un compte et envoie sa
 * carte, le second la retrouve, photo comprise ; un troisième a oublié son mot
 * de passe et s'en sort avec la clé de secours.
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './api.mjs';

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

// ---------------------------------------------------------------- scénario

const site = await serveSite();
const api = await startServer({ port: 8792 });
const base = `http://127.0.0.1:${site.port}/`;
const browser = await chromium.launch({ executablePath: CHROME });
const errors = [];
// Les refus volontaires (mauvais mot de passe, session révoquée) produisent des
// 401 que le navigateur journalise : on cesse de les compter pendant ces étapes.
let collectErrors = true;

async function open(apiBase = api.base) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  // Le site publié reçoit l'adresse du serveur de son workflow ; ici, on sert
  // une configuration qui pointe vers le serveur local.
  await ctx.route('**/assets/js/config.js', (route) => route.fulfill({
    contentType: 'text/javascript',
    body: `window.CW_CONFIG = { apiUrl: ${JSON.stringify(apiBase)}, cartoKey: '' };`,
  }));
  const page = await ctx.newPage();
  // Les tuiles du fond détaillé ne sont pas joignables depuis la machine de
  // test : leurs échecs ne disent rien de la synchronisation.
  const tile = (u) => /basemaps\.cartocdn\.com/.test(u || '');
  page.on('console', (m) => { if (m.type() === 'error' && collectErrors && !tile(m.location().url)) errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('requestfailed', (r) => { if (collectErrors && !tile(r.url())) errors.push(`requête échouée ${r.method()} ${r.url()} ${r.failure() && r.failure().errorText}`); });
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#app[aria-busy="false"]');
  return page;
}

async function openAccount(page) {
  await page.locator('#btn-settings').click();
  await page.waitForSelector('#modal[open] .account');
}

async function toastText(page, re) {
  try {
    await page.waitForFunction((src) => [...document.querySelectorAll('.toast')].some((t) => new RegExp(src).test(t.textContent)), re.source, { timeout: 30000 });
  } catch (err) {
    const seen = await page.evaluate(() => ({
      toasts: [...document.querySelectorAll('.toast')].map((t) => t.textContent),
      account: (document.querySelector('.account') || {}).textContent || '(pas de section compte)',
      modal: document.querySelector('#modal').open,
    }));
    throw new Error(`Message attendu ${re} absent. État : ${JSON.stringify(seen)}`);
  }
  return page.evaluate((src) => [...document.querySelectorAll('.toast')].map((t) => t.textContent).find((x) => new RegExp(src).test(x)), re.source);
}

const CREDS = { email: 'souad@example.test', password: 'motdepasse123' };

try {
  console.log('\n— Appareil 1 : création du compte —');
  const a = await open();
  await openAccount(a);
  check('le formulaire de compte est là, sans rien à configurer', await a.locator('.account input[type="email"]').count() === 1);
  await a.locator('.account input[type="email"]').fill(CREDS.email);
  await a.locator('.account input[type="password"]').fill(CREDS.password);
  await a.locator('.account button', { hasText: 'Créer un compte' }).click();
  await a.waitForSelector('.recovery-code', { timeout: 20000 });
  const recovery = (await a.locator('.recovery-code').textContent()).trim();
  check('la clé de secours est affichée', /^([0-9A-HJKMNP-TV-Z]{5}-){4}[0-9A-HJKMNP-TV-Z]{5}$/.test(recovery), recovery);
  check('elle peut être téléchargée', await a.locator('.account button', { hasText: 'Télécharger' }).count() === 1);
  const stored = await a.evaluate(() => localStorage.getItem('citywalker:v2:session') || '');
  check('le mot de passe n’est stocké nulle part sur l’appareil', !stored.includes(CREDS.password) && stored.includes('token'));
  await a.locator('.account button', { hasText: 'C’est noté' }).click();
  await a.waitForSelector('.account-who');
  check('le compte est créé et connecté', (await a.locator('.account-who').textContent()).includes(CREDS.email));
  check('la clé de secours n’est plus affichée', await a.locator('.recovery-code').count() === 0);
  await a.waitForFunction(() => /Photos en ligne/.test(document.querySelector('.account-usage').textContent));
  check('l’espace photo en ligne est indiqué', /0 Ko sur 4 Go/.test(await a.locator('.account-usage').textContent()), await a.locator('.account-usage').textContent());
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
  await a.waitForFunction(() => document.querySelectorAll('.photo-grid .photo').length === 1, null, { timeout: 15000 });
  check('une photo est enregistrée localement', await a.locator('.photo-grid .photo').count() === 1);
  await a.locator('.sheet-close').click();

  await openAccount(a);
  await a.locator('.account button', { hasText: 'Synchroniser maintenant' }).click();
  const toastA = await toastText(a, /Synchronisé/);
  check('la synchronisation annonce un envoi de photo', /1 photo envoyée/.test(toastA), toastA);
  await a.locator('.modal-close').click();

  console.log('\n— Appareil 2 : on retrouve tout —');
  const b = await open();
  check('le second appareil part vierge', await b.locator('#map .pin.is-done').count() === 0);
  await openAccount(b);
  await b.locator('.account input[type="email"]').fill('  Souad@Example.test ');
  await b.locator('.account input[type="password"]').fill(CREDS.password);
  await b.locator('.account button', { hasText: 'Se connecter' }).click();
  await b.waitForSelector('.account-who', { timeout: 20000 });
  check('la connexion réussit, même avec majuscules et espaces', (await b.locator('.account-who').textContent()).includes(CREDS.email));
  await b.locator('.account button', { hasText: 'Synchroniser maintenant' }).click();
  const toastB = await toastText(b, /Synchronisé/);
  check('la synchronisation annonce une photo reçue', /1 photo reçue/.test(toastB), toastB);
  await b.locator('.modal-close').click();
  check('le lieu coché est arrivé', await b.locator('#map .pin.is-done').count() === 1);
  await b.locator('.spot-row.is-done').first().click();
  await b.waitForSelector('#sheet:not([hidden])');
  check('c’est bien le même lieu', (await b.locator('.sheet-title').textContent()) === spotName);
  check('l’ambiance a suivi', await b.locator('.tag-row .tag-chip.is-on').count() === 1);
  check('la photo a suivi', await b.locator('.photo-grid .photo').count() === 1);
  await b.locator('.sheet-close').click();

  console.log('\n— Mauvais mot de passe —');
  collectErrors = false;
  const c = await open();
  await openAccount(c);
  await c.locator('.account input[type="email"]').fill(CREDS.email);
  await c.locator('.account input[type="password"]').fill('mauvaismotdepasse');
  await c.locator('.account button', { hasText: 'Se connecter' }).click();
  const refus = await toastText(c, /incorrect/);
  check('le refus est expliqué en français', refus === 'Adresse ou mot de passe incorrect.', refus);

  console.log('\n— Mot de passe oublié : la clé de secours —');
  await c.locator('.account button', { hasText: 'Mot de passe oublié' }).click();
  await c.locator('.account input[type="email"]').fill(CREDS.email);
  await c.locator('.account input.recovery-input').fill(recovery.toLowerCase().replace(/-/g, ' '));
  await c.locator('.account input[type="password"]').fill('nouveau-mdp-2026');
  await c.locator('.account button', { hasText: 'Changer le mot de passe' }).click();
  await c.waitForSelector('.account-who', { timeout: 20000 });
  check('la clé, même en minuscules et espacée, donne un nouveau mot de passe', (await c.locator('.account-who').textContent()).includes(CREDS.email));

  await openAccount(b);
  const expire = await toastText(b, /reconnecte-toi/);
  check('l’ancien appareil est déconnecté, avec un message clair', /Session expirée/.test(expire), expire);
  await b.waitForSelector('.account input[type="email"]');
  check('et retrouve le formulaire de connexion', await b.locator('.account input[type="email"]').count() === 1);
  check('ses données locales sont intactes', await b.locator('#map .pin.is-done').count() === 1);

  console.log('\n— Deux onglets du même appareil —');
  // L'application installée et un onglet partagent le stockage : une
  // reconnexion dans l'un ne doit pas déconnecter l'autre.
  const c2 = await c.context().newPage();
  c2.on('pageerror', (e) => errors.push(e.message));
  await c2.goto(base, { waitUntil: 'domcontentloaded' });
  await c2.waitForSelector('#app[aria-busy="false"]');
  await c.locator('.account button', { hasText: 'Se déconnecter' }).click();
  await c.waitForSelector('.account input[type="email"]');
  await c.locator('.account input[type="email"]').fill(CREDS.email);
  await c.locator('.account input[type="password"]').fill('nouveau-mdp-2026');
  await c.locator('.account button', { hasText: 'Se connecter' }).click();
  await c.waitForSelector('.account-who', { timeout: 20000 });
  const fresh = await c.evaluate(() => JSON.parse(localStorage.getItem('citywalker:v2:session')).token);
  await openAccount(c2);
  await c2.waitForSelector('.account-who');
  await c2.waitForFunction(() => /Photos en ligne/.test(document.querySelector('.account-usage').textContent), null, { timeout: 15000 });
  const still = await c2.evaluate(() => (JSON.parse(localStorage.getItem('citywalker:v2:session') || 'null') || {}).token);
  check('l’autre onglet suit la nouvelle session au lieu de l’effacer', still === fresh);
  await c2.close();

  console.log('\n— Nouvelle clé de secours —');
  await c.locator('.account button', { hasText: 'Nouvelle clé de secours' }).click();
  await c.locator('.account-danger input[type="password"]').fill('nouveau-mdp-2026');
  await c.locator('.account button', { hasText: 'Créer la nouvelle clé' }).click();
  await c.waitForSelector('.recovery-code', { timeout: 20000 });
  const recovery2 = (await c.locator('.recovery-code').textContent()).trim();
  check('le mot de passe est redemandé, puis la nouvelle clé s’affiche', recovery2 !== recovery && /^([0-9A-HJKMNP-TV-Z]{5}-){4}[0-9A-HJKMNP-TV-Z]{5}$/.test(recovery2));
  await c.locator('.account button', { hasText: 'C’est noté' }).click();
  await c.waitForSelector('.account-who');

  console.log('\n— Session révoquée pendant qu’on regarde —');
  const tokenC = await c.evaluate(() => JSON.parse(localStorage.getItem('citywalker:v2:session')).token);
  await fetch(`${api.base}/v1/auth/logout`, { method: 'POST', headers: { authorization: `Bearer ${tokenC}` } });
  await c.locator('.account button', { hasText: 'Nouvelle clé de secours' }).click();
  await c.locator('.account-danger input[type="password"]').fill('nouveau-mdp-2026');
  await c.locator('.account button', { hasText: 'Créer la nouvelle clé' }).click();
  await c.waitForSelector('.account input[type="email"]', { timeout: 20000 });
  check('pas de boutons morts : retour au formulaire de connexion', await c.locator('.account-who').count() === 0);
  await c.locator('.account input[type="email"]').fill(CREDS.email);
  await c.locator('.account input[type="password"]').fill('nouveau-mdp-2026');
  await c.locator('.account button', { hasText: 'Se connecter' }).click();
  await c.waitForSelector('.account-who', { timeout: 20000 });

  console.log('\n— Suppression du compte —');
  await c.locator('.account button', { hasText: 'Supprimer mon compte' }).click();
  await c.locator('.account-danger input[type="password"]').fill('motdepasse123');
  await c.locator('.account button', { hasText: 'Supprimer définitivement' }).click();
  await c.waitForFunction(() => [...document.querySelectorAll('.toast-error')].some((t) => /incorrect/.test(t.textContent)), null, { timeout: 20000 });
  check('un mauvais mot de passe ne supprime rien et ne déconnecte pas', await c.locator('.account-who').count() === 1);
  await c.locator('.account-danger input[type="password"]').fill('nouveau-mdp-2026');
  await c.locator('.account button', { hasText: 'Supprimer définitivement' }).click();
  await c.waitForSelector('.account input[type="email"]', { timeout: 20000 });
  check('le compte est supprimé et l’appareil déconnecté', await c.locator('.account-who').count() === 0);
  const gone = await fetch(`${api.base}/v1/health`).then((r) => r.ok);
  check('le serveur tourne toujours', gone);
  collectErrors = true;

  console.log('\n— Envois bloqués : on reçoit quand même —');
  // Un envoi refusé (ici le plafond quotidien, réglé à 1) ne doit jamais
  // empêcher de recevoir les photos des autres appareils.
  const tight = await startServer({ port: 8793, vars: { UPLOADS_PER_USER_PER_DAY: 1 } });
  collectErrors = false;   // le 429 volontaire est journalisé par le navigateur
  try {
    const t1 = await open(tight.base);
    await openAccount(t1);
    await t1.locator('.account input[type="email"]').fill('quota@example.test');
    await t1.locator('.account input[type="password"]').fill(CREDS.password);
    await t1.locator('.account button', { hasText: 'Créer un compte' }).click();
    await t1.waitForSelector('.recovery-code', { timeout: 20000 });
    await t1.locator('.account button', { hasText: 'C’est noté' }).click();
    await t1.locator('.modal-close').click();
    await t1.locator('.spot-row').first().click();
    await t1.setInputFiles('#photo-input', [`${ROOT}tests/fixtures/comedie-1.jpg`]);
    await t1.waitForFunction(() => document.querySelectorAll('.photo-grid .photo').length === 1, null, { timeout: 15000 });
    await t1.locator('.sheet-close').click();
    await openAccount(t1);
    await t1.locator('.account button', { hasText: 'Synchroniser maintenant' }).click();
    check('le premier appareil envoie sa photo', /1 photo envoyée/.test(await toastText(t1, /Synchronisé/)));

    const t2 = await open(tight.base);
    await t2.locator('.spot-row').nth(1).click();
    await t2.setInputFiles('#photo-input', [`${ROOT}tests/fixtures/comedie-2.jpg`]);
    await t2.waitForFunction(() => document.querySelectorAll('.photo-grid .photo').length === 1, null, { timeout: 15000 });
    await t2.locator('.sheet-close').click();
    await openAccount(t2);
    await t2.locator('.account input[type="email"]').fill('quota@example.test');
    await t2.locator('.account input[type="password"]').fill(CREDS.password);
    await t2.locator('.account button', { hasText: 'Se connecter' }).click();
    await t2.waitForSelector('.account-who', { timeout: 20000 });
    await t2.locator('.account button', { hasText: 'Synchroniser maintenant' }).click();
    const tt = await toastText(t2, /Synchronisé/);
    check('le second appareil reçoit la photo du premier malgré son envoi refusé', /1 photo reçue/.test(tt) && /0 photo envoyée/.test(tt), tt);
    check('et le refus est expliqué', /aujourd’hui/.test(tt), tt);
  } finally {
    collectErrors = true;
    await tight.stop();
  }

  console.log('\n— Console —');
  check('aucune erreur console inattendue', errors.length === 0, errors.join(' | '));
} finally {
  await browser.close();
  site.server.close();
  await api.stop();
}

console.log(`\n${passed} vérifications passées, ${failures.length} échec(s).`);
if (failures.length) process.exit(1);
