/**
 * FASES 3–5 — Despesas/receitas liquidadas, pagamento de fatura e aportes/resgates de metas na camada confiável.
 * Firebase Emulator real, clientes simultâneos de verdade (Promise.all), sem mocks. Concorrência repetida 10×.
 */
import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { adminDb, clearAll, call, callOk, opId, seed, seedAccount, seedCategory, dump, getDoc, oracleBalance, UID, OTHER, seedPurchase } from './helpers/server.mjs';
import { executeOnce } from '../../server/finance/core.mjs';

before(() => adminDb());
beforeEach(clearAll);

const REPEAT = 10;
const repeat = async (fn) => { for (let i = 0; i < REPEAT; i += 1) { await clearAll(); await fn(i); } };
const expense = (id, accountId, amountCents, extra = {}) => seed(UID, 'expenses', id, { description: id, categoryId: 'cat', amountCents, accountId, purchaseDate: '2026-12-01', dueDate: '2026-12-10', status: 'pending', recurrence: 'none', ...extra });
const income = (id, accountId, amountCents, extra = {}) => seed(UID, 'incomes', id, { description: id, categoryId: 'catI', amountCents, accountId, expectedDate: '2026-12-01', status: 'pending', recurrence: 'none', ...extra });
const invoice = async (id, totalCents, extra = {}) => {
  await seed(UID, 'invoices', id, { cardId: 'card', referenceMonth: '2026-12', closingDate: '2026-12-01', dueDate: '2026-12-10', status: 'closed', totalCents, ...extra });
  if (totalCents > 0) await seedPurchase(id, totalCents); // o total a pagar vem das compras
};
const world = async (balance = 10000) => { await seedAccount('A', balance); await seedAccount('B', 50000); await seedCategory('cat', 'expense'); await seedCategory('catI', 'income'); };

