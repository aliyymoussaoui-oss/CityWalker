/**
 * Serveur de synchronisation, testé pour de vrai : `wrangler dev` fait tourner
 * le Worker dans le moteur de Cloudflare (workerd), avec une base D1 et un
 * stockage R2 locaux. Aucun compte, aucun réseau.
 *
 *   node tests/api.mjs
 */
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { webcrypto as crypto } from 'node:crypto';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SERVER = join(ROOT, 'server');
const WRANGLER = join(ROOT, 'node_modules', '.bin', 'wrangler');

let passed = 0;
const failures = [];
const check = (name, cond, detail) => {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failures.push(name); console.log(`  ✗ ${name}${detail !== undefined ? ' — ' + detail : ''}`); }
};

/** Démarre un Worker local ; `vars` abaisse les plafonds pour les tester vite. */
export async function startServer({ port, vars = {}, photos = true } = {}) {
  const state = mkdtempSync(join(tmpdir(), 'cw-api-'));
  const args = ['--config', join(SERVER, photos ? 'wrangler.toml' : 'wrangler.nophotos.toml')];
  execFileSync(WRANGLER, ['d1', 'migrations', 'apply', 'citywalker', '--local', '--persist-to', state, ...args],
    { cwd: SERVER, stdio: 'pipe', env: { ...process.env, CI: '1' } });
  const varArgs = Object.entries(vars).flatMap(([k, v]) => ['--var', `${k}:${v}`]);
  const child = spawn(WRANGLER, ['dev', ...args, '--port', String(port), '--ip', '127.0.0.1',
    '--persist-to', state, '--test-scheduled', ...varArgs],
  { cwd: SERVER, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CI: '1' } });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(`${base}/v1/health`); if (r.ok) break; } catch (_) { /* pas encore prêt */ }
    await new Promise((r) => setTimeout(r, 500));
    if (i === 119) throw new Error(`Le serveur local ne démarre pas :\n${log}`);
  }
  return {
    base,
    log: () => log,
    stop: async () => {
      child.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 300));
      rmSync(state, { recursive: true, force: true });
    },
  };
}

// La même dérivation que le navigateur (assets/js/cloud.js).
async function deriveKey(email, password) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({
    name: 'PBKDF2', hash: 'SHA-256', iterations: 600000,
    salt: new TextEncoder().encode(`citywalker/v1/${email.trim().toLowerCase()}`),
  }, base, 256);
  return Buffer.from(bits).toString('base64url');
}

const RECOVERY = 'ABCDE-FGHJK-MNPQR-STVWX-YZ012';

