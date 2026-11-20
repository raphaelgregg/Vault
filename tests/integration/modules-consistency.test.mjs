/**
 * Consistência entre módulos (Bancos, Receitas, Despesas, Transferências, Cartões/Faturas, Devedores, Metas, Dashboard,
 * Previsão) com ORÁCULO INDEPENDENTE sobre os documentos persistidos, mais concorrência em transferências e faturas —
 * Firebase Emulator real. Nenhum valor é conferido "visualmente": tudo é recalculado da leitura crua.
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startEnv, makeRealIo, dump, attempt, ALICE } from './helpers/real-io.mjs';
import { seedDebtor, seedPlan, MONTH, NOW } from './helpers/world.mjs';
import { createAccount } from '../../js/services/accounts.js';
import { createCategory } from '../../js/services/categories.js';
import { createIncome, markIncomeReceived } from '../../js/services/incomes.js';
import { createExpense, markExpensePaid } from '../../js/services/expenses.js';
import { createTransfer, confirmTransfer } from '../../js/services/transfers.js';
import { createCard, registerCardPurchase, payInvoice } from '../../js/services/creditCards.js';
import { createGoal, depositToGoal } from '../../js/services/goals.js';
import { settleInstallment } from '../../js/services/debtPayments.js';
import { loadBalances } from '../../js/services/balances.js';
import { loadDashboard } from '../../js/services/dashboard.js';
import { auditFinancialIntegrity } from '../../js/services/integrity.js';

let env;
before(async () => { env = await startEnv(); });
after(async () => { await env?.cleanup(); });
beforeEach(async () => { await env.clearFirestore(); });

const ok = (r, label) => { assert.equal(r.ok, true, `${label}: ${JSON.stringify(r.errors ?? r)}`); return r; };
const acct = async (io, institution, initial) => ok(await createAccount(ALICE, { institution, name: 'Conta', type: 'checking', initialBalanceCents: initial, color: '#000', status: 'active' }, io), 'conta').id;

/** ORÁCULO: saldo por conta recalculado com laços simples dos documentos crus (independe de accountBalances). */
async function oracleBalances() {
  const [accounts, incomes, expenses, transfers, invoices, payments, goalTx] = await Promise.all(
    ['accounts', 'incomes', 'expenses', 'transfers', 'invoices', 'debtPayments', 'goalTransactions'].map((c) => dump(env, c)));
  const out = {};
  for (const a of accounts) {
    let v = a.initialBalanceCents;
    for (const i of incomes) if (i.status === 'received' && i.accountId === a.id) v += i.amountCents;
    for (const e of expenses) if (e.status === 'paid' && e.accountId === a.id) v -= e.amountCents;
    for (const t of transfers) if (t.status === 'confirmed') { if (t.fromAccountId === a.id) v -= t.amountCents; if (t.toAccountId === a.id) v += t.amountCents; }
    for (const f of invoices) if (f.status === 'paid' && f.accountId === a.id) v -= f.paidCents;
    for (const p of payments) if (p.accountId === a.id) v += p.amountCents;
    for (const g of goalTx) if (g.accountId === a.id) v += g.type === 'deposit' ? -g.amountCents : g.amountCents;
    out[a.id] = v;
  }
  return out;
}

