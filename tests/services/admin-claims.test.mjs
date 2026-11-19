/**
 * VF-2-03aa — promoção/revogação de administradores: servidor (token, claim atual, alvo, self-revoke, claims
 * preservadas, credenciais) e cliente (validação, endpoint, auditoria).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { handleAdminClaims, signServiceAccountJwt, readServiceAccount, resetAdminClaimsCache } from '../../server/adminClaims.mjs';
import { setAdminClaim, parseAdminTarget, ADMIN_CLAIMS_ENDPOINT } from '../../js/services/adminClaims.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const account = { client_email: 'svc@test.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
const env = { FIREBASE_SERVICE_ACCOUNT: JSON.stringify(account), FIREBASE_PROJECT_ID: 'proj', FIREBASE_WEB_API_KEY: 'KEY' };

/** Fake do Google: usuários por idToken/uid/e-mail; registra chamadas. */
function makeGoogle({ users }) {
  const calls = [];
  const byToken = new Map(users.filter((u) => u.token).map((u) => [u.token, u]));
  const fetch = async (url, init = {}) => {
    const body = init.body && typeof init.body === 'string' && init.body.startsWith('{') ? JSON.parse(init.body) : init.body;
    calls.push({ url: String(url), headers: init.headers ?? {}, body });
    const reply = (status, data) => ({ ok: status >= 200 && status < 300, status, json: async () => data });
    if (String(url).startsWith('https://oauth2.googleapis.com/token')) return reply(200, { access_token: 'SERVER_TOKEN', expires_in: 3600 });
    if (String(url).includes('/v1/accounts:lookup?key=KEY')) {
      const u = byToken.get(body.idToken);
      return u ? reply(200, { users: [u] }) : reply(400, { error: { message: 'INVALID_ID_TOKEN' } });
    }
    if (String(url).endsWith('/projects/proj/accounts:lookup')) {
      assert.equal(init.headers.authorization, 'Bearer SERVER_TOKEN');
      const found = body.localId ? users.filter((u) => body.localId.includes(u.localId)) : users.filter((u) => body.email.includes(u.email));
      return reply(200, found.length ? { users: found } : {});
    }
    if (String(url).endsWith('/projects/proj/accounts:update')) {
      assert.equal(init.headers.authorization, 'Bearer SERVER_TOKEN');
      return reply(200, { localId: body.localId });
    }
    return reply(500, {});
  };
  return { fetch, calls, updates: () => calls.filter((c) => c.url.endsWith('accounts:update')).map((c) => c.body) };
}

const users = () => [
  { localId: 'adm1', email: 'adm@x.com', token: 'T_ADM', customAttributes: JSON.stringify({ admin: true }) },
  { localId: 'u1', email: 'user@x.com', token: 'T_U1', customAttributes: JSON.stringify({ plan: 'pro' }) },
  { localId: 'u2', email: 'outro@x.com', token: 'T_U2' },
  { localId: 'adm2', email: 'adm2@x.com', token: 'T_ADM2', customAttributes: JSON.stringify({ admin: true, role: 'x' }) },
  { localId: 'off', email: 'off@x.com', token: 'T_OFF', disabled: true, customAttributes: JSON.stringify({ admin: true }) },
];
const req = (token, body, method = 'POST') => ({ method, headers: token ? { authorization: `Bearer ${token}` } : {}, body });

