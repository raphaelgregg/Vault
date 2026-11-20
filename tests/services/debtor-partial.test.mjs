/**
 * Pagamentos PARCIAIS de parcelas de devedores × idempotência (VF-2-03al). Cenário obrigatório: parcela de R$ 100,00,
 * recebimento de R$ 40,00 e depois de R$ 60,00. Firestore em memória (lote atômico; `create` em ID existente negado).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { settleInstallment, settleMonthInstallments, loadDebtorLedger, registerDebtPayment } from '../../js/services/debtPayments.js';
import { accountBalances, debtorObligations, debtorPendingCents, receivedByInstallment, installmentPaymentState } from '../../js/core/model.js';
import { makeStore, UID, DEBTOR } from './helpers/memory-store.mjs';

const pay = { date: '2026-12-06', accountId: 'acc' };
/** Uma parcela de cartão e uma de dívida, ambas de R$ 100,00. */
const seed = () => makeStore({
  debtors: [{ id: DEBTOR, name: 'Renan', status: 'open', lentCents: 20000, receivedCents: 0 }],
  invoices: [{ id: 'inv', cardId: 'k1', referenceMonth: '2026-12', dueDate: '2026-12-06', status: 'open' }],
  cardPurchases: [{ id: 'pCard', cardId: 'k1', debtorId: DEBTOR, description: 'Geladeira', amountCents: 10000, invoiceId: 'inv', installmentNumber: 1, installmentsTotal: 1, purchaseDate: '2026-11-20' }],
  debts: [{ id: 'dDebt', debtorId: DEBTOR, description: 'Moto', principalCents: 10000, dueDate: '2026-12-30', installmentNumber: 1, installmentsTotal: 1, debtGroupId: 'g', status: 'pending' }],
});
const debtorOf = (s) => s.tables.debtors.find((d) => d.id === DEBTOR);
const items = async (s) => {
  const ledger = await loadDebtorLedger(UID, debtorOf(s), s.io);
  const r = receivedByInstallment(ledger.payments);
  return debtorObligations({ debtor: debtorOf(s), debts: ledger.debts, receivedByDebt: r.byDebt, receivedByPurchase: r.byPurchase, purchases: ledger.purchases, invoicesById: ledger.invoicesById }).items;
};
const item = async (s, id) => (await items(s)).find((i) => i.id === id);
const balance = (s) => accountBalances(s.tables.accounts, { debtPayments: s.tables.debtPayments }).get('acc');
const target = (kind) => (kind === 'card' ? { purchaseId: 'pCard' } : { debtId: 'dDebt' });
const idOf = (kind) => (kind === 'card' ? 'pCard' : 'dDebt');

