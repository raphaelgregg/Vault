/** Auditoria de integridade financeira (pura): cada inconsistência gera o código esperado; dados íntegros = sem achados. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { auditLedgerData } from '../../js/core/integrity.js';
import { auditFinancialIntegrity } from '../../js/services/integrity.js';

const base = () => ({
  accounts: [{ id: 'a1', initialBalanceCents: 100000, status: 'active' }],
  debtors: [{ id: 'd1', name: 'Renan', lentCents: 10000, receivedCents: 5000, status: 'open' }],
  debts: [{ id: 'p1', debtorId: 'd1', principalCents: 5000, status: 'paid' }, { id: 'p2', debtorId: 'd1', principalCents: 5000, status: 'pending' }],
  payments: [{ id: 'pay-p1-1', debtId: 'p1', debtorId: 'd1', amountCents: 5000, accountId: 'a1', date: '2026-12-01' }],
});
const codes = (data) => auditLedgerData(data).findings.map((f) => f.code).sort();

describe('auditLedgerData', () => {
  it('dados íntegros: nenhum achado e saldos recomputados', () => {
    const r = auditLedgerData(base());
    assert.deepEqual(r.findings, []);
    assert.equal(r.totals.balances.a1, 105000);
    assert.equal(r.totals.paymentsCents, r.totals.debtorsReceivedCents);
  });

  it('total recebido gravado ≠ soma dos recebimentos; recebido acima do emprestado; devedor quitado com pendente', () => {
    const d = base();
    d.debtors[0] = { ...d.debtors[0], receivedCents: 7000 };
    assert.deepEqual(codes(d), ['DEBTOR_RECEIVED_MISMATCH']);
    d.debtors[0] = { ...d.debtors[0], receivedCents: 12000 };
    assert.ok(codes(d).includes('DEBTOR_RECEIVED_ABOVE_LENT'));
    d.debtors[0] = { ...d.debtors[0], receivedCents: 5000, status: 'paid' };
    assert.ok(codes(d).includes('DEBTOR_STATUS_PAID_WITH_PENDING'));
  });

  it('devedor aberto com pendente zero (estado recuperável) é aviso, não erro', () => {
    const d = base();
    d.payments.push({ id: 'pay-p2-1', debtId: 'p2', debtorId: 'd1', amountCents: 5000, accountId: 'a1' });
    d.debts[1].status = 'paid';
    d.debtors[0].receivedCents = 10000;
    const r = auditLedgerData(d);
    assert.deepEqual(r.findings.map((f) => [f.code, f.severity]), [['DEBTOR_STATUS_OPEN_WITH_ZERO_PENDING', 'warning']]);
  });

  it('parcela recebida acima do valor, status inconsistentes e recebimento sem parcela/devedor/conta', () => {
    const d = base();
    d.payments.push({ id: 'x1', debtId: 'p1', debtorId: 'd1', amountCents: 1, accountId: 'a1' });
    assert.ok(codes(d).includes('INSTALLMENT_OVERPAID'));
    const e = base();
    e.debts[1].status = 'paid';
    assert.ok(codes(e).includes('DEBT_PAID_BUT_REMAINING'));
    const f = base();
    f.debts[0].status = 'pending';
    assert.ok(codes(f).includes('DEBT_PENDING_BUT_FULLY_RECEIVED'));
    const g = base();
    g.payments.push({ id: 'o1', debtId: 'sumiu', debtorId: 'd1', amountCents: 1, accountId: 'a1' }, { id: 'o2', debtId: 'p1', debtorId: 'sumiu', amountCents: 1, accountId: 'a1' }, { id: 'o3', debtId: 'p2', debtorId: 'd1', amountCents: 1, accountId: 'sumiu' });
    const c = codes(g);
    for (const code of ['PAYMENT_ORPHAN_DEBT', 'PAYMENT_ORPHAN_DEBTOR', 'PAYMENT_ORPHAN_ACCOUNT', 'ORPHAN_MOVEMENTS']) assert.ok(c.includes(code), code);
  });

  it('recebimento sem alvo ou com os dois alvos, de outro devedor, valor inválido e operação duplicada', () => {
    const d = base();
    d.payments.push({ id: 'b1', debtorId: 'd1', amountCents: 10, accountId: 'a1' }, { id: 'b2', debtId: 'p2', purchaseId: 'pc', debtorId: 'd1', amountCents: 10, accountId: 'a1' },
      { id: 'b3', debtId: 'p2', debtorId: 'outro', amountCents: 10, accountId: 'a1' }, { id: 'b4', debtId: 'p2', debtorId: 'd1', amountCents: 0, accountId: 'a1' },
      { id: 'op1', debtId: 'p2', debtorId: 'd1', amountCents: 1, accountId: 'a1', operationId: 'X' }, { id: 'op2', debtId: 'p2', debtorId: 'd1', amountCents: 1, accountId: 'a1', operationId: 'X' });
    const c = codes(d);
    for (const code of ['PAYMENT_BAD_TARGET', 'PAYMENT_DEBTOR_MISMATCH', 'PAYMENT_INVALID_AMOUNT', 'DUPLICATE_OPERATION']) assert.ok(c.includes(code), code);
  });

  it('faturas, transferências e saldos: fatura paga sem conta, fechada com total divergente, transferência para a mesma conta/órfã e saldo negativo', () => {
    const r = auditLedgerData({
      accounts: [{ id: 'a1', initialBalanceCents: 100, status: 'active' }],
      invoices: [{ id: 'i1', status: 'paid', paidCents: 50, totalCents: 60 }, { id: 'i2', status: 'closed', totalCents: 10 }],
      purchases: [{ id: 'c1', invoiceId: 'i2', amountCents: 99 }],
      transfers: [{ id: 't1', fromAccountId: 'a1', toAccountId: 'a1', status: 'confirmed', amountCents: 500 }, { id: 't2', fromAccountId: 'a1', toAccountId: 'zz', status: 'confirmed', amountCents: 1 }],
    });
    const c = r.findings.map((f) => f.code);
    for (const code of ['INVOICE_PAID_WITHOUT_ACCOUNT', 'INVOICE_PAID_AMOUNT_MISMATCH', 'INVOICE_CLOSED_TOTAL_MISMATCH', 'TRANSFER_SAME_ACCOUNT', 'TRANSFER_ORPHAN_ACCOUNT']) assert.ok(c.includes(code), code);
    assert.equal(r.errors + r.warnings, r.findings.length);
  });
});

describe('auditFinancialIntegrity (serviço)', () => {
  it('lê as coleções com limite, sinaliza truncamento e propaga falha de leitura (nunca "verde" sem ler)', async () => {
    const calls = [];
    const io = { list: async (_u, c, o) => { calls.push([c, o.limit]); return c === 'incomes' ? Array.from({ length: 1000 }, (_, i) => ({ id: `i${i}`, status: 'pending' })) : []; } };
    const r = await auditFinancialIntegrity('u', io);
    assert.deepEqual(r.truncated, ['incomes']);
    assert.equal(calls.length, 11);
    assert.ok(calls.every(([, limit]) => limit === 1000));
    await assert.rejects(() => auditFinancialIntegrity('u', { list: async () => { throw new Error('boom'); } }), /boom/);
  });
});
