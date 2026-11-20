/**
 * Central de validação do sistema (VF-UI-02) — servidor, Firebase Emulator real. Autorização (tokens reais do Auth
 * Emulator e injetados), isolamento dos dados reais, manifesto adulterado, concorrência e auditoria funcional.
 */
import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { handleValidation, CONFIRM, DEMO_COLLECTIONS } from '../../server/validation/center.mjs';
import { adminDb, clearAll, seed, seedAccount, seedCategory, dump, getDoc, UID, OTHER } from './helpers/server.mjs';

before(() => adminDb());
beforeEach(clearAll);

const hook = (admin, current = admin) => ({ db: adminDb(), verifyIdToken: async (t) => ({ uid: String(t).replace(/^tok-/, ''), ...(admin === undefined ? {} : { admin }) }), isCurrentAdmin: async () => current, log: () => {} });
const post = (op, extra = {}, deps = hook(true), uid = UID) => handleValidation({ method: 'POST', headers: { authorization: `Bearer tok-${uid}` }, body: { op, ...extra } }, deps);
const SEED = { confirm: CONFIRM.seed };
const CLEAN = { confirm: CONFIRM.cleanup };
const totalDocs = async (uid = UID) => { let n = 0; for (const c of [...DEMO_COLLECTIONS, 'reversals', 'operations', 'demoSeeds']) n += (await dump(c, uid)).length; return n; };