async function main() {
  const srv = await startServer({ port: 8790, vars: { SIGNUPS_PER_IP: 6, LOGIN_ATTEMPTS_PER_ACCOUNT_IP: 3, MAX_USER_BYTES: 11000, UPLOADS_PER_USER_PER_DAY: 50 } });
  const B = srv.base;
  const call = async (method, path, { token, body, raw, type } = {}) => {
    const headers = {};
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (raw !== undefined) headers['content-type'] = type || 'image/jpeg';
    const res = await fetch(B + path, { method, headers, body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined });
    const ct = res.headers.get('content-type') || '';
    const data = ct.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer());
    return { status: res.status, data, headers: res.headers };
  };

  try {
    console.log('\n— Santé et CORS —');
    let r = await call('GET', '/v1/health');
    check('le serveur répond et voit sa base', r.status === 200 && r.data.ok === true && r.data.photos === true, JSON.stringify(r.data));
    const pre = await fetch(B + '/v1/me', { method: 'OPTIONS', headers: { origin: 'null', 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization' } });
    check('le préflight CORS est accepté, même depuis file:// (origine null)',
      pre.status === 204 && pre.headers.get('access-control-allow-origin') === '*' && /authorization/.test(pre.headers.get('access-control-allow-headers')));
    check('les réponses portent l’en-tête CORS', r.headers.get('access-control-allow-origin') === '*');

    console.log('\n— Création de compte —');
    const email = 'Souad@Example.test ';
    const key = await deriveKey(email, 'motdepasse123');
    r = await call('POST', '/v1/auth/signup', { body: { email, key, recovery: RECOVERY } });
    check('le compte est créé', r.status === 201 && /^[A-Za-z0-9_-]{43}$/.test(r.data.token), JSON.stringify(r.data));
    check('l’adresse est normalisée', r.data.user && r.data.user.email === 'souad@example.test');
    const tokenA = r.data.token;
    r = await call('POST', '/v1/auth/signup', { body: { email: 'souad@example.test', key, recovery: RECOVERY } });
    check('une adresse déjà prise est refusée', r.status === 409 && r.data.error === 'email_taken');
    r = await call('POST', '/v1/auth/signup', { body: { email: 'pas-une-adresse', key, recovery: RECOVERY } });
    check('une adresse invalide est refusée', r.status === 400 && r.data.error === 'bad_email');
    r = await call('POST', '/v1/auth/signup', { body: { email: 'x@y.fr', key: 'court', recovery: RECOVERY } });
    check('une clé mal formée est refusée', r.status === 400 && r.data.error === 'bad_key');
    r = await call('POST', '/v1/auth/signup', { body: { email: 'x@y.fr', key, recovery: 'trop-court' } });
    check('une clé de secours mal formée est refusée', r.status === 400 && r.data.error === 'bad_recovery');
    const raw = await fetch(B + '/v1/auth/signup', { method: 'POST', body: 'pas du json' });
    check('un corps illisible est refusé proprement', raw.status === 400);

    console.log('\n— Connexion —');
    r = await call('POST', '/v1/auth/login', { body: { email: 'souad@example.test', key } });
    check('la connexion réussit', r.status === 200 && r.data.token && r.data.token !== tokenA);
    const tokenA2 = r.data.token;
    const wrong = await deriveKey(email, 'mauvais-mdp');
    r = await call('POST', '/v1/auth/login', { body: { email: 'souad@example.test', key: wrong } });
    check('un mauvais mot de passe est refusé', r.status === 401 && r.data.error === 'invalid_credentials');
    r = await call('POST', '/v1/auth/login', { body: { email: 'personne@example.test', key } });
    check('un compte inconnu reçoit la même réponse', r.status === 401 && r.data.error === 'invalid_credentials');
    r = await call('GET', '/v1/me', { token: tokenA });
    check('la session donne accès au compte', r.status === 200 && r.data.user.email === 'souad@example.test' && r.data.photos === true);
    r = await call('GET', '/v1/me', { token: 'A'.repeat(43) });
    check('un faux jeton est refusé', r.status === 401 && r.data.error === 'unauthorized');
    r = await call('GET', '/v1/me');
    check('sans jeton, rien', r.status === 401);

    console.log('\n— Progression —');
    r = await call('GET', '/v1/progress/paris', { token: tokenA });
    check('une ville jamais envoyée revient vide', r.status === 200 && r.data.data === null && r.data.updatedAt === 0);
    const prog = { city: 'paris', owner: 'Souad', spots: { 'tour-eiffel': { done: true, tags: ['sunset'], photos: [] } }, custom: [] };
    r = await call('PUT', '/v1/progress/paris', { token: tokenA, body: { data: prog } });
    check('la progression est enregistrée', r.status === 200);
    r = await call('GET', '/v1/progress/paris', { token: tokenA2 });
    check('et relue à l’identique depuis une autre session', r.status === 200 && JSON.stringify(r.data.data) === JSON.stringify(prog) && r.data.updatedAt > 0);
    r = await call('PUT', '/v1/progress/Paris!', { token: tokenA, body: { data: prog } });
    check('un nom de ville invalide est refusé', r.status === 400);
    r = await call('PUT', '/v1/progress/paris', { token: tokenA, body: { data: [1, 2] } });
    check('une progression qui n’est pas un objet est refusée', r.status === 400);
    r = await call('PUT', '/v1/progress/paris', { token: tokenA, body: { data: { big: 'x'.repeat(1_100_000) } } });
    check('une progression démesurée est refusée', r.status === 413);

    console.log('\n— Photos —');
    const jpeg = readFileSync(join(ROOT, 'tests', 'fixtures', 'comedie-1.jpg'));
    r = await call('PUT', '/v1/photos/abc123?city=paris&spot=tour-eiffel&w=1600&h=1200&takenAt=2026-09-01&createdAt=1700000000000', { token: tokenA, raw: jpeg });
    check('une photo est envoyée', r.status === 200, JSON.stringify(r.data));
    r = await call('GET', '/v1/photos', { token: tokenA });
    check('elle apparaît dans la liste avec sa description',
      r.status === 200 && r.data.photos.length === 1 && r.data.photos[0].id === 'abc123' && r.data.photos[0].spot === 'tour-eiffel'
      && r.data.photos[0].w === 1600 && r.data.photos[0].size === jpeg.length && r.data.next === null, JSON.stringify(r.data));
    r = await call('GET', '/v1/photos/abc123', { token: tokenA });
    check('elle revient octet pour octet', r.status === 200 && Buffer.compare(r.data, jpeg) === 0 && r.headers.get('content-type') === 'image/jpeg');
    r = await call('PUT', '/v1/photos/evil?city=paris&spot=x', { token: tokenA, raw: Buffer.from('<script>alert(1)</script>'), type: 'image/jpeg' });
    check('un fichier qui n’est pas une image est refusé', r.status === 415 && r.data.error === 'not_an_image');
    r = await call('PUT', '/v1/photos/bad%2Fid?city=paris&spot=x', { token: tokenA, raw: jpeg });
    check('un identifiant de photo invalide est refusé', r.status === 400);
    r = await call('PUT', '/v1/photos/x1?city=PARIS&spot=x', { token: tokenA, raw: jpeg });
    check('une description invalide est refusée', r.status === 400);
    r = await call('GET', '/v1/me', { token: tokenA });
    check('le compte connaît l’espace occupé', r.data.bytes === jpeg.length, String(r.data.bytes));

    console.log('\n— Cloisonnement entre comptes —');
    const keyB = await deriveKey('ali@example.test', 'autremotdepasse');
    r = await call('POST', '/v1/auth/signup', { body: { email: 'ali@example.test', key: keyB, recovery: RECOVERY } });
    const tokenB = r.data.token;
    check('un second compte est créé', r.status === 201);
    r = await call('GET', '/v1/progress/paris', { token: tokenB });
    check('il ne voit pas la progression du premier', r.status === 200 && r.data.data === null);
    r = await call('GET', '/v1/photos', { token: tokenB });
    check('ni la liste de ses photos', r.data.photos.length === 0);
    r = await call('GET', '/v1/photos/abc123', { token: tokenB });
    check('ni une photo dont il devinerait l’identifiant', r.status === 404);

    console.log('\n— Quotas —');
    let q;
    for (let i = 0; i < 4; i++) q = await call('PUT', `/v1/photos/q${i}?city=paris&spot=x`, { token: tokenA, raw: jpeg });
    check('l’espace par compte est plafonné (refus poli, pas de facture)', q.status === 507 && q.data.error === 'quota_user', `${q.status} ${JSON.stringify(q.data)}`);
    r = await call('PUT', '/v1/photos/abc123?city=paris&spot=tour-eiffel', { token: tokenA, raw: jpeg });
    check('remplacer une photo existante ne compte pas double', r.status === 200, JSON.stringify(r.data));

    console.log('\n— Limitation des essais —');
    for (let i = 0; i < 3; i++) await call('POST', '/v1/auth/login', { body: { email: 'ali@example.test', key: wrong } });
    r = await call('POST', '/v1/auth/login', { body: { email: 'ali@example.test', key: keyB } });
    check('après trop d’échecs, même le bon mot de passe attend', r.status === 429 && r.data.error === 'too_many_attempts' && Number(r.headers.get('retry-after')) > 0);
    check('et le message dit combien de temps', /Réessaie dans \d+ minute/.test(r.data.message), r.data.message);
    r = await call('POST', '/v1/auth/login', { body: { email: 'souad@example.test', key } });
    check('les autres comptes ne sont pas bloqués', r.status === 200);
    let s;
    for (let i = 0; i < 6; i++) s = await call('POST', '/v1/auth/signup', { body: { email: `spam${i}@example.test`, key, recovery: RECOVERY } });
    check('les créations de compte en rafale sont freinées', s.status === 429, String(s.status));

    console.log('\n— Clé de secours —');
    const newKey = await deriveKey(email, 'nouveau-mdp-2026');
    r = await call('POST', '/v1/auth/recover', { body: { email: 'souad@example.test', recovery: 'ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ', key: newKey } });
    check('une mauvaise clé de secours est refusée', r.status === 401 && r.data.error === 'invalid_recovery');
    r = await call('POST', '/v1/auth/recover', { body: { email: 'souad@example.test', recovery: 'abcde fghjk mnpqr stvwx yzo12', key: newKey } });
    check('la bonne clé, même tapée en minuscules avec un O, remplace le mot de passe', r.status === 200 && r.data.token, JSON.stringify(r.data));
    const tokenA3 = r.data.token;
    r = await call('GET', '/v1/me', { token: tokenA2 });
    check('les anciennes sessions sont révoquées', r.status === 401);
    r = await call('POST', '/v1/auth/login', { body: { email: 'souad@example.test', key } });
    check('l’ancien mot de passe ne marche plus', r.status === 401);
    r = await call('POST', '/v1/auth/login', { body: { email: 'souad@example.test', key: newKey } });
    check('le nouveau, si', r.status === 200);
    r = await call('PUT', '/v1/account/recovery', { token: tokenA3, body: { recovery: '22222-33333-44444-55555-66666' } });
    check('changer la clé de secours sans mot de passe est refusé (un jeton volé ne suffit pas)', r.status === 400);
    r = await call('PUT', '/v1/account/recovery', { token: tokenA3, body: { recovery: '22222-33333-44444-55555-66666', key } });
    check('avec un mauvais mot de passe aussi', r.status === 401);
    r = await call('PUT', '/v1/account/recovery', { token: tokenA3, body: { recovery: '22222-33333-44444-55555-66666', key: newKey } });
    check('avec le bon, une nouvelle clé de secours est posée', r.status === 200);
    r = await call('POST', '/v1/auth/recover', { body: { email: 'souad@example.test', recovery: RECOVERY, key: newKey } });
    check('l’ancienne clé de secours ne vaut plus rien', r.status === 401);

    console.log('\n— Déconnexion et suppression —');
    r = await call('POST', '/v1/auth/logout', { token: tokenB });
    check('la déconnexion révoque le jeton', r.status === 200 && (await call('GET', '/v1/me', { token: tokenB })).status === 401);
    r = await call('DELETE', '/v1/account', { token: tokenA3, body: { key } });
    check('supprimer le compte redemande le bon mot de passe', r.status === 401);
    r = await call('DELETE', '/v1/account', { token: tokenA3, body: { key: newKey } });
    check('le compte est supprimé', r.status === 200);
    r = await call('POST', '/v1/auth/login', { body: { email: 'souad@example.test', key: newKey } });
    check('il n’existe plus', r.status === 401);
    const kB2 = await call('POST', '/v1/auth/login', { body: { email: 'ali@example.test', key: keyB } });
    check('l’autre compte est intact', kB2.status === 200 || kB2.status === 429);

    console.log('\n— Ménage planifié —');
    const sch = await fetch(`${B}/__scheduled?cron=17+3+*+*+*`);
    check('la tâche quotidienne s’exécute sans erreur', sch.status === 200, await sch.text());

    console.log('\n— Divers —');
    r = await call('GET', '/v1/nimporte-quoi');
    check('une adresse inconnue répond 404 en JSON', r.status === 404 && r.data.error === 'not_found');
    r = await call('DELETE', '/v1/me', { token: tokenB });
    check('une méthode inattendue répond 405', r.status === 405);
    check('aucune erreur inattendue dans le journal du serveur', !/Erreur inattendue|Uncaught|✘ \[ERROR\]/.test(srv.log()), srv.log().split('\n').filter((l) => /ERROR|Erreur/.test(l)).join(' | '));
  } finally {
    await srv.stop();
  }

  console.log('\n— En parallèle : les limites tiennent —');
  const jpeg = readFileSync(join(ROOT, 'tests', 'fixtures', 'comedie-1.jpg'));
  const fake = (n) => { const b = Buffer.alloc(n, 0x41); b[0] = 0xff; b[1] = 0xd8; b[2] = 0xff; return b; };
  const race = await startServer({ port: 8797, vars: {
    LOGIN_ATTEMPTS_PER_ACCOUNT_IP: 3, SIGNUPS_PER_IP: 3, MAX_CITIES: 3,
    MAX_USER_BYTES: 3 * jpeg.length, MAX_TOTAL_BYTES: 100000000,
  } });
  try {
    const R = race.base;
    const post = (path, body, token) => fetch(R + path, { method: 'POST', headers: token ? { authorization: `Bearer ${token}` } : {}, body: JSON.stringify(body) });
    const kR = await deriveKey('race@example.test', 'motdepasse123');
    const su = await (await post('/v1/auth/signup', { email: 'race@example.test', key: kR, recovery: RECOVERY })).json();
    const T = su.token;
    const bad = await deriveKey('race@example.test', 'pas-le-bon');
    const logins = await Promise.all(Array.from({ length: 30 }, () => post('/v1/auth/login', { email: 'race@example.test', key: bad })));
    const tried = logins.filter((x) => x.status === 401).length;
    check('30 essais simultanés : au plus 3 mots de passe examinés', tried <= 3, `${tried} examinés`);

    const signups = await Promise.all(Array.from({ length: 20 }, (_, i) => post('/v1/auth/signup', { email: `burst${i}@example.test`, key: kR, recovery: RECOVERY })));
    const made = signups.filter((x) => x.status === 201).length;
    check('20 inscriptions simultanées : le plafond par IP tient (3 au total)', made <= 2, `${made} créées en plus de la première`);

    const auth = { authorization: `Bearer ${T}` };
    const cities = await Promise.all(Array.from({ length: 20 }, (_, i) => fetch(`${R}/v1/progress/c${i}`, { method: 'PUT', headers: auth, body: JSON.stringify({ data: { spots: {} } }) })));
    const kept = cities.filter((x) => x.status === 200).length;
    check('20 villes simultanées : 3 au plus', kept === 3, `${kept} acceptées`);

    const ups = await Promise.all(Array.from({ length: 10 }, (_, i) => fetch(`${R}/v1/photos/par${i}?city=paris&spot=x`, { method: 'PUT', headers: auth, body: jpeg })));
    const stored = ups.filter((x) => x.status === 200).length;
    const me1 = await (await fetch(`${R}/v1/me`, { headers: auth })).json();
    const list1 = await (await fetch(`${R}/v1/photos`, { headers: auth })).json();
    const sum1 = list1.photos.reduce((a, p) => a + p.size, 0);
    check('10 envois simultanés : le quota du compte tient', stored === 3 && me1.bytes <= me1.maxBytes, `${stored} acceptés, ${me1.bytes}/${me1.maxBytes}`);
    check('et le compteur égale ce qui est réellement stocké', me1.bytes === sum1, `${me1.bytes} ≠ ${sum1}`);

    // Remplacements concurrents d'une même photo : le compteur ne doit pas dériver.
    const big = await fetch(`${R}/v1/photos/par0?city=paris&spot=x`, { method: 'PUT', headers: auth, body: fake(4000) });
    check('une photo peut être remplacée par une plus petite, même compte plein', big.status === 200, String(big.status));
    const reps = await Promise.all(Array.from({ length: 8 }, (_, i) => fetch(`${R}/v1/photos/par0?city=paris&spot=x`, { method: 'PUT', headers: auth, body: fake(10 + i) })));
    const me2 = await (await fetch(`${R}/v1/me`, { headers: auth })).json();
    const list2 = await (await fetch(`${R}/v1/photos`, { headers: auth })).json();
    const sum2 = list2.photos.reduce((a, p) => a + p.size, 0);
    check('8 remplacements simultanés : le compteur reste exact', reps.every((x) => x.status === 200) && me2.bytes === sum2 && me2.bytes < 13200,
      `${reps.map((x) => x.status)} — compteur ${me2.bytes}, stocké ${sum2}`);

    const old = await fetch(`${R}/v1/photos/scan1965?city=paris&spot=x&createdAt=-157766400000`, { method: 'PUT', headers: auth, body: fake(50) });
    const list3 = await (await fetch(`${R}/v1/photos`, { headers: auth })).json();
    check('une photo datée de 1965 est acceptée', old.status === 200 && list3.photos.some((p) => p.id === 'scan1965' && p.createdAt === -157766400000));

    const del = await fetch(`${R}/v1/account`, { method: 'DELETE', headers: auth, body: JSON.stringify({ key: kR }) });
    check('la suppression d’un compte rempli fonctionne', del.status === 200);
  } finally {
    await race.stop();
  }

  console.log('\n— Sans R2 (stockage photo non activé) —');
  const lite = await startServer({ port: 8791, photos: false });
  try {
    let r = await fetch(`${lite.base}/v1/health`).then((x) => x.json());
    check('le serveur annonce l’absence de photos', r.ok === true && r.photos === false);
    const key = await deriveKey('lite@example.test', 'motdepasse123');
    const su = await fetch(`${lite.base}/v1/auth/signup`, { method: 'POST', body: JSON.stringify({ email: 'lite@example.test', key, recovery: RECOVERY }) }).then((x) => x.json());
    const put = await fetch(`${lite.base}/v1/progress/lyon`, { method: 'PUT', headers: { authorization: `Bearer ${su.token}` }, body: JSON.stringify({ data: { spots: {} } }) });
    check('comptes et progression marchent quand même', !!su.token && put.status === 200);
    const ph = await fetch(`${lite.base}/v1/photos/p1?city=lyon&spot=x`, { method: 'PUT', headers: { authorization: `Bearer ${su.token}` }, body: readFileSync(join(ROOT, 'tests', 'fixtures', 'comedie-1.jpg')) });
    const phBody = await ph.json();
    check('les photos sont refusées avec un code clair', ph.status === 503 && phBody.error === 'photos_disabled');
    const del = await fetch(`${lite.base}/v1/account`, { method: 'DELETE', headers: { authorization: `Bearer ${su.token}` }, body: JSON.stringify({ key }) });
    check('et la suppression de compte aussi', del.status === 200);
  } finally {
    await lite.stop();
  }

  console.log(`\n${passed} vérifications passées, ${failures.length} échec(s).`);
  if (failures.length) process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e); process.exit(1); });