describe('servidor: promover/revogar administradores', () => {
  it('administrador promove por e-mail e por uid; preserva as demais claims e retorna aviso de renovação de token', async () => {
    const g = makeGoogle({ users: users() });
    const byEmail = await handleAdminClaims(req('T_ADM', { target: 'USER@x.com', admin: true }), { env, fetch: g.fetch });
    assert.equal(byEmail.status, 200);
    assert.deepEqual([byEmail.body.ok, byEmail.body.target, byEmail.body.admin, byEmail.body.previousAdmin], [true, { uid: 'u1', email: 'user@x.com' }, true, false]);
    assert.match(byEmail.body.note, /sair e entrar|renovar/);
    const byUid = await handleAdminClaims(req('T_ADM', { target: 'u2', admin: true }), { env, fetch: g.fetch });
    assert.equal(byUid.status, 200);
    const [first, second] = g.updates();
    assert.deepEqual([first.localId, JSON.parse(first.customAttributes)], ['u1', { plan: 'pro', admin: true }]); // 'plan' preservada
    assert.deepEqual([second.localId, JSON.parse(second.customAttributes)], ['u2', { admin: true }]);
  });
  it('revogar remove só `admin` (mantém as outras claims); e é idempotente', async () => {
    const g = makeGoogle({ users: users() });
    const r = await handleAdminClaims(req('T_ADM', { target: 'adm2', admin: false }), { env, fetch: g.fetch });
    assert.deepEqual([r.status, r.body.admin, r.body.previousAdmin], [200, false, true]);
    assert.deepEqual(JSON.parse(g.updates()[0].customAttributes), { role: 'x' });
    const again = await handleAdminClaims(req('T_ADM', { target: 'u2', admin: false }), { env, fetch: g.fetch });
    assert.deepEqual([again.status, again.body.previousAdmin], [200, false]);
  });
  it('NÃO autorizado: sem token, token inválido, usuário comum e conta desativada → nada é gravado', async () => {
    const cases = [
      [req(null, { target: 'u2', admin: true }), 401, 'missing_token'],
      [req('T_INVALIDO', { target: 'u2', admin: true }), 401, 'invalid_token'],
      [req('T_U1', { target: 'u2', admin: true }), 403, 'forbidden'], // usuário comum
      [req('T_U2', { target: 'u2', admin: true }), 403, 'forbidden'], // sem claims
      [req('T_OFF', { target: 'u2', admin: true }), 403, 'disabled'],
    ];
    for (const [r, status, code] of cases) {
      const g = makeGoogle({ users: users() });
      const out = await handleAdminClaims(r, { env, fetch: g.fetch });
      assert.deepEqual([out.status, out.body.error], [status, code], code);
      assert.equal(g.updates().length, 0);
      assert.equal(g.calls.some((c) => c.url.startsWith('https://oauth2.googleapis.com')), false); // credencial do servidor nem é pedida
    }
  });
  it('a claim é conferida no estado ATUAL do servidor (token de ex-admin com claim velha não vale)', async () => {
    // o token ainda "diz" admin, mas o lookup (servidor) mostra que a claim foi retirada
    const g = makeGoogle({ users: [{ localId: 'ex', email: 'ex@x.com', token: 'T_EX', customAttributes: JSON.stringify({}) }, ...users()] });
    const out = await handleAdminClaims(req('T_EX', { target: 'u2', admin: true }), { env, fetch: g.fetch });
    assert.equal(out.status, 403);
    assert.equal(g.updates().length, 0);
  });
  it('validações: método, corpo, alvo inexistente e auto-revogação', async () => {
    const g = makeGoogle({ users: users() });
    assert.equal((await handleAdminClaims(req('T_ADM', {}, 'GET'), { env, fetch: g.fetch })).status, 405);
    for (const body of [null, {}, { target: '', admin: true }, { target: 'u2' }, { target: 'u2', admin: 'true' }, { target: 'x'.repeat(129), admin: true }]) {
      assert.equal((await handleAdminClaims(req('T_ADM', body), { env, fetch: g.fetch })).body.error, 'invalid_body');
    }
    assert.equal((await handleAdminClaims(req('T_ADM', 'não é json'), { env, fetch: g.fetch })).body.error, 'invalid_body');
    assert.deepEqual((await handleAdminClaims(req('T_ADM', { target: 'ninguem@x.com', admin: true }), { env, fetch: g.fetch })).status, 404);
    const self = await handleAdminClaims(req('T_ADM', { target: 'adm1', admin: false }), { env, fetch: g.fetch });
    assert.deepEqual([self.status, self.body.error], [400, 'self_revoke']);
    const selfByEmail = await handleAdminClaims(req('T_ADM', { target: 'adm@x.com', admin: false }), { env, fetch: g.fetch });
    assert.equal(selfByEmail.body.error, 'self_revoke');
    assert.equal(g.updates().length, 0);
    // o administrador pode RE-promover a si mesmo (idempotente) sem erro
    assert.equal((await handleAdminClaims(req('T_ADM', { target: 'adm1', admin: true }), { env, fetch: g.fetch })).status, 200);
  });
  it('servidor sem service account → 501; falha de troca de token → 502; emulador usa `Bearer owner` sem service account', async () => {
    const g = makeGoogle({ users: users() });
    const noCreds = await handleAdminClaims(req('T_ADM', { target: 'u2', admin: true }), { env: { FIREBASE_PROJECT_ID: 'proj', FIREBASE_WEB_API_KEY: 'KEY' }, fetch: g.fetch });
    assert.deepEqual([noCreds.status, noCreds.body.error], [501, 'not_configured']);
    resetAdminClaimsCache();
    const badFetch = async (url, init) => (String(url).startsWith('https://oauth2') ? { ok: false, status: 400, json: async () => ({}) } : g.fetch(url, init));
    assert.equal((await handleAdminClaims(req('T_ADM', { target: 'u2', admin: true }), { env, fetch: badFetch })).status, 502);
    const seen = [];
    const emu = async (url, init = {}) => {
      seen.push([String(url), init.headers?.authorization]);
      const body = init.body ? JSON.parse(init.body) : {};
      const ok = (data) => ({ ok: true, status: 200, json: async () => data });
      if (String(url).includes('accounts:lookup?key=')) return ok({ users: [users()[0]] });
      if (String(url).endsWith('accounts:lookup')) return ok({ users: [users()[2]] });
      return ok({ localId: body.localId });
    };
    const out = await handleAdminClaims(req('T_ADM', { target: 'u2', admin: true }), { env: { FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099', FIREBASE_PROJECT_ID: 'proj', FIREBASE_WEB_API_KEY: 'KEY' }, fetch: emu });
    assert.equal(out.status, 200);
    assert.ok(seen.every(([url]) => url.startsWith('http://127.0.0.1:9099/identitytoolkit.googleapis.com/')));
    assert.ok(seen.some(([, auth]) => auth === 'Bearer owner'));
  });
  it('a resposta nunca vaza token do servidor nem chave privada', async () => {
    const g = makeGoogle({ users: users() });
    for (const r of [req('T_ADM', { target: 'u1', admin: true }), req('T_U1', { target: 'u1', admin: true })]) {
      const out = JSON.stringify((await handleAdminClaims(r, { env, fetch: g.fetch })).body);
      assert.doesNotMatch(out, /SERVER_TOKEN|PRIVATE KEY|svc@test/);
    }
  });
  it('JWT da service account: RS256, claims corretas e assinatura verificável; leitura do ambiente (JSON/base64)', () => {
    const jwt = signServiceAccountJwt(account, Date.UTC(2026, 10, 19, 12));
    const [h, c, s] = jwt.split('.');
    assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url')), { alg: 'RS256', typ: 'JWT' });
    const claims = JSON.parse(Buffer.from(c, 'base64url'));
    assert.deepEqual([claims.iss, claims.aud, claims.exp - claims.iat], [account.client_email, 'https://oauth2.googleapis.com/token', 3600]);
    assert.equal(createVerify('RSA-SHA256').update(`${h}.${c}`).verify(publicKey, s, 'base64url'), true);
    assert.equal(readServiceAccount({ FIREBASE_SERVICE_ACCOUNT: Buffer.from(JSON.stringify(account)).toString('base64') }).client_email, account.client_email);
    assert.equal(readServiceAccount({ FIREBASE_SERVICE_ACCOUNT: 'lixo' }), null);
    assert.equal(readServiceAccount({}), null);
  });
});

describe('cliente: setAdminClaim', () => {
  const user = { uid: 'adm1', getIdToken: async () => 'T_ADM' };
  const okResponse = { ok: true, status: 200, json: async () => ({ ok: true, target: { uid: 'u1', email: 'user@x.com' }, admin: true, previousAdmin: false, note: 'renove o token' }) };

  it('valida o alvo (e-mail/uid) antes de chamar o servidor', () => {
    assert.deepEqual(parseAdminTarget(' User@X.com '), { ok: true, target: 'user@x.com', kind: 'email' });
    assert.deepEqual(parseAdminTarget('abc123'), { ok: true, target: 'abc123', kind: 'uid' });
    for (const bad of ['', '   ', 'a@b', 'com espaço', 'x'.repeat(129), null]) assert.equal(parseAdminTarget(bad).ok, false, String(bad));
  });
  it('envia POST ao endpoint com Bearer do ID token e registra auditoria do executor', async () => {
    const calls = [];
    const audits = [];
    const r = await setAdminClaim(user, { target: 'user@x.com', admin: true }, {
      fetch: async (url, init) => { calls.push([url, init]); return okResponse; },
      writeAudit: async (uid, entry) => { audits.push([uid, entry]); return { ok: true }; },
    });
    assert.equal(r.ok, true);
    assert.equal(calls[0][0], ADMIN_CLAIMS_ENDPOINT);
    assert.deepEqual([calls[0][1].method, calls[0][1].headers.authorization, JSON.parse(calls[0][1].body)], ['POST', 'Bearer T_ADM', { target: 'user@x.com', admin: true }]);
    assert.equal(audits[0][0], 'adm1');
    assert.deepEqual([audits[0][1].action, audits[0][1].docId, audits[0][1].after.targetUid, audits[0][1].after.adminUid], ['maintenance_admin_grant', 'u1', 'u1', 'adm1']);
    const revoke = await setAdminClaim(user, { target: 'u1', admin: false }, { fetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, target: { uid: 'u1', email: null }, admin: false, previousAdmin: true, note: '' }) }), writeAudit: async (u, e) => { audits.push([u, e]); return { ok: true }; } });
    assert.equal(audits.at(-1)[1].action, 'maintenance_admin_revoke');
    assert.equal(revoke.admin, false);
  });
  it('erros do servidor viram mensagens; falha de rede e de auditoria são reportadas; nada é auditado em falha', async () => {
    const audits = [];
    const io = (status, data) => ({ fetch: async () => ({ ok: false, status, json: async () => data }), writeAudit: async (...a) => { audits.push(a); return { ok: true }; } });
    assert.match((await setAdminClaim(user, { target: 'u1', admin: true }, io(403, { ok: false, error: 'forbidden' }))).error, /Apenas administradores/);
    assert.match((await setAdminClaim(user, { target: 'u1', admin: true }, io(404, { ok: false, error: 'target_not_found' }))).error, /não encontrado/);
    assert.match((await setAdminClaim(user, { target: 'u1', admin: false }, io(400, { ok: false, error: 'self_revoke' }))).error, /própria claim/);
    assert.match((await setAdminClaim(user, { target: 'u1', admin: true }, io(501, { ok: false, error: 'not_configured' }))).error, /FIREBASE_SERVICE_ACCOUNT/);
    assert.match((await setAdminClaim(user, { target: 'u1', admin: true }, { fetch: async () => { throw new Error('net'); } })).error, /conexão/);
    assert.equal(audits.length, 0);
    const auditFail = await setAdminClaim(user, { target: 'u1', admin: true }, { fetch: async () => okResponse, writeAudit: async () => ({ ok: false, error: new Error('negado') }) });
    assert.equal(auditFail.ok, true);
    assert.match(auditFail.auditError, /negado/);
    assert.equal((await setAdminClaim(null, { target: 'u1', admin: true })).ok, false);
    assert.equal((await setAdminClaim(user, { target: '', admin: true })).ok, false);
    assert.equal((await setAdminClaim(user, { target: 'u1', admin: 'sim' })).ok, false);
  });
});
