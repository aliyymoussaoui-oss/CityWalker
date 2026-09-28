/**
 * server/deploy.sh face à une imitation de l'API Cloudflare : chaque branche
 * (pas de secrets, jeton refusé, ressources neuves ou existantes, R2 non
 * activé, compte sans sous-domaine) est jouée, puis wrangler valide à blanc la
 * configuration produite.
 *
 *   node tests/deploy.mjs
 */
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = join(ROOT, 'server', 'deploy.sh');
const GENERATED = join(ROOT, 'server', 'wrangler.deploy.toml');

let passed = 0;
const failures = [];
const check = (name, cond, detail) => {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failures.push(name); console.log(`  ✗ ${name}${detail !== undefined ? ' — ' + detail : ''}`); }
};

const ACCOUNT = '0123456789abcdef0123456789abcdef';
const ok = (result) => ({ success: true, errors: [], result });
const ko = (code, message) => ({ success: false, errors: [{ code, message }], result: null });

/** Faux Cloudflare ; `s` décrit l'état du compte et se modifie comme le vrai. */
function fakeCloudflare(s) {
  const calls = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      const p = url.pathname.replace(/^\/client\/v4/, '');
      calls.push(`${req.method} ${p}`);
      const send = (code, value) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
      if (req.headers.authorization !== 'Bearer bon-jeton') return send(403, ko(10000, 'Authentication error'));
      if (!p.startsWith(`/accounts/${ACCOUNT}/`)) return send(403, ko(10000, 'Authentication error'));
      const rest = p.slice(`/accounts/${ACCOUNT}`.length);
      if (rest === '/workers/scripts' && req.method === 'GET') return send(200, ok([]));
      if (rest === '/d1/database' && req.method === 'GET') {
        return send(200, ok(s.db ? [{ uuid: s.db, name: 'citywalker' }, { uuid: 'autre', name: 'citywalker-old' }] : [{ uuid: 'autre', name: 'citywalker-old' }]));
      }
      if (rest === '/d1/database' && req.method === 'POST') {
        s.db = '11111111-2222-3333-4444-555555555555';
        return send(200, ok({ uuid: s.db, name: JSON.parse(body).name }));
      }
      if (rest === '/r2/buckets/citywalker-photos' && req.method === 'GET') {
        if (s.r2GetFails) return send(500, ko(10001, 'Internal error'));
        if (!s.r2Enabled) return send(403, ko(10042, 'Please enable R2 through the Cloudflare Dashboard.'));
        return s.bucket ? send(200, ok({ name: 'citywalker-photos' })) : send(404, ko(10006, 'The specified bucket does not exist.'));
      }
      if (rest === '/r2/buckets' && req.method === 'POST') {
        if (s.r2PostFails) return send(500, ko(10001, 'Internal error'));
        if (!s.r2Enabled) return send(403, ko(10042, 'Please enable R2 through the Cloudflare Dashboard.'));
        if (s.bucket) return send(409, ko(10004, 'The bucket you tried to create already exists, and you own it.'));
        s.bucket = true;
        return send(200, ok({ name: JSON.parse(body).name }));
      }
      if (rest === '/workers/subdomain' && req.method === 'GET') {
        return s.sub ? send(200, ok({ subdomain: s.sub })) : send(404, ko(10007, 'workers.dev subdomain not found'));
      }
      if (rest === '/workers/subdomain' && req.method === 'PUT') {
        s.sub = JSON.parse(body).subdomain;
        return send(200, ok({ subdomain: s.sub }));
      }
      return send(404, ko(7003, `no route ${req.method} ${rest}`));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, calls, base: `http://127.0.0.1:${server.address().port}/client/v4` })));
}

function run(env) {
  const out = join(tmpdir(), `cw-deploy-${passed}-${failures.length}-${Math.random().toString(36).slice(2)}`);
  writeFileSync(out, '');
  return new Promise((resolve) => {
    execFile('bash', [SCRIPT], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, GITHUB_OUTPUT: out, DRY_RUN: '1', ...env },
      timeout: 120000,
    }, (err, stdout, stderr) => {
      const output = readFileSync(out, 'utf8');
      rmSync(out, { force: true });
      resolve({ code: err ? err.code : 0, log: stdout + stderr, output, toml: (() => { try { return readFileSync(GENERATED, 'utf8'); } catch (_) { return ''; } })() });
    });
  });
}

