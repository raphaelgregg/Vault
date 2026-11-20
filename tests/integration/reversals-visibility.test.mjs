/**
 * VF-COR-01 (verificação adicional) — leitura de `reversals` nos 4 cenários, com Rules reais e estornos criados pelo
 * SERVIDOR (Admin SDK). Conferidos: saldos, situação/recebido das parcelas, valor guardado em meta, resultado de transferências.
 * Regra: leitura negada = dado DESCONHECIDO (erro ou marca explícita), nunca "nenhum estorno" nem valor incorreto.
 *   S1 coleção vazia · S2 estorno existente + leitura permitida · S3 estorno existente + leitura NEGADA (Rules antigas)
 *   S4 indisponibilidade/erro de conexão (Firestore fora) com estorno existente.
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startEnv, makeRealIo, attempt, ALICE } from './helpers/real-io.mjs';
import { adminDb, clearAll, seed, seedAccount, call, UID } from './helpers/server.mjs';
import { loadBalances } from '../../js/services/balances.js';
import { getDebtorStatement } from '../../js/services/debtors.js';
import { listGoalTransactions } from '../../js/services/goals.js';
import { createTransfer } from '../../js/services/transfers.js';
import { receivedByInstallment, goalSavedCents } from '../../js/core/model.js';
import { ReversalsUnavailableError } from '../../js/utils/reversalsAccess.js';

before(() => adminDb());

/** Mundo: conta A (R$ 1.000), devedor com 2 parcelas de R$ 100 (p0 recebida), meta com aporte de R$ 60. */
async function world({ reversed }) {
  await seedAccount('A', 100000); await seedAccount('B', 0);
  await seed(UID, 'debtors', 'dev', { name: 'João', loanDate: '2026-11-10', lentCents: 20000, receivedCents: reversed ? 0 : 10000, status: 'open' });
  await seed(UID, 'debts', 'p0', { debtorId: 'dev', description: 'P', principalCents: 10000, dueDate: '2026-12-10', installmentNumber: 1, installmentsTotal: 2, debtGroupId: 'g', status: reversed ? 'pending' : 'paid' });
  await seed(UID, 'debts', 'p1', { debtorId: 'dev', description: 'P', principalCents: 10000, dueDate: '2027-01-10', installmentNumber: 2, installmentsTotal: 2, debtGroupId: 'g', status: 'pending' });
  await seed(UID, 'debtPayments', 'pay1', { debtId: 'p0', debtorId: 'dev', amountCents: 10000, date: '2026-12-02', accountId: 'A' });
  await seed(UID, 'goals', 'g1', { name: 'Viagem', targetCents: 100000, status: 'active' });
  await seed(UID, 'goalTransactions', 'gt1', { goalId: 'g1', type: 'deposit', amountCents: 6000, date: '2026-12-03', accountId: 'A' });
  if (reversed) {
    await seed(UID, 'reversals', 'debtPayments_pay1', { kind: 'debtPayment', targetCollection: 'debtPayments', targetId: 'pay1', amountCents: 10000, reason: 'Conta errada', date: '2026-12-04', operationId: 'rev-op-00001', accountId: 'A', debtorId: 'dev', debtId: 'p0', original: {} });
    await seed(UID, 'reversals', 'goalTransactions_gt1', { kind: 'goalTransaction', targetCollection: 'goalTransactions', targetId: 'gt1', amountCents: 6000, reason: 'Aporte errado', date: '2026-12-04', operationId: 'rev-op-00002', accountId: 'A', goalId: 'g1', original: {} });
  }
}

/** Tudo que a UI deriva de estornos, lido pelos services do cliente. */
async function observed(io, { tolerate = false } = {}) {
  const accounts = await io.list(ALICE, 'accounts', {});
  const flags = tolerate ? { tolerateReversalsDenied: true } : {};
  const balances = (await loadBalances(ALICE, accounts, { list: io.list })).balances;
  const debtor = (await io.list(ALICE, 'debtors', {}))[0];
  const st = await getDebtorStatement(ALICE, debtor, '2026-12', { list: io.list, ...flags });
  const { byDebt } = receivedByInstallment(st.payments, st.reversals);
  const goalRows = await listGoalTransactions(ALICE, 'g1', { list: io.list, ...flags });
  return { balanceA: balances.get('A'), receivedP0: byDebt.get('p0') ?? 0, goalSaved: goalSavedCents(goalRows) };
}

describe('S1 — coleção `reversals` VAZIA (Rules novas)', () => {
  let env; before(async () => { env = await startEnv(); }); after(async () => { await env?.cleanup(); }); beforeEach(clearAll);
  it('valores integrais: saldo 1.040, p0 recebida R$ 100 e paga, meta R$ 60; transferência confirma', async () => {
    await world({ reversed: false });
    const io = makeRealIo(env);
    assert.deepEqual(await observed(io), { balanceA: 104000, receivedP0: 10000, goalSaved: 6000 });
    const st = await getDebtorStatement(ALICE, (await io.list(ALICE, 'debtors', {}))[0], '2026-12', { list: io.list });
    assert.equal(st.reversalsUnavailable, undefined); // vazia REAL: nenhuma marca de limitação
    const t = await createTransfer(ALICE, { fromAccountId: 'A', toAccountId: 'B', amountCents: '50,00', date: '2026-12-05', reason: 'x', status: 'confirmed' }, io);
    assert.equal(t.ok, true);
    assert.equal((await io.list(ALICE, 'transfers', {})).filter((x) => x.status === 'confirmed').length, 1);
    assert.equal((await observed(io)).balanceA, 104000 - 5000);
  });
});