for (const kind of ['card', 'debt']) {
  describe(`cenário obrigatório — parcela de R$ 100,00 (${kind === 'card' ? 'cartão' : 'dívida'}): 40,00 + 60,00`, () => {
    it('1–7) parcial → pendente parcial; restante → quitada; 2 recebimentos independentes; total 100,00; saldo +100,00 uma vez', async () => {
      const s = seed();
      const open = balance(s);

      // 1) primeiro recebimento de R$ 40,00
      const first = await settleInstallment(UID, DEBTOR, target(kind), { ...pay, amountCents: '40,00' }, s.io);
      assert.deepEqual([first.ok, first.settled, first.remainingCents], [true, false, 6000]);
      // 2) permanece parcialmente pendente
      const mid = await item(s, idOf(kind));
      assert.deepEqual([mid.status, mid.receivedCents, mid.remainingCents], ['pending', 4000, 6000]);
      assert.equal(mid.paymentState, 'partial');
      assert.equal(debtorOf(s).receivedCents, 4000);
      assert.equal(debtorPendingCents(debtorOf(s)), 16000); // 200 − 40
      assert.equal(balance(s), open + 4000);
      if (kind === 'debt') assert.equal(s.tables.debts[0].status, 'pending');

      // 3) segundo recebimento de R$ 60,00
      const second = await settleInstallment(UID, DEBTOR, target(kind), { ...pay, date: '2026-12-10', amountCents: '60,00' }, s.io);
      assert.deepEqual([second.ok, second.settled, second.remainingCents], [true, true, 0]);
      // 4) quitada
      const done = await item(s, idOf(kind));
      assert.deepEqual([done.status, done.receivedCents, done.remainingCents, done.paymentState], ['paid', 10000, 0, 'paid']);
      if (kind === 'debt') assert.equal(s.tables.debts[0].status, 'paid');
      // 5) dois recebimentos independentes no histórico (IDs distintos, datas e valores próprios)
      const own = s.tables.debtPayments.filter((p) => (kind === 'card' ? p.purchaseId : p.debtId) === idOf(kind));
      assert.equal(own.length, 2);
      assert.equal(new Set(own.map((p) => p.id)).size, 2);
      assert.deepEqual(own.map((p) => [p.amountCents, p.date]).sort(), [[4000, '2026-12-06'], [6000, '2026-12-10']]);
      // 6) total recebido = R$ 100,00 (na parcela e no devedor)
      assert.equal(own.reduce((t, p) => t + p.amountCents, 0), 10000);
      assert.equal(debtorOf(s).receivedCents, 10000);
      // 7) saldo bancário recebeu exatamente R$ 100,00
      assert.equal(balance(s), open + 10000);
    });
  });
}

describe('pagamento parcial: casos de borda', () => {
  it('nunca recebe acima do restante (parcial + excesso) e parcela quitada não aceita mais', async () => {
    const s = seed();
    await settleInstallment(UID, DEBTOR, target('card'), { ...pay, amountCents: '40,00' }, s.io);
    assert.match((await settleInstallment(UID, DEBTOR, target('card'), { ...pay, amountCents: '60,01' }, s.io)).errors.amountCents, /excede/);
    await settleInstallment(UID, DEBTOR, target('card'), { ...pay, amountCents: '60,00' }, s.io);
    assert.match((await settleInstallment(UID, DEBTOR, target('card'), { ...pay, amountCents: '0,01' }, s.io)).errors._form, /já foi quitada/);
    assert.equal(s.tables.debtPayments.length, 2);
  });

  it('vários parciais somam até quitar (10 + 20 + 30 + 40)', async () => {
    const s = seed();
    for (const v of ['10,00', '20,00', '30,00', '40,00']) assert.equal((await settleInstallment(UID, DEBTOR, target('debt'), { ...pay, amountCents: v }, s.io)).ok, true);
    assert.equal((await item(s, 'dDebt')).paymentState, 'paid');
    assert.equal(s.tables.debtPayments.length, 4);
    assert.equal(new Set(s.tables.debtPayments.map((p) => p.id)).size, 4);
    assert.equal(balance(s), 100000 + 10000);
  });

  it('quitação mensal em lote usa só o RESTANTE de parcela com recebimento parcial (sem recobrar o já recebido)', async () => {
    const s = seed();
    await settleInstallment(UID, DEBTOR, target('card'), { ...pay, amountCents: '40,00' }, s.io);
    await settleInstallment(UID, DEBTOR, target('debt'), { ...pay, amountCents: '25,00' }, s.io);
    const r = await settleMonthInstallments(UID, DEBTOR, '2026-12', { ...pay, date: '2026-12-15' }, s.io);
    assert.deepEqual([r.ok, r.count, r.totalCents], [true, 2, 6000 + 7500]); // restantes: cartão 100−40 e dívida 100−25 (ambas no mês 12)
    assert.equal(debtorOf(s).receivedCents, 4000 + 2500 + 13500); // 40 + 25 + (60 + 75) = 200
    assert.equal(debtorOf(s).status, 'paid');
    assert.equal(s.tables.debtPayments.reduce((t, p) => t + p.amountCents, 0), 20000);
  });

  it('registerDebtPayment (caminho antigo) também forma o histórico parcial sem colisão de ID', async () => {
    const s = seed();
    assert.equal((await registerDebtPayment(UID, 'dDebt', { amountCents: '40,00', date: '2026-12-01', accountId: 'acc' }, s.io)).debtPaid, false);
    assert.equal((await registerDebtPayment(UID, 'dDebt', { amountCents: '60,00', date: '2026-12-02', accountId: 'acc' }, s.io)).debtPaid, true);
    assert.equal(s.tables.debtPayments.length, 2);
  });
});

