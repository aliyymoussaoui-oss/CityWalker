/** Vérifie que dist/citywalker.html fonctionne seul, y compris en file://. */
import { chromium } from 'playwright';
import { pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
// Chemin relatif au dépôt : le test doit tourner ailleurs que sur ma machine.
const file = new URL('../dist/citywalker.html', import.meta.url).href;
const b = await chromium.launch({ executablePath: process.env.CW_CHROME || (existsSync('/opt/pw-browsers/chromium-1194/chrome-linux/chrome') ? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' : undefined) });
const p = await (await b.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
const errs = [];
p.on('console', m => m.type() === 'error' && errs.push(m.text()));
p.on('pageerror', e => errs.push(e.message));
p.on('requestfailed', r => { if (!/basemaps\.cartocdn\.com/.test(r.url())) errs.push('req ' + r.url()); });
// `load` attendrait les tuiles ; l'application démarre sur DOMContentLoaded.
await p.goto(file, { waitUntil: 'domcontentloaded' });
await p.waitForSelector('#app[aria-busy="false"]', { timeout: 20000 });
const pins = await p.locator('#map .pin').count();
await p.locator('.spot-row').first().click();
await p.waitForSelector('#sheet:not([hidden])');
await p.locator('.done-toggle').click();
await p.waitForSelector('.done-toggle.is-on');
await p.locator('.city-tab[data-city="montpellier"]').click();
await p.waitForFunction(() => document.querySelector('.map-city-name').textContent === 'Montpellier');
const mtp = await p.locator('#map .pin').count();
await p.locator('.city-tab[data-city="paris"]').click();
await p.waitForFunction(() => document.querySelector('.map-city-name').textContent === 'Paris');
await p.locator('#btn-share').click();
await p.waitForSelector('#modal[open]');
await p.waitForTimeout(600);
const link = await p.locator('.link-out').inputValue();
await b.close();
const ok = pins === 161 && mtp === 89 && /#p=cw1[dr]\./.test(link) && errs.length === 0;
console.log(`file:// → Paris ${pins} épingles, Montpellier ${mtp}, lien ${/#p=/.test(link) ? 'ok' : 'KO'}, erreurs ${errs.length}`);
if (errs.length) console.log(errs.join('\n'));
process.exit(ok ? 0 : 1);