describe('S2 — estorno EXISTENTE e leitura PERMITIDA (Rules novas)', () => {
  let env; before(async () => { env = await startEnv(); }); after(async () => { await env?.cleanup(); }); beforeEach(clearAll);
  it('estornos descontados: saldo 1.000, p0 pendente com R$ 0 recebido, meta R$ 0 (original preservado); transferência usa o saldo real', async () => {
    await world({ reversed: true });
    const io = makeRealIo(env);
    assert.deepEqual(await observed(io), { balanceA: 100000, receivedP0: 0, goalSaved: 0 });
    const rows = await listGoalTransactions(ALICE, 'g1', { list: io.list });
    assert.deepEqual([rows.length, rows[0].reversed], [1, true]); // o aporte original continua no histórico, marcado
    assert.equal((await io.list(ALICE, 'debtPayments', {})).length, 1);
    assert.equal((await createTransfer(ALICE, { fromAccountId: 'A', toAccountId: 'B', amountCents: '1.000,00', date: '2026-12-05', reason: 'x', status: 'confirmed' }, io)).ok, true);
    const over = await createTransfer(ALICE, { fromAccountId: 'A', toAccountId: 'B', amountCents: '0,01', date: '2026-12-05', reason: 'x', status: 'confirmed' }, io);
    assert.deepEqual([over.ok, over.code], [false, 'INSUFFICIENT_BALANCE']); // saldo real zerou
  });
});

describe('S3 — estorno EXISTENTE e leitura NEGADA (Rules antigas)', () => {
  let env; before(async () => { env = await startEnv('tests/fixtures/firestore.rules.legacy'); }); after(async () => { await env?.cleanup(); }); beforeEach(clearAll);
  it('CONTROLE: o servidor criou o estorno, mas o navegador não consegue ler `reversals` (permission-denied)', async () => {
    await world({ reversed: true });
    const r = await attempt(() => makeRealIo(env).list(ALICE, 'reversals', {}));
    assert.deepEqual([r.ok, r.code], [false, 'permission-denied']);
  });
  it('NENHUM valor incorreto: saldos falham alto; extrato e metas só no modo limitado, MARCADOS como desconhecidos', async () => {
    await world({ reversed: true });
    const io = makeRealIo(env);
    // saldos (balances.js, intocado): falha explícita — nunca um número sem estornos
    const accounts = await io.list(ALICE, 'accounts', {});
    const b = await attempt(() => loadBalances(ALICE, accounts, { list: io.list }));
    assert.deepEqual([b.ok, b.code], [false, 'permission-denied']);
    // extrato do devedor e metas: estrito lança erro específico
    const debtor = (await io.list(ALICE, 'debtors', {}))[0];
    await assert.rejects(() => getDebtorStatement(ALICE, debtor, '2026-12', { list: io.list }), ReversalsUnavailableError);
    await assert.rejects(() => listGoalTransactions(ALICE, 'g1', { list: io.list }), ReversalsUnavailableError);
    // limitado: a marca é obrigatória (a UI oculta recebido/situação/guardado quando ela existe)
    const st = await getDebtorStatement(ALICE, debtor, '2026-12', { list: io.list, tolerateReversalsDenied: true });
    assert.equal(st.reversalsUnavailable, true);
    const rows = await listGoalTransactions(ALICE, 'g1', { list: io.list, tolerateReversalsDenied: true });
    assert.equal(rows.reversalsUnavailable, true);
  });
  it('transferências seguem corretas: o SERVIDOR decide com os estornos que o navegador não vê; a lista (coleção legível) reflete o resultado', async () => {
    await world({ reversed: true });
    const io = makeRealIo(env);
    const over = await createTransfer(ALICE, { fromAccountId: 'A', toAccountId: 'B', amountCents: '1.000,01', date: '2026-12-05', reason: 'x', status: 'confirmed' }, io);
    assert.deepEqual([over.ok, over.code], [false, 'INSUFFICIENT_BALANCE']); // saldo real 1.000 (com estornos), não 1.040
    const ok = await createTransfer(ALICE, { fromAccountId: 'A', toAccountId: 'B', amountCents: '1.000,00', date: '2026-12-05', reason: 'x', status: 'confirmed' }, io);
    assert.equal(ok.ok, true);
    const list = await io.list(ALICE, 'transfers', {});
    assert.deepEqual(list.map((t) => [t.status, t.amountCents]), [['confirmed', 100000]]);
  });
});

describe('S4 — indisponibilidade / erro de conexão (Firestore fora) com estorno existente', () => {
  let env; before(async () => { env = await startEnv(); }); after(async () => { await env?.cleanup(); }); beforeEach(clearAll);
  it('o erro PROPAGA (estrito e limitado) — nunca vira "sem estornos"; transferências (servidor) continuam corretas', async () => {
    await world({ reversed: true });
    const io = makeRealIo(env);
    const offline = (_u, c, o) => (c === 'reversals' ? Promise.reject(Object.assign(new Error('offline'), { code: 'unavailable' })) : io.list(_u, c, o));
    const accounts = await io.list(ALICE, 'accounts', {});
    await assert.rejects(() => loadBalances(ALICE, accounts, { list: offline }), /offline/);
    const debtor = (await io.list(ALICE, 'debtors', {}))[0];
    for (const flags of [{}, { tolerateReversalsDenied: true }]) {
      await assert.rejects(() => getDebtorStatement(ALICE, debtor, '2026-12', { list: offline, ...flags }), /offline/);
      await assert.rejects(() => listGoalTransactions(ALICE, 'g1', { list: offline, ...flags }), /offline/);
    }
    const r = await call(UID, 'transfer.create', 'conn-op-0001', { fromAccountId: 'A', toAccountId: 'B', amountCents: 100001, date: '2026-12-05', reason: 'x', status: 'confirmed' });
    assert.deepEqual([r.status, r.body.error], [409, 'INSUFFICIENT_BALANCE']);
  });
});