describe('simultaneidade: duas operações lendo o MESMO estado antigo', () => {
  /** io cujas leituras de recebimentos/devedor/dívidas ficam congeladas no instante `snapshot`. */
  const frozen = (s) => {
    const snap = structuredClone(s.tables);
    return {
      ...s.io,
      getById: async (_u, c, id) => structuredClone((snap[c] ?? []).find((r) => r.id === id) ?? null),
      list: async (_u, c, o = {}) => structuredClone((snap[c] ?? []).filter((r) => (o.where ?? []).every(([f, op, v]) => (op === '==' ? r[f] === v : v.includes(r[f]))))),
    };
  };

  it('dois parciais de R$ 60,00 simultâneos NÃO podem somar R$ 120,00 numa parcela de R$ 100,00', async () => {
    const s = seed();
    const staleA = frozen(s);
    const staleB = frozen(s);
    const a = await settleInstallment(UID, DEBTOR, target('card'), { ...pay, amountCents: '60,00' }, staleA);
    assert.equal(a.ok, true);
    // a 2ª operação leu o estado ANTIGO (nada recebido): tenta gravar mais 60,00
    let b;
    try { b = await settleInstallment(UID, DEBTOR, target('card'), { ...pay, amountCents: '60,00' }, { ...staleB, commitAtomic: s.io.commitAtomic }); } catch (e) { b = { ok: false, denied: e.code === 'permission-denied' }; }
    assert.equal(b.ok, false, 'a segunda gravação concorrente deveria ser barrada');
    const received = s.tables.debtPayments.reduce((t, p) => t + p.amountCents, 0);
    assert.equal(received, 6000);
    assert.equal(debtorOf(s).receivedCents, 6000); // total do devedor == soma dos recebimentos
  });

  it('duplo clique no mesmo recebimento parcial (mesma leitura) grava UM só', async () => {
    const s = seed();
    const one = frozen(s);
    const two = frozen(s);
    await settleInstallment(UID, DEBTOR, target('debt'), { ...pay, amountCents: '40,00' }, { ...one, commitAtomic: s.io.commitAtomic });
    let second;
    try { second = await settleInstallment(UID, DEBTOR, target('debt'), { ...pay, amountCents: '40,00' }, { ...two, commitAtomic: s.io.commitAtomic }); } catch (e) { second = { ok: false }; }
    assert.equal(second.ok, false);
    assert.equal(s.tables.debtPayments.length, 1);
    assert.equal(debtorOf(s).receivedCents, 4000);
    assert.equal(balance(s), 100000 + 4000);
  });

  it('parcial concorrente com a quitação do mês: não recebe duas vezes a mesma parcela', async () => {
    const s = seed();
    const stale = frozen(s);
    await settleInstallment(UID, DEBTOR, target('card'), { ...pay, amountCents: '40,00' }, s.io);
    let r;
    try { r = await settleMonthInstallments(UID, DEBTOR, '2026-12', pay, { ...stale, commitAtomic: s.io.commitAtomic }); } catch (e) { r = { ok: false }; }
    assert.equal(r.ok, false);
    assert.equal(s.tables.debtPayments.length, 1);
    assert.equal(debtorOf(s).receivedCents, 4000);
  });

  it('dois recebimentos simultâneos em parcelas DIFERENTES do mesmo devedor: o total do devedor = soma dos recebimentos (sem perda)', async () => {
    const s = seed();
    const staleA = frozen(s);
    const staleB = frozen(s);
    await settleInstallment(UID, DEBTOR, target('debt'), { ...pay, amountCents: '40,00' }, { ...staleA, commitAtomic: s.io.commitAtomic });
    await settleInstallment(UID, DEBTOR, target('card'), { ...pay, amountCents: '30,00' }, { ...staleB, commitAtomic: s.io.commitAtomic });
    const sum = s.tables.debtPayments.reduce((t, p) => t + p.amountCents, 0);
    assert.equal(sum, 7000);
    assert.equal(debtorOf(s).receivedCents, sum, 'a atualização absoluta do devedor perdeu um recebimento');
    assert.equal(balance(s), 100000 + 7000);
  });
});