async function scenario(title, state, env, assert) {
  console.log(`\n— ${title} —`);
  rmSync(GENERATED, { force: true });
  const cf = await fakeCloudflare(state);
  try {
    const r = await run({ CLOUDFLARE_API_BASE: cf.base, CLOUDFLARE_ACCOUNT_ID: ACCOUNT, CLOUDFLARE_API_TOKEN: 'bon-jeton', ...env });
    assert(r, state, cf.calls);
  } finally {
    cf.server.close();
  }
}

console.log('\n— Sans secrets —');
{
  const r = await run({});
  check('le script réussit sans rien faire', r.code === 0, r.log);
  check('et publie une URL vide : le site reste en local', r.output.trim() === 'url=', r.output);
}

await scenario('Jeton refusé', {}, { CLOUDFLARE_API_TOKEN: 'mauvais' }, (r) => {
  check('le déploiement s’arrête', r.code !== 0);
  check('avec un message qui dit quoi corriger', /jeton Cloudflare.*refusé/.test(r.log), r.log.slice(-400));
  check('et la raison donnée par Cloudflare', /10000: Authentication error/.test(r.log), r.log.slice(-400));
  check('sans publier d’URL', !/url=http/.test(r.output));
});

await scenario('Compte neuf, R2 activé', { r2Enabled: true }, {}, (r, s, calls) => {
  check('le déploiement réussit', r.code === 0, r.log.slice(-800));
  check('la base D1 est créée', s.db && calls.includes(`POST /accounts/${ACCOUNT}/d1/database`));
  check('le stockage R2 est créé', s.bucket === true);
  check('un sous-domaine workers.dev est réservé', /^citywalker-[0-9a-f]{8}$/.test(s.sub || ''), s.sub);
  check('la configuration pointe vers la bonne base', r.toml.includes(`database_id = "${s.db}"`) && !r.toml.includes('autre'));
  check('et déclare le stockage des photos', /\[\[r2_buckets\]\]\s*\nbinding = "PHOTOS"/.test(r.toml));
  check('wrangler valide et assemble le Worker', /--dry-run: exiting now/i.test(r.log), r.log.slice(-600));
  check('l’URL publiée est celle du Worker', r.output.trim() === `url=https://citywalker-api.${s.sub}.workers.dev`, r.output);
});

await scenario('Redéploiement : tout existe déjà', { r2Enabled: true, db: 'deja-la', bucket: true, sub: 'maison' }, {}, (r, s, calls) => {
  check('le déploiement réussit', r.code === 0, r.log.slice(-600));
  check('rien n’est recréé', !calls.some((c) => c.startsWith('POST') || c.startsWith('PUT')), calls.join(', '));
  check('la base existante est reprise', r.toml.includes('database_id = "deja-la"'));
  check('l’URL reste la même', r.output.trim() === 'url=https://citywalker-api.maison.workers.dev', r.output);
});

await scenario('R2 non activé (pas de moyen de paiement)', { r2Enabled: false, sub: 'maison' }, {}, (r) => {
  check('le déploiement réussit quand même', r.code === 0, r.log.slice(-600));
  check('un avertissement explique comment activer R2', /R2 n'est pas activé.*Purchase R2 Plan/.test(r.log), r.log.slice(-500));
  check('le serveur part sans stockage de photos', !r.toml.includes('r2_buckets'));
  check('une URL est publiée : comptes et progression marchent', /^url=https:\/\/citywalker-api\.maison\.workers\.dev$/.test(r.output.trim()));
});

await scenario('R2 en service, lecture en échec passager', { r2Enabled: true, bucket: true, sub: 'maison', db: 'deja-la', r2GetFails: true }, {}, (r) => {
  check('le déploiement réussit', r.code === 0, r.log.slice(-600));
  check('le stockage des photos est conservé (« existe déjà, et c’est le tien »)', /\[\[r2_buckets\]\]/.test(r.toml));
});

await scenario('R2 injoignable (panne Cloudflare)', { r2Enabled: true, bucket: true, sub: 'maison', db: 'deja-la', r2GetFails: true, r2PostFails: true }, {}, (r) => {
  check('le déploiement s’arrête au lieu de retirer les photos', r.code !== 0);
  check('rien n’est publié', !/url=http/.test(r.output));
  check('le message donne la raison', /Stockage R2 inaccessible : 10001: Internal error/.test(r.log), r.log.slice(-500));
});

rmSync(GENERATED, { force: true });
console.log(`\n${passed} vérifications passées, ${failures.length} échec(s).`);
if (failures.length) process.exit(1);
