/**
 * PONTA A PONTA: services do CLIENTE (js/services/*) → camada confiável REAL (handler da Vercel, Admin SDK) → Firebase
 * Emulator. Sem mocks de transação. Cobre lote retomável após queda no meio, estorno pelo service e leituras derivadas
 * (saldo, auditoria de integridade) contra um oráculo independente.
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startEnv, makeRealIo, serverBridge, dump, ALICE } from './helpers/real-io.mjs';
import { seedAccount, seedDebtor, seedPlan, derivedBalance } from './helpers/world.mjs';
import { settleMonthInstallments, settleDebts, settleInstallment } from '../../js/services/debtPayments.js';
import { createReversal } from '../../js/services/reversals.js';
import { createTransfer } from '../../js/services/transfers.js';
import { createAccount, archiveAccount, deleteAccount } from '../../js/services/accounts.js';
import { auditFinancialIntegrity } from '../../js/services/integrity.js';
import { createCategory } from '../../js/services/categories.js';
import { createIncome } from '../../js/services/incomes.js';
import { createExpense } from '../../js/services/expenses.js';
import { createGoal, depositToGoal, listGoalTransactions } from '../../js/services/goals.js';
import { loadDashboard } from '../../js/services/dashboard.js';
import { loadDebtorStatements } from '../../js/services/debtors.js';
import { goalSavedCents } from '../../js/core/model.js';
import { MONTH, NOW } from './helpers/world.mjs';

let env;
before(async () => { env = await startEnv(); });
after(async () => { await env?.cleanup(); });
beforeEach(async () => { await env.clearFirestore(); });

const pay = (accountId, extra = {}) => ({ date: '2026-12-06', accountId, ...extra });

describe('lote retomável através dos services', () => {
  it('30 parcelas do mês (2 chamadas de 15): queda de rede NO MEIO → partial + batchId; repetir com a MESMA chave conclui sem duplicar', async () => {
    const io = makeRealIo(env);
    const accountId = await seedAccount(io, '0,00');
    const debtorId = await seedDebtor(io);
    await seedPlan(io, debtorId, '300,00', 1); // 1 parcela no mês; as demais dívidas no mesmo mês abaixo
    for (let i = 0; i < 29; i += 1) await seedPlan(io, debtorId, '10,00', 1, `Dívida ${i}`);
    const bridge = serverBridge(ALICE);
    let calls = 0;
    const flaky = { ...io, finance: async (op, params, options) => {
      calls += 1;
      if (calls === 2) return { ok: false, errors: { _form: 'Falha de rede.' }, code: 'NETWORK_ERROR', retryable: true };
      return bridge(op, params, options);
    } };
    const operationId = 'lote-e2e-1';
    const first = await settleMonthInstallments(ALICE, debtorId, '2026-12', pay(accountId, { operationId }), flaky);
    assert.equal(first.ok, false);
    assert.equal(first.partial, true);
    assert.equal(first.batchId, operationId);
    const midPayments = (await dump(env, 'debtPayments')).length;
    assert.equal(midPayments, 15); // a 1ª chamada gravou 15 parcelas, cada uma em sua transação
    const resumed = await settleMonthInstallments(ALICE, debtorId, '2026-12', pay(accountId, { operationId }), io);
    assert.equal(resumed.ok, true, JSON.stringify(resumed));
    assert.equal(resumed.count, 30);
    const payments = await dump(env, 'debtPayments');
    assert.equal(payments.length, 30); // nada duplicado
    assert.equal(new Set(payments.map((p) => p.debtId)).size, 30);
    const debtor = (await dump(env, 'debtors'))[0];
    assert.deepEqual([debtor.receivedCents, debtor.status], [debtor.lentCents, 'paid']);
    assert.equal(await derivedBalance(io, accountId), payments.reduce((t, p) => t + p.amountCents, 0));
    assert.deepEqual((await auditFinancialIntegrity(ALICE, io)).findings, []);
  });

  it('quitar dívida por grupo e depois estornar UM recebimento pelo service: parcela e devedor reabrem; saldo e auditoria coerentes', async () => {
    const io = makeRealIo(env);
    const accountId = await seedAccount(io, '0,00');
    const debtorId = await seedDebtor(io);
    const plan = await seedPlan(io, debtorId, '300,00', 3);
    const r = await settleDebts(ALICE, debtorId, { groupId: plan.groupId }, pay(accountId), io);
    assert.deepEqual([r.ok, r.count, r.totalCents, r.debtorPaid], [true, 3, 30000, true]);
    const [first] = (await dump(env, 'debtPayments')).sort((a, b) => (a.debtId < b.debtId ? -1 : 1));
    const rev = await createReversal(ALICE, 'debtPayment', first.id, { reason: 'Conta errada' }, io);
    assert.equal(rev.ok, true, JSON.stringify(rev));
    assert.equal((await createReversal(ALICE, 'debtPayment', first.id, { reason: 'de novo' }, io)).code, 'ALREADY_REVERSED');
    assert.equal((await createReversal(ALICE, 'debtPayment', first.id, { reason: 'x' }, io)).ok, false); // motivo curto: recusado no cliente
    const debtor = (await dump(env, 'debtors'))[0];
    assert.deepEqual([debtor.receivedCents, debtor.status], [30000 - first.amountCents, 'open']);
    assert.equal(await derivedBalance(io, accountId), 30000 - first.amountCents);
    assert.equal((await dump(env, 'debtPayments')).length, 3); // histórico intacto
    assert.deepEqual((await auditFinancialIntegrity(ALICE, io)).findings, []);
    const again = await settleInstallment(ALICE, debtorId, { debtId: first.debtId }, pay(accountId), io); // a parcela voltou a ser recebível
    assert.equal(again.ok, true, JSON.stringify(again));
    assert.equal(await derivedBalance(io, accountId), 30000);
  });
});

describe('transferências e contas pelos services', () => {
  it('duplo clique (MESMA operationId) e dois cliques de intenções diferentes: o saldo nunca fica negativo e a auditoria é limpa', async () => {
    const io = makeRealIo(env);
    const a = await seedAccount(io, '100,00');
    const b = await seedAccount(io, '0,00', 'Outro');
    const raw = { fromAccountId: a, toAccountId: b, amountCents: '80,00', date: '2026-12-04', reason: 'x', status: 'confirmed' };
    const dup = await Promise.all([createTransfer(ALICE, { ...raw, operationId: 'clique-0001' }, io), createTransfer(ALICE, { ...raw, operationId: 'clique-0001' }, io)]);
    assert.ok(dup.every((r) => r.ok) && dup[0].id === dup[1].id, JSON.stringify(dup));
    const second = await Promise.all([createTransfer(ALICE, { ...raw, operationId: 'clique-0002' }, io), createTransfer(ALICE, { ...raw, operationId: 'clique-0003' }, io)]);
    assert.equal(second.filter((r) => r.ok).length, 0); // só sobraram R$ 20
    assert.ok(second.every((r) => r.code === 'INSUFFICIENT_BALANCE'));
    assert.equal(await derivedBalance(io, a), 2000);
    assert.equal(await derivedBalance(io, b), 8000);
    assert.deepEqual((await auditFinancialIntegrity(ALICE, io)).findings, []);
  });

  it('arquivar pelo service: conta com histórico não é apagada e a arquivada não recebe transferência', async () => {
    const io = makeRealIo(env);
    const a = await seedAccount(io, '100,00');
    const b = await seedAccount(io, '0,00', 'Outro');
    assert.equal((await createTransfer(ALICE, { fromAccountId: a, toAccountId: b, amountCents: '10,00', date: '2026-12-04', reason: 'x', status: 'confirmed' }, io)).ok, true);
    const refused = await deleteAccount(ALICE, a, io);
    assert.deepEqual([refused.ok, refused.code], [false, 'HAS_HISTORY']);
    assert.equal((await archiveAccount(ALICE, b, io)).ok, true);
    const blocked = await createTransfer(ALICE, { fromAccountId: a, toAccountId: b, amountCents: '1,00', date: '2026-12-04', reason: 'x', status: 'confirmed' }, io);
    assert.deepEqual([blocked.ok, blocked.code], [false, 'ACCOUNT_NOT_ACTIVE']);
    assert.equal((await dump(env, 'accounts')).filter((x) => x.status === 'archived').length, 1);
    const fresh = await createAccount(ALICE, { institution: 'Novo', type: 'checking', initialBalanceCents: '0,00', color: '#000', status: 'active' }, io);
    assert.equal(fresh.ok, true);
  });
});

describe('estornos × agregações (saldo, dashboard, previsão, extrato do devedor, metas, integridade)', () => {
  it('nenhuma agregação conta movimento estornado; todas batem com o oráculo recalculado do cru', async () => {
    const io = makeRealIo(env);
    const accountId = await seedAccount(io, '1.000,00');
    const debtorId = await seedDebtor(io);
    await seedPlan(io, debtorId, '100,00', 1);
    const cat = async (kind) => (await createCategory(ALICE, { name: `C-${kind}`, kind, color: '#123456' }, io)).id;
    const [catE, catI] = [await cat('expense'), await cat('income')];
    const inc = await createIncome(ALICE, { description: 'Salário', categoryId: catI, amountCents: '300,00', expectedDate: '2026-12-02', receivedDate: '2026-12-02', accountId, status: 'received', recurrence: 'none' }, io);
    const exp = await createExpense(ALICE, { description: 'Luz', categoryId: catE, amountCents: '120,00', purchaseDate: '2026-12-01', dueDate: '2026-12-03', paidDate: '2026-12-03', accountId, status: 'paid', recurrence: 'none' }, io);
    const goal = await createGoal(ALICE, { name: 'Viagem', targetCents: '1.000,00' }, io);
    const dep = await depositToGoal(ALICE, goal.id, { amountCents: '200,00', date: '2026-12-04', accountId }, io);
    const rec = await settleInstallment(ALICE, debtorId, { debtId: (await dump(env, 'debts'))[0].id }, pay(accountId, { date: '2026-12-05' }), io);
    for (const r of [inc, exp, goal, dep, rec]) assert.equal(r.ok, true, JSON.stringify(r));
    // antes dos estornos: 1000 + 300 − 120 − 200 + 100 = 1080
    assert.equal(await derivedBalance(io, accountId), 108000);
    for (const [kind, id] of [['income', inc.id], ['expense', exp.id], ['goalTransaction', dep.id], ['debtPayment', rec.id]]) {
      const r = await createReversal(ALICE, kind, id, { reason: 'Auditoria: estorno de teste' }, io);
      assert.equal(r.ok, true, `${kind}: ${JSON.stringify(r)}`);
    }
    // ORÁCULO do cru: só o saldo de abertura (todos os movimentos foram compensados)
    assert.equal(await derivedBalance(io, accountId), 100000);
    const dash = await loadDashboard(ALICE, { list: io.list, month: MONTH, now: NOW, includeDebtors: true });
    assert.equal(dash.totalBalanceCents, 100000);
    assert.equal(dash.result.incomeCents, 0); // receita estornada voltou a prevista
    assert.equal(dash.result.expenseCents, 0); // despesa estornada voltou a pendente
    // previsão: a receita e a despesa estornadas voltam a ser pendentes do mês; a parcela do devedor volta a ser "a receber"
    assert.equal(dash.monthlyForecast.projectedBalanceCents, 100000 + 30000 - 12000 + 10000);
    // extrato do devedor: parcela reaberta (recebido líquido 0)
    const debtor = (await dump(env, 'debtors'))[0];
    const statements = await loadDebtorStatements(ALICE, [debtor], '2026-12', { list: io.list });
    assert.equal(statements.get(debtor.id).totalCents, 10000);
    assert.deepEqual([debtor.receivedCents, debtor.status], [0, 'open']);
    // meta: guardado líquido 0 e a movimentação original continua no histórico
    const rows = await listGoalTransactions(ALICE, goal.id, { list: io.list });
    assert.equal(rows.length, 1);
    assert.equal(goalSavedCents(rows), 0);
    assert.equal((await dump(env, 'debtPayments')).length, 1);
    assert.deepEqual((await auditFinancialIntegrity(ALICE, io)).findings, []);
  });
});