describe('estado da parcela derivado da soma dos recebimentos', () => {
  it('pendente (0) · parcial (< valor) · paga (= valor); cancelada à parte; nada é gravado no documento', () => {
    assert.equal(installmentPaymentState(10000, 0), 'pending');
    assert.equal(installmentPaymentState(10000, 1), 'partial');
    assert.equal(installmentPaymentState(10000, 9999), 'partial');
    assert.equal(installmentPaymentState(10000, 10000), 'paid');
    assert.equal(installmentPaymentState(10000, 0, 'paid'), 'paid'); // parcela antiga já marcada paga
    assert.equal(installmentPaymentState(10000, 0, 'cancelled'), 'cancelled');
  });

  it('a lista de obrigações expõe paymentState e o mês pendente inclui as parciais (pelo restante)', async () => {
    const s = seed();
    assert.deepEqual((await items(s)).map((i) => i.paymentState), ['pending', 'pending']);
    await settleInstallment(UID, DEBTOR, target('card'), { ...pay, amountCents: '40,00' }, s.io);
    assert.equal((await item(s, 'pCard')).paymentState, 'partial');
    assert.equal((await item(s, 'dDebt')).paymentState, 'pending');
    await settleInstallment(UID, DEBTOR, target('card'), { ...pay, amountCents: '60,00' }, s.io);
    assert.equal((await item(s, 'pCard')).paymentState, 'paid');
  });
});

describe('devedor: status e conciliação', () => {
  it('quitar o último centavo marca o devedor como pago e o status não é reescrito por recebimentos parciais', async () => {
    const s = seed();
    await settleInstallment(UID, DEBTOR, target('card'), { ...pay, amountCents: '100,00' }, s.io);
    assert.equal(debtorOf(s).status, 'open'); // faltam 100 da dívida
    await settleInstallment(UID, DEBTOR, target('debt'), { ...pay, amountCents: '99,99' }, s.io);
    assert.equal(debtorOf(s).status, 'open');
    await settleInstallment(UID, DEBTOR, target('debt'), { ...pay, amountCents: '0,01' }, s.io);
    assert.equal(debtorOf(s).status, 'paid');
    assert.equal(debtorOf(s).receivedCents, 20000);
  });

  it('conciliação: se recebimentos concorrentes alcançam o emprestado e o status ficou open, vira paid (e só então)', async () => {
    const s = seed();
    const racing = { ...s.io, commitAtomic: async (u, ops) => {
      const ids = await s.io.commitAtomic(u, ops);
      // outra operação concorrente (parcela diferente) somou o resto antes desta reler o devedor; nenhuma viu "pendente zero"
      s.tables.debtors[0].receivedCents = 20000;
      return ids;
    } };
    const r = await settleInstallment(UID, DEBTOR, target('card'), { ...pay, amountCents: '100,00' }, racing);
    assert.equal(r.ok, true);
    assert.equal(debtorOf(s).receivedCents, 20000);
    assert.equal(debtorOf(s).status, 'paid'); // conciliado
    // sem alcançar o emprestado, nada é alterado
    const s2 = seed();
    await settleInstallment(UID, DEBTOR, target('card'), { ...pay, amountCents: '100,00' }, s2.io);
    assert.equal(s2.tables.debtors[0].status, 'open');
  });
});