describe('Consistência de saldos e previsão entre módulos (oráculo independente)', () => {
  it('receita, despesa, transferência, fatura paga, recebimento de devedor e meta: saldos, dashboard e previsão == oráculo', async () => {
    const io = makeRealIo(env);
    const A = await acct(io, 'Banco A', '1.000,00');
    const B = await acct(io, 'Banco B', '200,00');
    const incCat = ok(await createCategory(ALICE, { name: 'Salário', kind: 'income', color: '#0a0' }, io), 'cat').id;
    const expCat = ok(await createCategory(ALICE, { name: 'Casa', kind: 'expense', color: '#a00' }, io), 'cat').id;
    // receitas
    const inc1 = ok(await createIncome(ALICE, { description: 'Salário', categoryId: incCat, amountCents: '300,00', expectedDate: '2026-12-02', accountId: A, status: 'pending', recurrence: 'none' }, io), 'inc').id;
    ok(await markIncomeReceived(ALICE, inc1, '2026-12-02', io), 'recebida');
    ok(await createIncome(ALICE, { description: 'Freela', categoryId: incCat, amountCents: '500,00', expectedDate: '2026-12-20', accountId: A, status: 'pending', recurrence: 'none' }, io), 'inc2');
    // despesas
    const exp1 = ok(await createExpense(ALICE, { description: 'Luz', categoryId: expCat, amountCents: '120,00', accountId: A, purchaseDate: '2026-12-01', dueDate: '2026-12-03', status: 'pending', recurrence: 'none' }, io), 'exp').id;
    ok(await markExpensePaid(ALICE, exp1, '2026-12-03', io), 'paga');
    ok(await createExpense(ALICE, { description: 'Água', categoryId: expCat, amountCents: '80,00', accountId: A, purchaseDate: '2026-12-01', dueDate: '2026-12-15', status: 'pending', recurrence: 'none' }, io), 'exp2');
    // transferência A → B
    const tr = ok(await createTransfer(ALICE, { fromAccountId: A, toAccountId: B, amountCents: '150,00', date: '2026-12-04', reason: 'Reserva', status: 'pending' }, io), 'transf').id;
    ok(await confirmTransfer(ALICE, tr, io), 'confirmada');
    // cartões: fatura paga (nov, vence 05/12) e fatura em aberto que vence em dezembro
    const c1 = ok(await createCard(ALICE, { name: 'Cartão 1', brand: 'Visa', limitCents: '5.000,00', closingDay: 28, dueDay: 5 }, io), 'card1').id;
    const c2 = ok(await createCard(ALICE, { name: 'Cartão 2', brand: 'Visa', limitCents: '5.000,00', closingDay: 10, dueDay: 20 }, io), 'card2').id;
    ok(await registerCardPurchase(ALICE, c1, { description: 'Notebook', amountCents: '600,00', installmentsTotal: 3, purchaseDate: '2026-11-20' }, io), 'compra1');
    ok(await registerCardPurchase(ALICE, c2, { description: 'Fone', amountCents: '120,00', installmentsTotal: 1, purchaseDate: '2026-12-02' }, io), 'compra2');
    const invs = await dump(env, 'invoices');
    const novInvoice = invs.find((i) => i.referenceMonth === '2026-11');
    ok(await payInvoice(ALICE, novInvoice.id, { accountId: A, date: '2026-12-05' }, io), 'fatura paga');
    // devedor: dívida de R$ 100 em 2 parcelas; 1 quitada em A
    const debtor = await seedDebtor(io);
    const plan = await seedPlan(io, debtor, '100,00', 2);
    ok(await settleInstallment(ALICE, debtor, { debtId: plan.ids[0] }, { date: '2026-12-06', accountId: A }, io), 'recebimento');
    // meta: aporte de R$ 70 vindo de B
    const goal = ok(await createGoal(ALICE, { name: 'Viagem', targetCents: '1.000,00' }, io), 'meta').id;
    ok(await depositToGoal(ALICE, goal, { amountCents: '70,00', date: '2026-12-06', accountId: B }, io), 'aporte');

    // ---- 1) saldos por conta: oráculo × accountBalances (services) × dashboard ----
    const oracle = await oracleBalances();
    const accounts = await io.list(ALICE, 'accounts', {});
    const fromService = (await loadBalances(ALICE, accounts, { list: io.list })).balances;
    assert.equal(oracle[A], 100000 + 30000 - 12000 - 15000 - 20000 + 5000);
    assert.equal(oracle[B], 20000 + 15000 - 7000);
    assert.equal(fromService.get(A), oracle[A]);
    assert.equal(fromService.get(B), oracle[B]);
    const dash = await loadDashboard(ALICE, { list: io.list, month: MONTH, now: NOW, includeDebtors: true });
    assert.equal(dash.totalBalanceCents, oracle[A] + oracle[B]);
    // transferência não é receita nem despesa; compra no cartão não reduz saldo; só a fatura paga
    assert.equal(dash.result.incomeCents, 30000); // só a receita recebida
    assert.equal(dash.result.expenseCents, 12000); // só a despesa paga (sem transferência, sem fatura, sem compra)

    // ---- 2) previsão: valores recalculados do cru ----
    const [incomes, expenses, purchases, invoices2] = await Promise.all(['incomes', 'expenses', 'cardPurchases', 'invoices'].map((c) => dump(env, c)));
    const pendingIncomes = incomes.filter((i) => i.status === 'pending' && i.expectedDate <= '2026-12-31').reduce((t, i) => t + i.amountCents, 0);
    const pendingExpenses = expenses.filter((e) => e.status === 'pending' && e.dueDate <= '2026-12-31').reduce((t, e) => t + e.amountCents, 0);
    const unpaidInvoices = invoices2.filter((f) => ['open', 'closed'].includes(f.status) && f.dueDate <= '2026-12-31')
      .reduce((t, f) => t + (f.status === 'closed' ? f.totalCents : purchases.filter((p) => p.invoiceId === f.id).reduce((x, p) => x + p.amountCents, 0)), 0);
    const f = dash.monthlyForecast;
    assert.equal(f.incomes.pendingCents, pendingIncomes);
    assert.equal(f.expenses.toPayCents, pendingExpenses);
    assert.equal(f.cards.invoicesToPayCents, unpaidInvoices);
    assert.equal(unpaidInvoices, 12000); // a fatura do Cartão 2 (vence 20/12); a de novembro foi paga e as demais vencem depois
    assert.equal(f.projectedBalanceCents, oracle[A] + oracle[B] + pendingIncomes - pendingExpenses - unpaidInvoices);
    // comprometido em cartões: compras não quitadas (as parcelas de faturas pagas/canceladas saem)
    const settled = new Set(invoices2.filter((x) => ['paid', 'cancelled'].includes(x.status)).map((x) => x.id));
    assert.equal(f.cards.committedCents, purchases.filter((p) => !settled.has(p.invoiceId)).reduce((t, p) => t + p.amountCents, 0));
    assert.equal(f.cards.committedCents, 52000); // notebook 2 × 200 (a de nov foi paga) + fone 120 + ... conferido pelo oráculo acima
    // a receber de devedores: parcela 2 (R$ 50) vence em jan → fora de dezembro
    assert.equal(f.debtors.receivableCents, 0);

    // ---- 3) auditoria de integridade sem diferenças ----
    const audit = await auditFinancialIntegrity(ALICE, io);
    assert.deepEqual(audit.findings, []);
    assert.deepEqual(audit.totals.balances, oracle);
  });
});

