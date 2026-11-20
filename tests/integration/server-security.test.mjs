/**
 * SEGURANÇA da camada confiável — autenticação com Firebase ID tokens REAIS do Auth Emulator, isolamento entre usuários,
 * reuso de chave de idempotência de outro usuário, parâmetros proibidos e logs sem dados sensíveis.
 * (A negação de escrita direta do navegador, edição/exclusão de histórico e alteração de saldo está em tests/rules.)
 */
import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { handleFinance } from '../../server/finance/index.mjs';
import { adminDb, clearAll, call, callOk, opId, seed, seedAccount, dump, getDoc, oracleBalance, UID, OTHER } from './helpers/server.mjs';

before(() => adminDb());
beforeEach(clearAll);

/** Cria um usuário no Auth Emulator e devolve { uid, idToken } (token REAL, verificado pelo Admin SDK). */
async function signUp(email) {
  const host = process.env.FIREBASE_AUTH_EMULATOR_HOST;
  const res = await fetch(`http://${host}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake-key`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'senha-forte-123', returnSecureToken: true }),
  });
  const json = await res.json();
  assert.ok(json.idToken, JSON.stringify(json));
  return { uid: json.localId, idToken: json.idToken };
}
/** Chama o handler SEM injetar verifyIdToken: usa o Admin Auth real (emulador). */
const realCall = (idToken, body, logs = []) => handleFinance(
  { method: 'POST', headers: idToken ? { authorization: `Bearer ${idToken}` } : {}, body },
  { log: (e) => logs.push(e) },
);

describe('autenticação (ID token real)', () => {
  it('sem token, token inválido e esquema errado → 401; método diferente de POST → 405', async () => {
    const body = { op: 'transfer.create', operationId: opId(), params: {} };
    assert.equal((await realCall(null, body)).status, 401);
    assert.equal((await realCall('lixo.invalido.token', body)).status, 401);
    assert.equal((await handleFinance({ method: 'POST', headers: { authorization: 'Basic abc' }, body }, {})).status, 401);
    assert.equal((await handleFinance({ method: 'GET', headers: {}, body: null }, {})).status, 405);
  });

  it('token válido executa como o dono do token; o uid NUNCA vem do corpo; o mesmo token não alcança dados de outro usuário', async () => {
    const alice = await signUp('alice@teste.local');
    const bob = await signUp('bob@teste.local');
    await seedAccount('A', 10000, alice.uid); await seedAccount('B', 0, alice.uid);
    await seedAccount('XB', 5000, bob.uid);
    const ok = await realCall(alice.idToken, { op: 'transfer.create', operationId: opId(), params: { fromAccountId: 'A', toAccountId: 'B', amountCents: 1000, date: '2026-12-05', reason: 'x', status: 'confirmed' } });
    assert.equal(ok.status, 200, JSON.stringify(ok));
    assert.equal(await oracleBalance('A', alice.uid), 9000);
    // Alice tenta mover dinheiro da conta do Bob → a conta não existe no espaço dela
    const steal = await realCall(alice.idToken, { op: 'transfer.create', operationId: opId(), params: { fromAccountId: 'XB', toAccountId: 'A', amountCents: 1000, date: '2026-12-05', reason: 'x', status: 'confirmed' } });
    assert.deepEqual([steal.status, steal.body.error], [404, 'ACCOUNT_NOT_FOUND']);
    // uid no corpo é recusado
    const spoof = await realCall(alice.idToken, { op: 'transfer.create', operationId: opId(), params: { uid: bob.uid, fromAccountId: 'A', toAccountId: 'B', amountCents: 1, date: '2026-12-05', reason: 'x', status: 'confirmed' } });
    assert.deepEqual([spoof.status, spoof.body.error], [400, 'FORBIDDEN_PARAM']);
    assert.equal(await oracleBalance('XB', bob.uid), 5000);
    assert.equal((await dump('transfers', bob.uid)).length, 0);
  });
});

