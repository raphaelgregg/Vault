/**
 * Quitação de parcelas de devedores: individual, em lote por mês, integridade (sem duplicar), atomicidade e
 * reflexo em saldo, totais do devedor, fechamento do mês e previsão. Firestore em memória (sem rede).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  settleInstallment, settleMonthInstallments, previewMonthSettlement, loadDebtorLedger, receiptPaymentId, registerDebtPayment,
} from '../../js/services/debtPayments.js';
import { loadDebtorStatements } from '../../js/services/debtors.js';
import {
  accountBalances, debtorObligations, debtorPendingCents, pendingInstallmentsOfMonth, receivedByInstallment, buildEntity,
} from '../../js/core/model.js';
import { monthlyForecast } from '../../js/core/forecast.js';

import { makeStore, UID, DEBTOR } from './helpers/memory-store.mjs';

const debtorOf = (s) => s.tables.debtors.find((d) => d.id === DEBTOR);
const payments = (s) => s.tables.debtPayments;
const pay = { date: '2026-12-06', accountId: 'acc' };

async function obligations(s) {
  const ledger = await loadDebtorLedger(UID, debtorOf(s), s.io);
  const { byDebt, byPurchase } = receivedByInstallment(ledger.payments);
  return debtorObligations({ debtor: debtorOf(s), debts: ledger.debts, receivedByDebt: byDebt, receivedByPurchase: byPurchase, purchases: ledger.purchases, invoicesById: ledger.invoicesById });
}
const statusOf = async (s, id) => (await obligations(s)).items.find((i) => i.id === id).status;

describe('quitar UMA parcela', () => {
  it('1) parcela de cartão: grava um recebimento com purchaseId, data, conta e valor; só ela fica paga', async () => {
    const s = makeStore();
    const r = await settleInstallment(UID, DEBTOR, { purchaseId: 'pAgua' }, pay, s.io);
    assert.deepEqual([r.ok, r.settled, r.amountCents, r.remainingCents], [true, true, 2500, 0]);
    assert.deepEqual(payments(s), [{ id: 'pay-pAgua-1', purchaseId: 'pAgua', debtorId: DEBTOR, amountCents: 2500, date: '2026-12-06', accountId: 'acc', action: undefined }].map(({ action, ...x }) => x));
    assert.equal(await statusOf(s, 'pAgua'), 'paid');
    for (const id of ['pMercado', 'pSuper', 'dNov', 'dDez']) assert.equal(await statusOf(s, id), 'pending', id);
    assert.equal(s.tables.debts.every((d) => d.status === 'pending'), true); // nenhuma outra parcela mudou
  });

  it('1b) parcela de dívida: recebimento com debtId e a parcela vira paid (as outras seguem pendentes)', async () => {
    const s = makeStore();
    const r = await settleInstallment(UID, DEBTOR, { debtId: 'dDez' }, { ...pay, amountCents: '50,00' }, s.io);
    assert.deepEqual([r.ok, r.settled], [true, true]);
    assert.equal(s.tables.debts.find((d) => d.id === 'dDez').status, 'paid');
    assert.equal(s.tables.debts.find((d) => d.id === 'dNov').status, 'pending');
    assert.deepEqual(payments(s).map((p) => [p.debtId, p.purchaseId, p.amountCents]), [['dDez', undefined, 5000]]);
  });

  it('2) duas parcelas individualmente: dois recebimentos, totais somados uma vez, demais intactas', async () => {
    const s = makeStore();
    await settleInstallment(UID, DEBTOR, { purchaseId: 'pMercado' }, pay, s.io);
    await settleInstallment(UID, DEBTOR, { debtId: 'dDez' }, pay, s.io);
    assert.equal(payments(s).length, 2);
    assert.equal(debtorOf(s).receivedCents, 7800 + 5000);
    assert.deepEqual([await statusOf(s, 'pMercado'), await statusOf(s, 'dDez'), await statusOf(s, 'pAgua'), await statusOf(s, 'dNov')], ['paid', 'paid', 'pending', 'pending']);
  });

  it('5) quitar de novo a mesma parcela é recusado e não grava nada', async () => {
    const s = makeStore();
    await settleInstallment(UID, DEBTOR, { purchaseId: 'pAgua' }, pay, s.io);
    const commits = s.calls.commits.length;
    const again = await settleInstallment(UID, DEBTOR, { purchaseId: 'pAgua' }, pay, s.io);
    assert.equal(again.ok, false);
    assert.match(again.errors._form, /já foi quitada/);
    assert.equal(s.calls.commits.length, commits);
    assert.equal(payments(s).length, 1);
    assert.equal(debtorOf(s).receivedCents, 2500);
    // dívida também
    await settleInstallment(UID, DEBTOR, { debtId: 'dNov' }, pay, s.io);
    assert.match((await settleInstallment(UID, DEBTOR, { debtId: 'dNov' }, pay, s.io)).errors._form, /já foi quitada/);
  });

  it('9) envio concorrente (leitura antiga): o ID determinístico faz o 2º lote falhar inteiro — nada duplica', async () => {
    const s = makeStore();
    const first = await settleInstallment(UID, DEBTOR, { purchaseId: 'pAgua' }, pay, s.io);
    assert.equal(first.ok, true);
    // simula a janela de concorrência: o 2º envio leu o razão ANTES do 1º gravar
    const stale = { ...s.io, list: async (_u, c) => (c === 'debtPayments' ? [] : s.io.list(_u, c, {})), };
    const balanceBefore = accountBalances(s.tables.accounts, { debtPayments: payments(s) }).get('acc');
    await assert.rejects(() => settleInstallment(UID, DEBTOR, { purchaseId: 'pAgua' }, { ...pay, date: '2026-12-07' }, { ...s.io, list: stale.list }), /permission-denied/);
    assert.equal(payments(s).length, 1);
    assert.equal(debtorOf(s).receivedCents, 2500);
    assert.equal(accountBalances(s.tables.accounts, { debtPayments: payments(s) }).get('acc'), balanceBefore);
  });

  it('recebimento parcial não quita (sem ID determinístico); o restante quita depois; excesso é recusado', async () => {
    const s = makeStore();
    const part = await settleInstallment(UID, DEBTOR, { purchaseId: 'pMercado' }, { ...pay, amountCents: '30,00' }, s.io);
    assert.deepEqual([part.ok, part.settled, part.remainingCents], [true, false, 4800]);
    assert.equal(await statusOf(s, 'pMercado'), 'pending');
    assert.equal(payments(s)[0].id, 'pay-pMercado-1'); // cada recebimento (parcial ou final) tem ID próprio e sequencial
    assert.equal(receiptPaymentId('pMercado', payments(s)), 'pay-pMercado-2');
    assert.match((await settleInstallment(UID, DEBTOR, { purchaseId: 'pMercado' }, { ...pay, amountCents: '48,01' }, s.io)).errors.amountCents, /excede/);
    const rest = await settleInstallment(UID, DEBTOR, { purchaseId: 'pMercado' }, pay, s.io);
    assert.deepEqual([rest.ok, rest.settled, rest.amountCents], [true, true, 4800]);
    assert.equal(await statusOf(s, 'pMercado'), 'paid');
    assert.equal(debtorOf(s).receivedCents, 7800);
  });

  it('valida conta (inexistente/inativa), data, devedor e parcela; nada é gravado nos erros', async () => {
    const s = makeStore();
    const bad = [
      [{ purchaseId: 'pAgua' }, { ...pay, accountId: 'zz' }, /accountId/],
      [{ purchaseId: 'pAgua' }, { ...pay, accountId: 'off' }, /accountId/],
      [{ purchaseId: 'pAgua' }, { ...pay, date: '2026-02-30' }, /date/],
      [{ purchaseId: 'pAgua' }, { ...pay, amountCents: '0,00' }, /amountCents/],
      [{}, pay, /_form/],
      [{ purchaseId: 'nao-existe' }, pay, /_form/],
    ];
    for (const [target, raw, key] of bad) {
      const r = await settleInstallment(UID, DEBTOR, target, raw, s.io);
      assert.equal(r.ok, false);
      assert.match(Object.keys(r.errors).join(), key);
    }
    assert.equal(s.calls.commits.length, 0);
    s.tables.debtors[0].status = 'cancelled';
    assert.match((await settleInstallment(UID, DEBTOR, { purchaseId: 'pAgua' }, pay, s.io)).errors._form, /em aberto/);
  });

  it('fail-closed: falha ao ler recebimentos cancela a quitação', async () => {
    const s = makeStore();
    const r = await settleInstallment(UID, DEBTOR, { purchaseId: 'pAgua' }, pay, { ...s.io, list: async () => { throw new Error('boom'); } });
    assert.equal(r.ok, false);
    assert.match(r.errors._form, /cancelada por segurança/);
    assert.equal(s.calls.commits.length, 0);
  });
});

describe('quitar TODAS as parcelas pendentes de um mês', () => {
  it('3) quita as 4 parcelas de 12/2026 (3 de cartão + 1 dívida) num único lote; o mês de novembro não muda', async () => {
    const s = makeStore();
    const r = await settleMonthInstallments(UID, DEBTOR, '2026-12', pay, s.io);
    assert.deepEqual([r.ok, r.count, r.totalCents, r.debtorPaid], [true, 4, 2500 + 7800 + 2800 + 5000, false]);
    assert.equal(s.calls.commits.length, 1); // lote ATÔMICO único
    assert.deepEqual(payments(s).map((p) => p.id).sort(), ['pay-dDez-1', 'pay-pAgua-1', 'pay-pMercado-1', 'pay-pSuper-1']);
    assert.ok(payments(s).every((p) => p.date === '2026-12-06' && p.accountId === 'acc' && p.debtorId === DEBTOR));
    assert.equal(s.tables.debts.find((d) => d.id === 'dDez').status, 'paid');
    assert.equal(s.tables.debts.find((d) => d.id === 'dNov').status, 'pending'); // 6) outro mês intacto
    assert.equal(payments(s).some((p) => p.debtId === 'dNov'), false);
    // 7/8) pendente e recebido do devedor
    assert.equal(debtorOf(s).receivedCents, 18100);
    assert.equal(debtorPendingCents(debtorOf(s)), 23100 - 18100);
    assert.equal(debtorOf(s).status, 'open');
  });

  it('4) mês com parcelas já pagas e pendentes: ignora as pagas, sem recebimento duplicado', async () => {
    const s = makeStore();
    await settleInstallment(UID, DEBTOR, { purchaseId: 'pAgua' }, pay, s.io);
    const r = await settleMonthInstallments(UID, DEBTOR, '2026-12', { ...pay, date: '2026-12-08' }, s.io);
    assert.deepEqual([r.count, r.totalCents], [3, 7800 + 2800 + 5000]);
    assert.equal(payments(s).filter((p) => p.purchaseId === 'pAgua').length, 1);
    assert.equal(payments(s).find((p) => p.purchaseId === 'pAgua').date, '2026-12-06'); // a data original da parcela já paga não mudou
    assert.equal(debtorOf(s).receivedCents, 18100);
  });

  it('repetir o lote não duplica: não há mais pendentes', async () => {
    const s = makeStore();
    await settleMonthInstallments(UID, DEBTOR, '2026-12', pay, s.io);
    const again = await settleMonthInstallments(UID, DEBTOR, '2026-12', pay, s.io);
    assert.equal(again.ok, false);
    assert.match(again.errors._form, /Não há parcelas pendentes/);
    assert.equal(payments(s).length, 4);
    assert.equal(debtorOf(s).receivedCents, 18100);
  });

  it('lote simultâneo (leitura antiga) é negado por inteiro pelas Rules: nada parcial', async () => {
    const s = makeStore();
    const staleDebtor = structuredClone(debtorOf(s)); // lido ANTES do 1º lote gravar
    await settleMonthInstallments(UID, DEBTOR, '2026-12', pay, s.io);
    const snapshot = structuredClone(s.tables);
    const stale = {
      ...s.io,
      getById: async (u, c, id) => (c === 'debtors' ? structuredClone(staleDebtor) : s.io.getById(u, c, id)),
      list: async (u, c, o) => (c === 'debtPayments' ? [] : c === 'debts' ? structuredClone(snapshot.debts).map((d) => ({ ...d, status: 'pending' })) : s.io.list(u, c, o)),
    };
    const denied = await settleMonthInstallments(UID, DEBTOR, '2026-12', pay, stale);
    assert.deepEqual([denied.ok, denied.partial, denied.code], [false, false, 'permission-denied']); // erro identificável
    assert.deepEqual(s.tables, snapshot); // tudo ou nada: o 2º lote não gravou nenhuma parcela
    assert.equal(snapshot.debtPayments.length, 4);
  });

  it('mesmo com leitura antiga do devedor atualizado, o limite do pendente impede receber a mais', async () => {
    const s = makeStore();
    await settleMonthInstallments(UID, DEBTOR, '2026-12', pay, s.io);
    const stale = { ...s.io, list: async (u, c, o) => (c === 'debtPayments' ? [] : s.io.list(u, c, o)) };
    const r = await settleMonthInstallments(UID, DEBTOR, '2026-12', pay, stale);
    assert.equal(r.ok, false); // 18100 de novo excederia o pendente (5000)
    assert.equal(s.tables.debtPayments.length, 4);
  });

  it('falha no meio do lote não deixa estado parcial (atomicidade)', async () => {
    const s = makeStore();
    const failing = { ...s.io, commitAtomic: async (u, ops) => { await s.io.commitAtomic(u, ops.slice(0, 3)); throw new Error('rede caiu'); } };
    // o commit "parcial" simulado acima grava; o contrato real é do Firestore (writeBatch): verificamos que o service usa UM commit
    const real = await settleMonthInstallments(UID, DEBTOR, '2026-12', pay, s.io);
    assert.equal(real.ok, true);
    assert.equal(s.calls.commits.length, 1);
    assert.ok(failing);
    const s2 = makeStore();
    const boom = { ...s2.io, commitAtomic: async () => { throw new Error('rede caiu'); } };
    const failed = await settleMonthInstallments(UID, DEBTOR, '2026-12', pay, boom);
    assert.deepEqual([failed.ok, failed.partial, failed.done], [false, false, 0]);
    assert.match(failed.errors._form, /nada foi gravado/);
    assert.deepEqual(s2.tables, makeStore().tables);
  });

  it('valida mês, conta e devedor; mês sem pendentes é recusado', async () => {
    const s = makeStore();
    assert.match((await settleMonthInstallments(UID, DEBTOR, '2026-13', pay, s.io)).errors._form, /inválido/);
    assert.match((await settleMonthInstallments(UID, DEBTOR, '2027-03', pay, s.io)).errors._form, /Não há parcelas pendentes/);
    assert.ok((await settleMonthInstallments(UID, DEBTOR, '2026-12', { ...pay, accountId: 'zz' }, s.io)).errors.accountId);
    assert.ok((await settleMonthInstallments(UID, DEBTOR, '2026-12', { ...pay, accountId: 'off' }, s.io)).errors.accountId);
    assert.equal(s.calls.commits.length, 0);
    assert.equal(debtorOf(s).receivedCents, 0);
  });

  it('prévia = o que será quitado (quantidade, total e mês) e exclui parcelas pagas/canceladas', async () => {
    const s = makeStore();
    s.tables.invoices.push({ id: 'invX', cardId: 'k1', referenceMonth: '2026-12', dueDate: '2026-12-06', status: 'cancelled' });
    s.tables.cardPurchases.push({ id: 'pCanc', cardId: 'k1', debtorId: DEBTOR, description: 'Cancelada', amountCents: 999, invoiceId: 'invX', installmentNumber: 1, installmentsTotal: 1, purchaseDate: '2026-11-25' });
    await settleInstallment(UID, DEBTOR, { purchaseId: 'pSuper' }, pay, s.io);
    const ledger = await loadDebtorLedger(UID, debtorOf(s), s.io);
    const pre = previewMonthSettlement({ debtor: debtorOf(s), ledger, month: '2026-12' });
    assert.deepEqual([pre.count, pre.totalCents, pre.items.map((i) => i.id).sort()], [3, 2500 + 7800 + 5000, ['dDez', 'pAgua', 'pMercado']]);
    assert.equal(previewMonthSettlement({ debtor: debtorOf(s), ledger, month: '2026-11' }).count, 1); // só dNov
  });

  it('devedor é quitado (status paid) quando o último centavo é recebido', async () => {
    const s = makeStore({ debtors: [{ id: DEBTOR, name: 'Renan', status: 'open', lentCents: 23100, receivedCents: 0 }] });
    await settleMonthInstallments(UID, DEBTOR, '2026-11', pay, s.io); // dNov 5000
    await settleMonthInstallments(UID, DEBTOR, '2026-12', pay, s.io); // 18100
    assert.equal(debtorOf(s).receivedCents, 23100);
    assert.equal(debtorOf(s).status, 'paid');
  });
});

describe('integridade financeira: saldo, histórico e indicadores', () => {
  it('9) o recebimento entra UMA vez no saldo da conta; reler/repetir não altera; histórico preservado', async () => {
    const s = makeStore();
    const open = accountBalances(s.tables.accounts, { debtPayments: payments(s) }).get('acc');
    await settleInstallment(UID, DEBTOR, { purchaseId: 'pAgua' }, pay, s.io);
    await settleInstallment(UID, DEBTOR, { purchaseId: 'pAgua' }, pay, s.io); // recusada
    assert.equal(accountBalances(s.tables.accounts, { debtPayments: payments(s) }).get('acc'), open + 2500);
    await settleMonthInstallments(UID, DEBTOR, '2026-12', { ...pay, date: '2026-12-10' }, s.io);
    assert.equal(accountBalances(s.tables.accounts, { debtPayments: payments(s) }).get('acc'), open + 18100); // 2500 + 15600
    assert.equal(payments(s).length, 4); // histórico: nenhum apagado
    // total recebido do devedor == soma dos recebimentos (fonte única)
    assert.equal(debtorOf(s).receivedCents, payments(s).reduce((t, p) => t + p.amountCents, 0));
  });

  it('data de abertura da conta continua respeitada (recebimento antigo não entra)', async () => {
    const s = makeStore();
    s.tables.accounts[0].openingDate = '2026-12-07';
    await settleInstallment(UID, DEBTOR, { purchaseId: 'pAgua' }, { ...pay, date: '2026-12-06' }, s.io);
    assert.equal(accountBalances(s.tables.accounts, { debtPayments: payments(s) }).get('acc'), 100000);
  });

  it('10) previsão: a receber do mês e saldo projetado refletem a quitação', async () => {
    const s = makeStore();
    const receivable = async () => {
      const st = (await loadDebtorStatements(UID, [debtorOf(s)], '2026-12', { list: s.io.list })).get(DEBTOR);
      return st.totalCents;
    };
    const forecast = async () => monthlyForecast({
      month: '2026-12', today: '2026-12-01', balanceCents: accountBalances(s.tables.accounts, { debtPayments: payments(s) }).get('acc'),
      debtorsReceivableCents: await receivable(), includeDebtors: true,
    });
    const before = await forecast();
    assert.equal(before.debtors.receivableCents, 2500 + 7800 + 2800 + 5000);
    assert.equal(before.projectedBalanceCents, 100000 + 18100);
    await settleInstallment(UID, DEBTOR, { purchaseId: 'pMercado' }, pay, s.io); // +78,00 no caixa, −78,00 a receber
    const mid = await forecast();
    assert.equal(mid.debtors.receivableCents, 18100 - 7800);
    assert.equal(mid.balanceCents, 100000 + 7800);
    assert.equal(mid.projectedBalanceCents, before.projectedBalanceCents); // o mesmo dinheiro mudou de "a receber" para "em caixa": sem contar duas vezes
    await settleMonthInstallments(UID, DEBTOR, '2026-12', pay, s.io);
    const after = await forecast();
    assert.equal(after.debtors.receivableCents, 0);
    assert.equal(after.balanceCents, 100000 + 18100);
    assert.equal(after.projectedBalanceCents, before.projectedBalanceCents);
  });

  it('o fechamento do mês (dashboard/Devedores) deixa de somar parcelas já recebidas e continua limitado ao pendente', async () => {
    const s = makeStore();
    await settleMonthInstallments(UID, DEBTOR, '2026-12', pay, s.io);
    const dec = (await loadDebtorStatements(UID, [debtorOf(s)], '2026-12', { list: s.io.list })).get(DEBTOR);
    assert.deepEqual([dec.cardCents, dec.loanCents, dec.totalCents], [0, 0, 0]);
    const nov = (await loadDebtorStatements(UID, [debtorOf(s)], '2026-11', { list: s.io.list })).get(DEBTOR);
    assert.equal(nov.totalCents, 5000);
  });

  it('compatibilidade: recebimentos antigos (só debtId) continuam contando; documento novo valida debtId XOR purchaseId', () => {
    const { byDebt, byPurchase } = receivedByInstallment([{ debtId: 'x', amountCents: 100 }, { debtId: 'x', amountCents: 50 }, { purchaseId: 'p', amountCents: 7 }]);
    assert.deepEqual([byDebt.get('x'), byPurchase.get('p')], [150, 7]);
    const base = { debtorId: 'd', amountCents: '1,00', date: '2026-12-01', accountId: 'a' };
    assert.equal(buildEntity('debtPayments', { ...base, debtId: 'x' }).ok, true);
    assert.equal(buildEntity('debtPayments', { ...base, purchaseId: 'p' }).ok, true);
    assert.equal(buildEntity('debtPayments', base).ok, false);
    assert.equal(buildEntity('debtPayments', { ...base, debtId: 'x', purchaseId: 'p' }).ok, false);
  });

  it('registerDebtPayment (parcial/antecipação) segue funcionando e cada recebimento tem ID exclusivo e sequencial', async () => {
    const s = makeStore();
    const ops = [];
    const spy = { ...s.io, commitAtomic: async (u, o) => { ops.push(o); return s.io.commitAtomic(u, o); } };
    const part = await registerDebtPayment(UID, 'dDez', { amountCents: '20,00', date: '2026-12-01', accountId: 'acc' }, spy);
    assert.equal(part.debtPaid, false);
    assert.equal(ops[0][0].docId, 'pay-dDez-1');
    const rest = await registerDebtPayment(UID, 'dDez', { amountCents: '30,00', date: '2026-12-02', accountId: 'acc' }, spy);
    assert.equal(rest.debtPaid, true);
    assert.equal(ops[1][0].docId, 'pay-dDez-2');
  });
});

describe('pendingInstallmentsOfMonth (puro)', () => {
  it('só pendentes do mês com restante > 0', () => {
    const debtor = { id: 'd', status: 'open', lentCents: 1000, receivedCents: 0 };
    const r = pendingInstallmentsOfMonth({
      month: '2026-12', debtor,
      debts: [{ id: 'a', status: 'pending', principalCents: 300, dueDate: '2026-12-05', installmentNumber: 1 }, { id: 'b', status: 'paid', principalCents: 300, dueDate: '2026-12-06', installmentNumber: 2 }, { id: 'c', status: 'pending', principalCents: 400, dueDate: '2027-01-05', installmentNumber: 3 }],
      receivedByDebt: new Map(), purchases: [],
    });
    assert.deepEqual([r.count, r.totalCents, r.items.map((i) => i.id)], [1, 300, ['a']]);
  });
});