describe('despesas e receitas — liquidação no servidor', () => {
  it('pagamento duplicado SIMULTÂNEO da mesma despesa (chaves diferentes): um passa, o outro 409; debitado uma vez (10×)', async () => {
    await repeat(async () => {
      await world(10000); await expense('e1', 'A', 3000);
      const rs = await Promise.all([call(UID, 'expense.pay', opId(), { id: 'e1', date: '2026-12-05' }), call(UID, 'expense.pay', opId(), { id: 'e1', date: '2026-12-05' })]);
      assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409], JSON.stringify(rs));
      assert.equal(rs.find((r) => r.status === 409).body.error, 'INVALID_STATE');
      assert.equal((await getDoc('expenses', 'e1')).status, 'paid');
      assert.equal(await oracleBalance('A'), 7000);
    });
  });

  it('duas despesas de R$ 80 simultâneas com saldo de R$ 100: só uma é paga; saldo nunca negativo (10×)', async () => {
    await repeat(async () => {
      await world(10000); await expense('e1', 'A', 8000); await expense('e2', 'A', 8000);
      const rs = await Promise.all([call(UID, 'expense.pay', opId(), { id: 'e1' }), call(UID, 'expense.pay', opId(), { id: 'e2' })]);
      assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409], JSON.stringify(rs));
      assert.equal(rs.find((r) => r.status === 409).body.error, 'INSUFFICIENT_BALANCE');
      assert.equal(await oracleBalance('A'), 2000);
      assert.equal((await dump('expenses')).filter((e) => e.status === 'paid').length, 1);
    });
  });

  it('saldo insuficiente: 409 e a despesa continua pendente; criar JÁ paga sem saldo não cria nada', async () => {
    await world(1000); await expense('e1', 'A', 5000);
    const r = await call(UID, 'expense.pay', opId(), { id: 'e1' });
    assert.deepEqual([r.status, r.body.error], [409, 'INSUFFICIENT_BALANCE']);
    assert.equal((await getDoc('expenses', 'e1')).status, 'pending');
    const c = await call(UID, 'expense.create', opId(), { description: 'x', categoryId: 'cat', amountCents: 5000, accountId: 'A', purchaseDate: '2026-12-01', dueDate: '2026-12-10', status: 'paid' });
    assert.deepEqual([c.status, c.body.error], [409, 'INSUFFICIENT_BALANCE']);
    assert.equal((await dump('expenses')).length, 1);
    assert.equal(await oracleBalance('A'), 1000);
  });

  it('retry com a MESMA chave (resposta perdida): idempotente, um único débito; mesma chave com outro alvo → 409 OPERATION_ID_REUSED (10×)', async () => {
    await repeat(async () => {
      await world(10000); await expense('e1', 'A', 3000); await expense('e2', 'A', 1000);
      const key = opId('pay');
      const first = await callOk(UID, 'expense.pay', key, { id: 'e1', date: '2026-12-05' });
      const retries = await Promise.all([1, 2, 3].map(() => call(UID, 'expense.pay', key, { id: 'e1', date: '2026-12-05' })));
      assert.ok(retries.every((r) => r.status === 200 && r.body.idempotent === true && r.body.balanceAfterCents === first.balanceAfterCents), JSON.stringify(retries));
      assert.equal((await call(UID, 'expense.pay', key, { id: 'e2', date: '2026-12-05' })).body.error, 'OPERATION_ID_REUSED');
      assert.equal(await oracleBalance('A'), 7000);
      assert.equal((await getDoc('expenses', 'e2')).status, 'pending');
    });
  });

  it('receita recebida duas vezes ao mesmo tempo: uma passa; saldo sobe uma vez (10×)', async () => {
    await repeat(async () => {
      await world(1000); await income('i1', 'A', 4000);
      const rs = await Promise.all([call(UID, 'income.receive', opId(), { id: 'i1' }), call(UID, 'income.receive', opId(), { id: 'i1' }), call(UID, 'income.receive', opId(), { id: 'i1' })]);
      assert.equal(rs.filter((r) => r.status === 200).length, 1, JSON.stringify(rs));
      assert.ok(rs.filter((r) => r.status !== 200).every((r) => r.status === 409 && r.body.error === 'INVALID_STATE'));
      assert.equal(await oracleBalance('A'), 5000);
    });
  });

  it('conta ARQUIVADA/inativa não recebe lançamentos liquidados; conta de OUTRO usuário e categoria incompatível são recusadas', async () => {
    await world(10000);
    await seedAccount('ARQ', 10000, UID, { status: 'archived' });
    await seedAccount('X', 10000, OTHER);
    const base = { description: 'x', categoryId: 'cat', amountCents: 100, purchaseDate: '2026-12-01', dueDate: '2026-12-10', status: 'paid' };
    assert.equal((await call(UID, 'expense.create', opId(), { ...base, accountId: 'ARQ' })).body.error, 'ACCOUNT_NOT_ACTIVE');
    const foreign = await call(UID, 'expense.create', opId(), { ...base, accountId: 'X' });
    assert.deepEqual([foreign.status, foreign.body.error], [404, 'ACCOUNT_NOT_FOUND']);
    const wrongKind = await call(UID, 'expense.create', opId(), { ...base, categoryId: 'catI', accountId: 'A' });
    assert.equal(wrongKind.status >= 400, true);
    assert.equal((await dump('expenses')).length, 0);
    assert.equal((await dump('expenses', OTHER)).length, 0);
  });

  it('falha DEPOIS da gravação e antes da resposta (transação confirmada, cliente sem resposta): a repetição devolve o resultado, nada duplica', async () => {
    await world(10000); await expense('e1', 'A', 3000);
    const key = opId('lost');
    // 1ª execução confirmada pelo banco; o "cliente" descarta a resposta (simula timeout) e repete
    await callOk(UID, 'expense.pay', key, { id: 'e1', date: '2026-12-05' });
    const retry = await callOk(UID, 'expense.pay', key, { id: 'e1', date: '2026-12-05' });
    assert.equal(retry.idempotent, true);
    assert.equal(await oracleBalance('A'), 7000);
    assert.equal((await dump('operations')).filter((o) => o.id === key).length, 1);
  });

  it('falha ENTRE a verificação e a gravação (exceção no apply): a transação inteira é desfeita e a chave NÃO fica "consumida"', async () => {
    await world(10000); await expense('e1', 'A', 3000);
    const key = opId('boom');
    await assert.rejects(() => executeOnce({ db: adminDb(), uid: UID, op: 'expense.pay', operationId: key, params: { id: 'e1' }, deps: {} }, async () => ({
      result: { ok: true },
      apply(c) { c.tx.update(c.ref('expenses', 'e1'), { status: 'paid' }); throw new Error('queda simulada'); },
    })), /queda simulada/);
    assert.equal((await getDoc('expenses', 'e1')).status, 'pending');
    assert.equal(await getDoc('operations', key), null);
    await callOk(UID, 'expense.pay', key, { id: 'e1' }); // a mesma chave agora funciona
    assert.equal(await oracleBalance('A'), 7000);
  });
});

