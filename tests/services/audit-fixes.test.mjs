/**
 * Correções da auditoria de variáveis/lógica (VF-2-03an): parser de dinheiro pt-BR, coerência status × data de
 * liquidação e transições de estado de despesas/receitas.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseMoneyToCents, centsToMoneyString } from '../../js/core/model.js';
import { normalizeMoneyText } from '../../js/utils/csv.js';
import { createExpense, updateExpense, markExpensePaid, cancelExpense, settleDates as settleExpense } from '../../js/services/expenses.js';
import { createIncome, updateIncome, markIncomeReceived, cancelIncome, settleDates as settleIncome } from '../../js/services/incomes.js';
import { todayInAppZone } from '../../js/utils/dates.js';

const uid = 'u1';

describe('parseMoneyToCents: ponto como milhar (pt-BR)', () => {
  it('"1.234" = R$ 1.234,00 (antes R$ 1,23); "12.345", "999.999" e "1.234.567" idem', () => {
    assert.equal(parseMoneyToCents('1.234'), 123400);
    assert.equal(parseMoneyToCents('1.000'), 100000);
    assert.equal(parseMoneyToCents('12.345'), 1234500);
    assert.equal(parseMoneyToCents('999.999'), 99999900);
    assert.equal(parseMoneyToCents('1.234.567'), 123456700);
    assert.equal(parseMoneyToCents('R$ 1.234'), 123400);
  });

  it('decimais e formatos já aceitos não mudam', () => {
    const same = { '1,5': 150, '1.5': 150, '10.50': 1050, '1234.56': 123456, '1.234,56': 123456, '0,05': 5, '0.5': 50, '0.500': 50, '1234': 123400, '12.34': 1234, '1.00': 100 };
    for (const [text, cents] of Object.entries(same)) assert.equal(parseMoneyToCents(text), cents, text);
    for (const bad of ['', 'abc', '-1', '.5', '5.', '1e3', '1,2,3', '--1']) assert.equal(parseMoneyToCents(bad), null, bad);
    assert.equal(parseMoneyToCents(12.5), 1250); // número = reais
  });

  it('é coerente com o importador de CSV e faz ida e volta com centsToMoneyString', () => {
    for (const text of ['1.234', '12.345', '1.234,56', '1234,5', '1234.56']) {
      assert.equal(parseMoneyToCents(normalizeMoneyText(text)), parseMoneyToCents(text), text);
    }
    for (const c of [0, 1, 99, 100, 123400, 99999900, 123456789]) assert.equal(parseMoneyToCents(centsToMoneyString(c)), c);
  });
});

describe('status × data de liquidação (despesas e receitas)', () => {
  const today = todayInAppZone();
  const expense = (over = {}) => ({ description: 'Luz', categoryId: 'c1', amountCents: '10,00', accountId: 'a1', purchaseDate: '2026-12-01', dueDate: '2026-12-10', status: 'pending', recurrence: 'none', ...over });
  const income = (over = {}) => ({ description: 'Salário', categoryId: 'c1', amountCents: '10,00', accountId: 'a1', expectedDate: '2026-12-05', status: 'pending', recurrence: 'none', ...over });
  const deps = () => {
    const calls = { create: [], update: [] };
    return { calls, io: { lookupCategory: async () => ({ id: 'c1', kind: 'both' }), create: async (_u, _c, d) => { calls.create.push(d); return 'n'; }, update: async (_u, _c, _id, d) => { calls.update.push(d); }, writeAudit: async () => {} } };
  };

  it('settleDates: paga/recebida sempre tem data (padrão hoje); outros status não guardam data', () => {
    assert.equal(settleExpense({ status: 'paid' }, false).paidDate, today);
    assert.equal(settleExpense({ status: 'paid', paidDate: '2026-12-03' }, true).paidDate, '2026-12-03');
    assert.deepEqual(settleExpense({ status: 'pending', paidDate: '2026-12-03', amountCents: 1 }, false), { status: 'pending', amountCents: 1 });
    assert.deepEqual(settleExpense({ status: 'cancelled', paidDate: '2026-12-03' }, true), { status: 'cancelled', paidDate: null });
    assert.equal(settleIncome({ status: 'received' }, false).receivedDate, today);
    assert.deepEqual(settleIncome({ status: 'pending', receivedDate: '2026-12-03' }, true), { status: 'pending', receivedDate: null });
  });

  it('despesa criada como paga sem data ganha paidDate (entra no resultado do mês); pendente descarta data digitada', async () => {
    const a = deps();
    await createExpense(uid, expense({ status: 'paid' }), a.io);
    assert.equal(a.calls.create[0].paidDate, today);
    const b = deps();
    await createExpense(uid, expense({ status: 'pending', paidDate: '2026-12-03' }), b.io);
    assert.equal('paidDate' in b.calls.create[0], false);
  });

  it('editar paga → pendente/cancelada REMOVE a data de pagamento (null → deleteField); paga mantém a informada', async () => {
    const a = deps();
    await updateExpense(uid, 'e1', expense({ status: 'pending' }), a.io);
    assert.equal(a.calls.update[0].paidDate, null);
    const b = deps();
    await updateExpense(uid, 'e1', expense({ status: 'paid', paidDate: '2026-12-04' }), b.io);
    assert.equal(b.calls.update[0].paidDate, '2026-12-04');
  });

  it('receitas: mesma coerência (recebida ganha data; prevista/cancelada removem)', async () => {
    const a = deps();
    await createIncome(uid, income({ status: 'received' }), a.io);
    assert.equal(a.calls.create[0].receivedDate, today);
    const b = deps();
    await updateIncome(uid, 'i1', income({ status: 'cancelled' }), b.io);
    assert.equal(b.calls.update[0].receivedDate, null);
    const c = deps();
    await createIncome(uid, income({ status: 'pending', receivedDate: '2026-12-05' }), c.io);
    assert.equal('receivedDate' in c.calls.create[0], false);
  });
});

describe('transições de estado: só pendente pode ser paga/recebida/cancelada', () => {
  const io = (status) => {
    const calls = { update: [] };
    return { calls, io: { getById: async () => (status ? { id: 'x', status } : null), update: async (_u, _c, _id, d) => { calls.update.push(d); }, writeAudit: async () => {} } };
  };

  it('despesa pendente é paga/cancelada; paga, cancelada e inexistente são recusadas sem escrita', async () => {
    const ok = io('pending');
    assert.equal((await markExpensePaid(uid, 'x', '2026-12-01', ok.io)).ok, true);
    assert.equal((await cancelExpense(uid, 'x', ok.io)).ok, true);
    for (const status of ['paid', 'cancelled', null]) {
      const n = io(status);
      for (const r of [await markExpensePaid(uid, 'x', null, n.io), await cancelExpense(uid, 'x', n.io)]) {
        assert.equal(r.ok, false);
        assert.ok(r.errors._form);
      }
      assert.equal(n.calls.update.length, 0, String(status));
    }
  });

  it('receita prevista é recebida/cancelada; recebida, cancelada e inexistente são recusadas sem escrita', async () => {
    const ok = io('pending');
    assert.equal((await markIncomeReceived(uid, 'x', '2026-12-01', ok.io)).ok, true);
    assert.equal((await cancelIncome(uid, 'x', ok.io)).ok, true);
    for (const status of ['received', 'cancelled', null]) {
      const n = io(status);
      for (const r of [await markIncomeReceived(uid, 'x', null, n.io), await cancelIncome(uid, 'x', n.io)]) {
        assert.equal(r.ok, false);
        assert.ok(r.errors._form);
      }
      assert.equal(n.calls.update.length, 0, String(status));
    }
  });

  it('pagar de novo não altera a data de pagamento original', async () => {
    const paid = io('paid');
    await markExpensePaid(uid, 'x', '2027-01-01', paid.io);
    assert.equal(paid.calls.update.length, 0);
  });
});