describe('Transferências e faturas simultâneas', () => {
  it('duas transferências de R$ 80 de uma conta com R$ 100, simultâneas: UMA passa (servidor); saldo nunca negativo; auditoria limpa', async () => {
    const io = makeRealIo(env);
    const C = await acct(io, 'Banco C', '100,00');
    const D = await acct(io, 'Banco D', '0,00');
    const raw = { fromAccountId: C, toAccountId: D, amountCents: '80,00', date: '2026-12-04', reason: 'x', status: 'confirmed' };
    const results = await Promise.all([0, 1].map(() => attempt(() => createTransfer(ALICE, raw, makeRealIo(env)))));
    assert.equal(results.filter((r) => r.ok).length, 1, JSON.stringify(results));
    assert.equal(results.find((r) => !r.ok).result.code, 'INSUFFICIENT_BALANCE');
    const oracle = await oracleBalances();
    assert.equal(oracle[C], 2000);
    assert.equal(oracle[D], 8000);
    assert.deepEqual((await auditFinancialIntegrity(ALICE, io)).findings, []);
  });

  it('o mesmo envio repetido (duplo clique) com a MESMA operationId cria UM documento; sem chave, cada envio é uma intenção nova', async () => {
    const io = makeRealIo(env);
    const C = await acct(io, 'Banco C', '1.000,00');
    const D = await acct(io, 'Banco D', '0,00');
    const raw = { fromAccountId: C, toAccountId: D, amountCents: '10,00', date: '2026-12-04', reason: 'mesma', status: 'confirmed', operationId: 'clique-0001' };
    const rs = await Promise.all([createTransfer(ALICE, raw, makeRealIo(env)), createTransfer(ALICE, raw, makeRealIo(env))]);
    assert.ok(rs.every((r) => r.ok));
    assert.equal(rs[0].id, rs[1].id);
    assert.equal((await dump(env, 'transfers')).length, 1);
    assert.equal((await oracleBalances())[C], 99000);
  });

  it('confirmar a MESMA transferência pendente duas vezes ao mesmo tempo debita uma única vez (o estado é um só documento)', async () => {
    const io = makeRealIo(env);
    const C = await acct(io, 'Banco C', '100,00');
    const D = await acct(io, 'Banco D', '0,00');
    const tr = ok(await createTransfer(ALICE, { fromAccountId: C, toAccountId: D, amountCents: '30,00', date: '2026-12-04', reason: 'x', status: 'pending' }, io), 't').id;
    await Promise.all([0, 1].map(() => attempt(() => confirmTransfer(ALICE, tr, makeRealIo(env)))));
    const oracle = await oracleBalances();
    assert.equal(oracle[C], 7000);
    assert.equal(oracle[D], 3000);
    assert.equal((await dump(env, 'transfers')).length, 1);
  });

  it('pagamento da MESMA fatura por duas contas ao mesmo tempo: só um passa (transação no servidor); débito único', async () => {
    const io = makeRealIo(env);
    const A = await acct(io, 'Banco A', '1.000,00');
    const B = await acct(io, 'Banco B', '1.000,00');
    const card = ok(await createCard(ALICE, { name: 'Cartão', brand: 'Visa', limitCents: '5.000,00', closingDay: 10, dueDay: 20 }, io), 'card').id;
    ok(await registerCardPurchase(ALICE, card, { description: 'Compra', amountCents: '300,00', installmentsTotal: 1, purchaseDate: '2026-12-02' }, io), 'compra');
    const invoice = (await dump(env, 'invoices'))[0];
    const results = await Promise.all([A, B].map((acc) => attempt(() => payInvoice(ALICE, invoice.id, { accountId: acc, date: '2026-12-06' }, makeRealIo(env)))));
    assert.equal(results.filter((r) => r.ok).length, 1, JSON.stringify(results));
    const rejected = results.find((r) => !r.ok);
    assert.equal(rejected.result.code, 'INVALID_STATE'); // erro identificável: a fatura já está paga
    const paid = (await dump(env, 'invoices'))[0];
    assert.equal(paid.status, 'paid');
    const oracle = await oracleBalances();
    assert.equal(oracle[A] + oracle[B], 200000 - 30000); // exatamente R$ 300 debitados, de UMA conta
    assert.ok(oracle[A] === 100000 || oracle[B] === 100000);
    assert.deepEqual((await auditFinancialIntegrity(ALICE, io)).findings, []);
  });

  it('fatura paga não pode ser alterada depois pelo cliente (trocar a conta moveria dinheiro entre saldos)', async () => {
    const io = makeRealIo(env);
    const A = await acct(io, 'Banco A', '1.000,00');
    const B = await acct(io, 'Banco B', '1.000,00');
    const card = ok(await createCard(ALICE, { name: 'Cartão', brand: 'Visa', limitCents: '5.000,00', closingDay: 10, dueDay: 20 }, io), 'card').id;
    ok(await registerCardPurchase(ALICE, card, { description: 'Compra', amountCents: '300,00', installmentsTotal: 1, purchaseDate: '2026-12-02' }, io), 'compra');
    const invoice = (await dump(env, 'invoices'))[0];
    ok(await payInvoice(ALICE, invoice.id, { accountId: A, date: '2026-12-06' }, io), 'pagar');
    const r = await attempt(() => io.update(ALICE, 'invoices', invoice.id, { accountId: B }));
    assert.equal(r.ok, false);
    assert.equal(r.code, 'permission-denied');
    assert.equal((await dump(env, 'invoices'))[0].accountId, A);
  });
});