describe('fatura de cartão — pagamento único no servidor', () => {
  it('pagamento duplicado simultâneo por contas DIFERENTES: só um passa; a fatura fica paga uma vez; um único débito (10×)', async () => {
    await repeat(async () => {
      await world(10000); await invoice('inv', 6000);
      const rs = await Promise.all([call(UID, 'invoice.pay', opId(), { invoiceId: 'inv', accountId: 'A' }), call(UID, 'invoice.pay', opId(), { invoiceId: 'inv', accountId: 'B' })]);
      assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409], JSON.stringify(rs));
      const inv = await getDoc('invoices', 'inv');
      assert.equal(inv.status, 'paid');
      const paidBy = rs.find((r) => r.status === 200).body.accountId;
      assert.equal(inv.accountId, paidBy);
      assert.equal((await oracleBalance('A')) + (await oracleBalance('B')), 60000 - 6000);
    });
  });

  it('saldo insuficiente: 409 e a fatura segue fechada; conta inativa e de outro usuário recusadas', async () => {
    await world(1000); await invoice('inv', 6000);
    await seedAccount('ARQ', 99999, UID, { status: 'archived' }); await seedAccount('X', 99999, OTHER);
    assert.equal((await call(UID, 'invoice.pay', opId(), { invoiceId: 'inv', accountId: 'A' })).body.error, 'INSUFFICIENT_BALANCE');
    assert.equal((await call(UID, 'invoice.pay', opId(), { invoiceId: 'inv', accountId: 'ARQ' })).body.error, 'ACCOUNT_NOT_ACTIVE');
    assert.equal((await call(UID, 'invoice.pay', opId(), { invoiceId: 'inv', accountId: 'X' })).status, 404);
    assert.equal((await getDoc('invoices', 'inv')).status, 'closed');
    assert.equal(await oracleBalance('A'), 1000);
  });

  it('retry com a mesma chave devolve o mesmo pagamento (um único débito); fatura paga não paga de novo; zerada é recusada (10×)', async () => {
    await repeat(async () => {
      await world(10000); await invoice('inv', 6000); await invoice('zero', 0, { referenceMonth: '2027-01' });
      const key = opId('inv');
      const rs = await Promise.all([1, 2, 3, 4].map(() => call(UID, 'invoice.pay', key, { invoiceId: 'inv', accountId: 'A' })));
      assert.ok(rs.every((r) => r.status === 200 && r.body.paidCents === 6000), JSON.stringify(rs));
      assert.equal(await oracleBalance('A'), 4000);
      assert.equal((await call(UID, 'invoice.pay', opId(), { invoiceId: 'inv', accountId: 'A' })).body.error, 'INVALID_STATE');
      assert.equal((await call(UID, 'invoice.pay', opId(), { invoiceId: 'zero', accountId: 'A' })).body.error, 'INVALID_STATE');
      assert.equal(await oracleBalance('A'), 4000);
    });
  });

  it('compras no cartão NÃO reduzem o saldo bancário; só o pagamento da fatura (total = soma das parcelas)', async () => {
    await world(10000);
    await seed(UID, 'invoices', 'open', { cardId: 'card', referenceMonth: '2026-12', closingDate: '2026-12-01', dueDate: '2026-12-10', status: 'open' });
    for (const [id, cents] of [['p1', 2500], ['p2', 3500]]) await seed(UID, 'cardPurchases', id, { cardId: 'card', description: id, amountCents: cents, purchaseDate: '2026-11-20', installmentsTotal: 1, installmentNumber: 1, invoiceId: 'open' });
    assert.equal(await oracleBalance('A'), 10000);
    const paid = await callOk(UID, 'invoice.pay', opId(), { invoiceId: 'open', accountId: 'A' });
    assert.equal(paid.paidCents, 6000);
    assert.equal(await oracleBalance('A'), 4000);
  });

  it('fatura × despesa simultâneas disputando o mesmo saldo (R$ 80 cada, saldo R$ 100): só uma passa (10×)', async () => {
    await repeat(async () => {
      await world(10000); await invoice('inv', 8000); await expense('e1', 'A', 8000);
      const rs = await Promise.all([call(UID, 'invoice.pay', opId(), { invoiceId: 'inv', accountId: 'A' }), call(UID, 'expense.pay', opId(), { id: 'e1' })]);
      assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409], JSON.stringify(rs));
      assert.equal(await oracleBalance('A'), 2000);
    });
  });
});