describe('isolamento e chaves de idempotência', () => {
  it('a MESMA operationId usada por outro usuário NÃO devolve o resultado do primeiro nem o bloqueia (namespace por uid)', async () => {
    await seedAccount('A', 10000); await seedAccount('B', 0);
    await seedAccount('A', 10000, OTHER); await seedAccount('B', 0, OTHER);
    const key = opId('shared');
    const t = { fromAccountId: 'A', toAccountId: 'B', amountCents: 3000, date: '2026-12-05', reason: 'x', status: 'confirmed' };
    const a = await callOk(UID, 'transfer.create', key, t);
    const b = await callOk(OTHER, 'transfer.create', key, { ...t, amountCents: 1000 });
    assert.equal(a.idempotent, false);
    assert.equal(b.idempotent, false);
    assert.notEqual(a.transferId, b.transferId);
    assert.equal(await oracleBalance('A', UID), 7000);
    assert.equal(await oracleBalance('A', OTHER), 9000);
    assert.equal((await getDoc('operations', key, UID)).result.transferId, a.transferId);
    assert.equal((await getDoc('operations', key, OTHER)).result.transferId, b.transferId);
  });

  it('mesma chave com parâmetros diferentes → 409 OPERATION_ID_REUSED e nada é executado', async () => {
    await seedAccount('A', 10000); await seedAccount('B', 0);
    const key = opId();
    const t = { fromAccountId: 'A', toAccountId: 'B', amountCents: 3000, date: '2026-12-05', reason: 'x', status: 'confirmed' };
    await callOk(UID, 'transfer.create', key, t);
    const r = await call(UID, 'transfer.create', key, { ...t, amountCents: 9000 });
    assert.deepEqual([r.status, r.body.error], [409, 'OPERATION_ID_REUSED']);
    assert.equal(await oracleBalance('A'), 7000);
  });

  it('recebimento de devedor/parcela/conta de OUTRO usuário nunca é alcançado', async () => {
    await seedAccount('A', 10000); await seedAccount('XA', 10000, OTHER);
    await seed(OTHER, 'debtors', 'dev', { name: 'D', loanDate: '2026-11-10', lentCents: 5000, receivedCents: 0, status: 'open' });
    await seed(OTHER, 'debts', 'p', { debtorId: 'dev', description: 'P', principalCents: 5000, dueDate: '2026-12-10', installmentNumber: 1, status: 'pending' });
    const viaParcel = await call(UID, 'debt.receive', opId(), { debtId: 'p', date: '2026-12-05', accountId: 'A' });
    assert.equal(viaParcel.status, 404);
    await seed(UID, 'debtors', 'mine', { name: 'M', loanDate: '2026-11-10', lentCents: 5000, receivedCents: 0, status: 'open' });
    await seed(UID, 'debts', 'mp', { debtorId: 'mine', description: 'P', principalCents: 5000, dueDate: '2026-12-10', installmentNumber: 1, status: 'pending' });
    const viaAccount = await call(UID, 'debt.receive', opId(), { debtId: 'mp', date: '2026-12-05', accountId: 'XA' });
    assert.equal(viaAccount.status, 404);
    assert.equal((await dump('debtPayments')).length + (await dump('debtPayments', OTHER)).length, 0);
    assert.equal(await oracleBalance('XA', OTHER), 10000);
  });
});

describe('validação de parâmetros e logs', () => {
  it('valores não inteiros, negativos, zero, gigantes, texto, datas inválidas, operationId ausente/curto e op desconhecida → 4xx sem efeito', async () => {
    await seedAccount('A', 10000); await seedAccount('B', 0);
    const t = (over) => ({ fromAccountId: 'A', toAccountId: 'B', amountCents: 100, date: '2026-12-05', reason: 'x', status: 'confirmed', ...over });
    const cases = [t({ amountCents: 10.5 }), t({ amountCents: -1 }), t({ amountCents: 0 }), t({ amountCents: 1e15 }), t({ amountCents: '100' }), t({ amountCents: NaN }),
      t({ date: '2026-02-30' }), t({ date: '05/12/2026' }), t({ fromAccountId: 'A', toAccountId: 'A' }), t({ status: 'paid' })];
    for (const params of cases) {
      const r = await call(UID, 'transfer.create', opId(), params);
      assert.ok(r.status >= 400 && r.status < 500, JSON.stringify([params, r]));
    }
    assert.equal((await call(UID, 'transfer.create', '', t({}))).status, 400);
    assert.equal((await call(UID, 'transfer.create', 'x', t({}))).status, 400);
    assert.ok([400, 404].includes((await call(UID, 'conta.hackear', opId(), {})).status));
    for (const forbidden of ['balanceCents', 'receivedCents', 'userId']) assert.equal((await call(UID, 'transfer.create', opId(), t({ [forbidden]: 1 }))).body.error, 'FORBIDDEN_PARAM', forbidden);
    assert.equal((await dump('transfers')).length, 0);
    assert.equal(await oracleBalance('A'), 10000);
  });

  it('logs são estruturados e NÃO contêm token, e-mail nem valores/descrições (só op, chave, uid truncado e resultado)', async () => {
    const logs = [];
    await seedAccount('A', 10000); await seedAccount('B', 0);
    const secret = 'tok-segredo-que-nao-pode-vazar';
    await handleFinance({ method: 'POST', headers: { authorization: `Bearer ${secret}` }, body: { op: 'transfer.create', operationId: opId(), params: { fromAccountId: 'A', toAccountId: 'B', amountCents: 123456, date: '2026-12-05', reason: 'motivo-privado', status: 'confirmed' } } },
      { db: adminDb(), verifyIdToken: async () => ({ uid: UID }), log: (e) => logs.push(e) });
    await handleFinance({ method: 'POST', headers: { authorization: `Bearer ${secret}` }, body: { op: 'transfer.create', operationId: opId(), params: { fromAccountId: 'A', toAccountId: 'A', amountCents: 1, date: '2026-12-05', reason: 'motivo-privado', status: 'confirmed' } } },
      { db: adminDb(), verifyIdToken: async () => ({ uid: UID }), log: (e) => logs.push(e) });
    assert.ok(logs.length >= 2);
    const text = JSON.stringify(logs);
    for (const leak of [secret, 'motivo-privado', '123456', 'alice-uid']) assert.equal(text.includes(leak), false, `vazou: ${leak}`);
    assert.ok(logs.every((l) => l.event && (l.op || l.code)));
  });
});
