/**
 * Quitação do mês em BLOCOS (limite real de ~20 acessos a documentos por lote nas Rules) e falha no meio da operação
 * — Firebase Emulator real, Rules reais, sem mocks.
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startEnv, makeRealIo, dump, ALICE } from './helpers/real-io.mjs';
import { seedAccount, seedDebtor, seedPlan, oracle, derivedBalance, MONTH } from './helpers/world.mjs';
import { settleMonthInstallments, RECEIPT_BATCH_SIZE } from '../../js/services/debtPayments.js';
import { registerCardPurchase } from '../../js/services/creditCards.js';
import { createCard } from '../../js/services/creditCards.js';
import { auditFinancialIntegrity } from '../../js/services/integrity.js';

let env;
before(async () => { env = await startEnv(); });
after(async () => { await env?.cleanup(); });
beforeEach(async () => { await env.clearFirestore(); });

const pay = (accountId, extra = {}) => ({ date: '2026-12-06', accountId, ...extra });

/** N dívidas à vista de R$ 10 cada, todas vencendo em dez/2026 (mês de referência). */
async function manyDebts(io, debtorId, n) {
  const ids = [];
  for (let i = 0; i < n; i += 1) ids.push((await seedPlan(io, debtorId, '10,00', 1, `D${i}`)).ids[0]);
  return ids;
}

describe('quitação do mês com mais parcelas que cabem em um lote', () => {
  it(`25 parcelas: gravadas em ${Math.ceil(25 / RECEIPT_BATCH_SIZE)} blocos atômicos; total, status e saldo corretos`, async () => {
    const io = makeRealIo(env);
    const accountId = await seedAccount(io);
    const debtorId = await seedDebtor(io);
    await manyDebts(io, debtorId, 25);
    const r = await settleMonthInstallments(ALICE, debtorId, MONTH, pay(accountId, { operationId: 'op-25' }), makeRealIo(env));
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.count, 25);
    const o = await oracle(env, { accountId, debtorId });
    assert.equal(o.payments.length, 25);
    assert.equal(new Set(o.payments.map((p) => p.id)).size, 25);
    assert.equal(o.received, 25 * 1000);
    assert.equal(o.sumPayments, o.received);
    assert.equal(o.pending, 0);
    assert.equal(o.debtor.status, 'paid');
    assert.ok(o.debts.every((d) => d.status === 'paid'));
    assert.equal(await derivedBalance(io, accountId), 100000 + 25 * 1000);
    assert.deepEqual((await auditFinancialIntegrity(ALICE, io)).findings, []);
  });

  it('falha no 2º bloco: o 1º bloco fica consistente, o erro é identificável e repetir (mesmo operationId) conclui SEM duplicar', async () => {
    const io = makeRealIo(env);
    const accountId = await seedAccount(io);
    const debtorId = await seedDebtor(io);
    await manyDebts(io, debtorId, 25);
    let commits = 0;
    const flaky = makeRealIo(env, ALICE, { beforeCommit: async (ops) => {
      if (ops.some((o) => o.action === 'reconcile')) return;
      commits += 1;
      if (commits === 2) throw Object.assign(new Error('rede caiu no 2º bloco'), { code: 'unavailable' });
    } });
    const first = await settleMonthInstallments(ALICE, debtorId, MONTH, pay(accountId, { operationId: 'op-flaky' }), flaky);
    assert.equal(first.ok, false);
    assert.equal(first.partial, true);
    assert.deepEqual([first.done, first.remaining, first.code], [RECEIPT_BATCH_SIZE, 25 - RECEIPT_BATCH_SIZE, 'unavailable']);
    // estado parcial CONSISTENTE: 10 recebimentos, total recebido = soma, saldo coerente, auditoria limpa
    const mid = await oracle(env, { accountId, debtorId });
    assert.equal(mid.payments.length, RECEIPT_BATCH_SIZE);
    assert.equal(mid.received, RECEIPT_BATCH_SIZE * 1000);
    assert.equal(mid.sumPayments, mid.received);
    assert.equal(mid.debtor.status, 'open');
    assert.equal(mid.debts.filter((d) => d.status === 'paid').length, RECEIPT_BATCH_SIZE);
    assert.deepEqual((await auditFinancialIntegrity(ALICE, io)).findings, []);
    assert.equal(await derivedBalance(io, accountId), 100000 + RECEIPT_BATCH_SIZE * 1000);
    // retry com a MESMA chave: continua de onde parou
    const retry = await settleMonthInstallments(ALICE, debtorId, MONTH, pay(accountId, { operationId: 'op-flaky' }), makeRealIo(env));
    assert.equal(retry.ok, true, JSON.stringify(retry));
    assert.equal(retry.count, 25 - RECEIPT_BATCH_SIZE);
    assert.equal(retry.resumed, true);
    const end = await oracle(env, { accountId, debtorId });
    assert.equal(end.payments.length, 25); // sem duplicar os 10 já gravados
    assert.equal(new Set(end.payments.map((p) => p.id)).size, 25);
    assert.equal(end.received, 25 * 1000);
    assert.equal(end.debtor.status, 'paid');
    assert.equal(await derivedBalance(io, accountId), 100000 + 25 * 1000);
    // e uma 3ª repetição é idempotente (nada pendente)
    const again = await settleMonthInstallments(ALICE, debtorId, MONTH, pay(accountId, { operationId: 'op-flaky' }), makeRealIo(env));
    assert.equal(again.ok, true);
    assert.equal(again.idempotent, true);
    assert.equal((await dump(env, 'debtPayments')).length, 25);
  });

  it('mês misto (parcelas de dívida + parcelas de compra no cartão do devedor) numa só operação', async () => {
    const io = makeRealIo(env);
    const accountId = await seedAccount(io);
    const debtorId = await seedDebtor(io);
    await manyDebts(io, debtorId, 3);
    const card = await createCard(ALICE, { name: 'Cartão', brand: 'Visa', limitCents: '5.000,00', closingDay: 28, dueDay: 5 }, io);
    assert.equal(card.ok, true, JSON.stringify(card));
    for (const [description, amount] of [['Água', '25,00'], ['Mercado', '78,00']]) {
      const r = await registerCardPurchase(ALICE, card.id, { description, amountCents: amount, installmentsTotal: 1, purchaseDate: '2026-11-20', debtorId }, io);
      assert.equal(r.ok, true, JSON.stringify(r));
    }
    const o0 = await oracle(env, { accountId, debtorId });
    const monthOfCard = (await dump(env, 'invoices'))[0].referenceMonth;
    const settle = (month, op) => settleMonthInstallments(ALICE, debtorId, month, pay(accountId, { operationId: op }), makeRealIo(env));
    const a = await settle(monthOfCard, 'op-card');
    const b = await settle(MONTH, 'op-debts');
    assert.ok(a.ok || b.ok, JSON.stringify([a, b]));
    const o = await oracle(env, { accountId, debtorId });
    assert.equal(o.sumPayments, o.received);
    assert.ok(o.payments.some((p) => p.purchaseId) && o.payments.some((p) => p.debtId));
    assert.equal(o.pending, o0.pending - o.sumPayments);
    assert.deepEqual((await auditFinancialIntegrity(ALICE, io)).findings, []);
  });
});