describe('metas — aportes e resgates no servidor', () => {
  const goal = (extra = {}) => seed(UID, 'goals', 'g1', { name: 'Viagem', targetCents: 10000, status: 'active', ...extra });
  const dep = (amountCents, accountId = 'A', extra = {}) => ({ goalId: 'g1', amountCents, date: '2026-12-05', accountId, ...extra });

  it('dois aportes de R$ 80 simultâneos com saldo de R$ 100: um passa; saldo nunca negativo; guardado correto (10×)', async () => {
    await repeat(async () => {
      await world(10000); await goal({ targetCents: 100000 });
      const rs = await Promise.all([call(UID, 'goal.deposit', opId(), dep(8000)), call(UID, 'goal.deposit', opId(), dep(8000))]);
      assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409], JSON.stringify(rs));
      assert.equal(rs.find((r) => r.status === 409).body.error, 'INSUFFICIENT_BALANCE');
      assert.equal(await oracleBalance('A'), 2000);
      assert.equal((await dump('goalTransactions')).length, 1);
    });
  });

  it('aporte × despesa simultâneos (R$ 80 cada, saldo R$ 100): só um passa (10×)', async () => {
    await repeat(async () => {
      await world(10000); await goal({ targetCents: 100000 }); await expense('e1', 'A', 8000);
      const rs = await Promise.all([call(UID, 'goal.deposit', opId(), dep(8000)), call(UID, 'expense.pay', opId(), { id: 'e1' })]);
      assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409], JSON.stringify(rs));
      assert.equal(await oracleBalance('A'), 2000);
    });
  });

  it('retry idempotente (um único aporte); alvo atingido conclui a meta; resgate reabre; resgate acima do guardado recusado (10×)', async () => {
    await repeat(async () => {
      await world(50000); await goal({ targetCents: 10000 });
      const key = opId('dep');
      const rs = await Promise.all([1, 2, 3].map(() => call(UID, 'goal.deposit', key, dep(10000))));
      assert.ok(rs.every((r) => r.status === 200), JSON.stringify(rs));
      assert.equal((await dump('goalTransactions')).length, 1);
      assert.equal((await getDoc('goals', 'g1')).status, 'completed');
      assert.equal(await oracleBalance('A'), 40000);
      assert.equal((await call(UID, 'goal.withdraw', opId(), dep(10001))).body.error, 'INVALID_STATE'); // acima do guardado
      await callOk(UID, 'goal.withdraw', opId(), dep(4000));
      assert.equal((await getDoc('goals', 'g1')).status, 'active');
      assert.equal(await oracleBalance('A'), 44000);
    });
  });

  it('meta cancelada/inexistente/de outro usuário e meta vinculada a conta (sem movimentações) são recusadas', async () => {
    await world(10000);
    await seed(UID, 'goals', 'gc', { name: 'C', targetCents: 100, status: 'cancelled' });
    await seed(UID, 'goals', 'gl', { name: 'L', targetCents: 100000, status: 'active', accountId: 'A' });
    await seed(OTHER, 'goals', 'gx', { name: 'X', targetCents: 100000, status: 'active' });
    for (const goalId of ['gc', 'gl']) assert.equal((await call(UID, 'goal.deposit', opId(), { ...dep(100), goalId })).body.error, 'INVALID_STATE', goalId);
    for (const goalId of ['nao-existe', 'gx']) assert.equal((await call(UID, 'goal.deposit', opId(), { ...dep(100), goalId })).status, 404, goalId);
    assert.equal((await dump('goalTransactions')).length, 0);
    assert.equal(await oracleBalance('A'), 10000);
  });
});

describe('fatura fechada — total NÃO confiável (auditoria final)', () => {
  it('totalCents adulterado na fatura fechada é ignorado: o servidor debita a soma das compras', async () => {
    await seedAccount('A', 100000); await seedAccount('B', 0);
    await seed(UID, 'invoices', 'inv', { cardId: 'c', referenceMonth: '2026-12', closingDate: '2026-12-01', dueDate: '2026-12-10', status: 'closed', totalCents: 1 }); // adulterado (real: 6000)
    for (const [id, cents] of [['p1', 2500], ['p2', 3500]]) await seed(UID, 'cardPurchases', id, { cardId: 'c', description: id, amountCents: cents, purchaseDate: '2026-11-20', installmentsTotal: 1, installmentNumber: 1, invoiceId: 'inv' });
    const r = await callOk(UID, 'invoice.pay', opId(), { invoiceId: 'inv', accountId: 'A' });
    assert.equal(r.paidCents, 6000);
    assert.equal((await getDoc('invoices', 'inv')).paidCents, 6000);
    assert.equal(await oracleBalance('A'), 94000);
  });
});