/** Usuário REAL do Auth Emulator: { uid, token() } (token com as claims vigentes). */
async function authUser(email) {
  const host = process.env.FIREBASE_AUTH_EMULATOR_HOST;
  const call = (path, body) => fetch(`http://${host}/identitytoolkit.googleapis.com/v1/${path}?key=fake-key`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer owner' }, body: JSON.stringify(body) }).then((r) => r.json());
  const up = await call('accounts:signUp', { email, password: 'senha-forte-123', returnSecureToken: true });
  return {
    uid: up.localId,
    token: async () => (await call('accounts:signInWithPassword', { email, password: 'senha-forte-123', returnSecureToken: true })).idToken,
    setAdmin: (on) => call(`projects/demo-vault-finance/accounts:update`, { localId: up.localId, customAttributes: JSON.stringify(on ? { admin: true } : {}) }),
  };
}
const real = (token, op, extra = {}) => handleValidation({ method: 'POST', headers: token ? { authorization: `Bearer ${token}` } : {}, body: { op, ...extra } }, { log: () => {} });

describe('autorização — nenhum recurso da Central sem administrador validado', () => {
  it('sem token, token inválido, método errado, não-admin e admin REVOGADO: 401/403/405 e NADA é criado (todas as operações)', async () => {
    for (const op of ['status', 'seed', 'audit', 'cleanup']) {
      const extra = op === 'seed' ? SEED : op === 'cleanup' ? CLEAN : {};
      assert.equal((await handleValidation({ method: 'POST', headers: {}, body: { op, ...extra } }, hook(true))).status, 401, `${op} sem token`);
      assert.equal((await handleValidation({ method: 'POST', headers: { authorization: 'Bearer x' }, body: { op, ...extra } }, { ...hook(true), verifyIdToken: async () => { throw new Error('bad'); } })).status, 401, `${op} token inválido`);
      assert.equal((await handleValidation({ method: 'GET', headers: { authorization: 'Bearer tok-a' }, body: null }, hook(true))).status, 405);
      for (const [label, deps] of [['admin ausente no token', hook(undefined)], ['admin false', hook(false)], ['admin "true" textual', { ...hook(true), verifyIdToken: async () => ({ uid: UID, admin: 'true' }) }], ['token admin mas conta REVOGADA', hook(true, false)]]) {
        const r = await post(op, extra, deps);
        assert.deepEqual([r.status, r.body.error], [403, 'FORBIDDEN'], `${op}: ${label}`);
      }
    }
    assert.equal(await totalDocs(), 0);
  });

  it('tokens REAIS do Auth Emulator: usuário comum 403; admin 200; após revogar a claim o token antigo (ainda com claim) é barrado pela checagem atual', async () => {
    const common = await authUser('comum@teste.local');
    const admin = await authUser('admin@teste.local');
    assert.equal((await real(await common.token(), 'status')).status, 403);
    assert.equal((await real(await common.token(), 'seed', SEED)).status, 403);
    assert.equal((await real(null, 'status')).status, 401);
    await admin.setAdmin(true);
    const adminToken = await admin.token();
    const ok = await real(adminToken, 'status');
    assert.deepEqual([ok.status, ok.body.seeded], [200, false]);
    await admin.setAdmin(false); // revoga; o ID token já emitido ainda traz admin:true
    const revoked = await real(adminToken, 'seed', SEED);
    assert.equal(revoked.status, 403);
    assert.equal(await totalDocs(admin.uid), 0);
  });

  it('frase de confirmação é obrigatória para popular e para remover', async () => {
    assert.equal((await post('seed', {})).body.error, 'CONFIRMATION_REQUIRED');
    assert.equal((await post('seed', { confirm: 'popular' })).status, 400);
    assert.equal((await post('cleanup', { confirm: CONFIRM.seed })).status, 400);
    assert.equal(await totalDocs(), 0);
  });
});

describe('popular, auditar e remover — isolamento dos dados reais', () => {
  const makeReal = async () => {
    await seedAccount('real_conta', 12345); await seedCategory('real_cat', 'expense');
    await seed(UID, 'expenses', 'real_exp', { description: 'Aluguel real', categoryId: 'real_cat', amountCents: 5000, accountId: 'real_conta', purchaseDate: '2026-11-01', dueDate: '2026-11-10', status: 'paid', paidDate: '2026-11-10', recurrence: 'none' });
    await seed(UID, 'expenses', 'demo_sosia_real', { description: 'Registro REAL com id parecido (fora do manifesto)', categoryId: 'real_cat', amountCents: 777, accountId: 'real_conta', purchaseDate: '2026-11-01', dueDate: '2026-11-10', status: 'pending', recurrence: 'none' });
    await seed(UID, 'debtors', 'real_dev', { name: 'Devedor real', loanDate: '2026-10-10', lentCents: 9900, receivedCents: 0, status: 'open' });
    await seedAccount('conta_outro', 999, OTHER); // dado de OUTRO usuário
  };
  const snapshot = async () => {
    const out = {};
    for (const uid of [UID, OTHER]) for (const c of ['accounts', 'categories', 'expenses', 'debtors']) for (const d of await dump(c, uid)) if (!d.id.startsWith('demo_') || d.id === 'demo_sosia_real') out[`${uid}/${c}/${d.id}`] = JSON.stringify(d);
    return out;
  };

  it('seed → status → audit → cleanup: registros reais (inclusive um com id `demo_` fora do manifesto) permanecem idênticos; tudo de demonstração some', async () => {
    await makeReal();
    const before = await snapshot();
    const s = await post('seed', SEED);
    assert.equal(s.status, 200, JSON.stringify(s.body));
    assert.equal(s.body.created, 37); // 3 contas, 3 categorias, 2 receitas, 4 despesas, 2 transferências, meta+2 aportes, cartão+3 faturas+5 compras, 2 devedores+5 parcelas+3 recebimentos, 1 orçamento
    const st = await post('status');
    assert.deepEqual([st.body.seeded, st.body.items], [true, s.body.created]);
    const a = await post('audit');
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.equal(a.body.ok, true, JSON.stringify(a.body.scenarios.filter((x) => !x.ok)));
    assert.equal(a.body.failed, 0);
    assert.ok(a.body.scenarios.length >= 11);
    for (const id of ['base', 'transfer', 'insufficient', 'idempotency', 'concurrency', 'reversal', 'debtor', 'invoice', 'goal', 'isolation', 'restored']) assert.ok(a.body.scenarios.find((x) => x.id === id && x.ok), id);
    assert.ok(a.body.realRecordsChecked >= 5);
    // a auditoria não deixa lixo: mesma contagem de documentos de demonstração do que logo após o seed
    assert.equal((await dump('operations')).filter((o) => o.id.startsWith('demoaud-')).length, 0);
    assert.equal((await dump('transfers')).filter((t) => t.operationId?.startsWith('demoaud-')).length, 0);
    assert.equal((await dump('reversals')).filter((r) => r.operationId?.startsWith('demoaud-')).length, 0);
    assert.equal((await dump('accounts')).filter((x) => x.id.startsWith('demo_')).length, 3);
    // 2ª auditoria também passa (repetível)
    assert.equal((await post('audit')).body.ok, true);
    const c = await post('cleanup', CLEAN);
    assert.equal(c.status, 200);
    assert.equal(c.body.deleted, s.body.created);
    assert.deepEqual(await snapshot(), before); // NADA real mudou, nem o sósia `demo_sosia_real`
    assert.equal(await getDoc('demoSeeds', 'current'), null);
    for (const col of DEMO_COLLECTIONS) assert.equal((await dump(col)).filter((d) => d.id.startsWith('demo_') && d.id !== 'demo_sosia_real').length, 0, col);
  });

  it('popular duas vezes: 409 ALREADY_SEEDED; duas chamadas simultâneas: uma vence, a outra 409, sem duplicar (10×)', async () => {
    for (let i = 0; i < 10; i += 1) {
      await clearAll();
      const rs = await Promise.all([post('seed', SEED), post('seed', SEED)]);
      assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409], JSON.stringify(rs.map((r) => r.body)));
      assert.equal((await dump('accounts')).length, 3);
      assert.equal((await post('seed', SEED)).body.error, 'ALREADY_SEEDED');
      await post('cleanup', CLEAN);
    }
  });

  it('auditar sem popular: 409 NOT_SEEDED; limpar sem manifesto não apaga NADA (nem registros com id demo_)', async () => {
    await makeReal();
    assert.equal((await post('audit')).body.error, 'NOT_SEEDED');
    const before = await snapshot();
    const c = await post('cleanup', CLEAN);
    assert.equal(c.status, 200);
    assert.equal(c.body.deleted, 0);
    assert.deepEqual(await snapshot(), before);
  });

  it('MANIFESTO ADULTERADO (id real, coleção proibida, caminho com barra): a limpeza ignora tudo que não seja `demo_*` de coleção permitida', async () => {
    await makeReal();
    await adminDb().doc(`users/${UID}/demoSeeds/current`).set({ items: [
      { c: 'accounts', id: 'real_conta' }, { c: 'expenses', id: 'real_exp' }, { c: 'auditLog', id: 'demo_x' }, { c: 'profile', id: 'demo_y' },
      { c: 'accounts', id: 'demo_../real_conta' }, { c: 'users', id: 'demo_z' }, { c: 'expenses', id: 'demo_sosia_real' }, { c: 'debtors', id: 'real_dev' },
    ], version: 1 });
    const before = await snapshot();
    const c = await post('cleanup', CLEAN);
    assert.equal(c.status, 200);
    // só o sósia `demo_sosia_real` está no manifesto E tem prefixo demo_ em coleção permitida: é removido (é o contrato do manifesto);
    // nenhum registro SEM prefixo demo_ ou de coleção proibida pode ser removido.
    const after = await snapshot();
    for (const k of Object.keys(before)) if (!k.endsWith('/demo_sosia_real')) assert.equal(after[k], before[k], k);
    assert.equal(c.body.deleted, 1);
  });

  it('dados de demonstração respeitam os schemas do app (editáveis na UI) e o saldo derivado bate com o oráculo', async () => {
    await post('seed', SEED);
    const { buildEntity } = await import('../../js/core/model.js');
    const toIso = (v) => (v?.toISOString ? v.toISOString().slice(0, 10) : v);
    for (const [coll, kind] of [['accounts', 'accounts'], ['incomes', 'incomes'], ['expenses', 'expenses'], ['transfers', 'transfers'], ['goals', 'goals'], ['creditCards', 'creditCards'], ['invoices', 'invoices'], ['cardPurchases', 'cardPurchases'], ['debtors', 'debtors'], ['debts', 'debts'], ['budgets', 'budgets']]) {
      for (const d of await dump(coll)) {
        const raw = Object.fromEntries(Object.entries(d).filter(([k]) => !['id', 'createdAt', 'updatedAt'].includes(k)).map(([k, v]) => [k, toIso(v)]));
        for (const k of Object.keys(raw)) if (/Cents$/.test(k)) raw[k] = String(raw[k] / 100).replace('.', ',');
        const r = buildEntity(kind, raw);
        assert.equal(r.ok, true, `${coll}/${d.id}: ${JSON.stringify(r.errors)}`);
      }
    }
    assert.equal((await post('audit')).body.scenarios.find((x) => x.id === 'base').ok, true);
  });
});
