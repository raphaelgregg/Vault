/**
 * Recebimentos de devedores — CONCORRÊNCIA REAL no Firebase Emulator (Firestore + Rules reais; sem mocks).
 * Cada operação roda com seu próprio cliente e todas partem ao mesmo tempo (`Promise.all`); no modo "pior caso" uma
 * barreira garante que TODAS leram o estado antigo antes de qualquer gravação. Os documentos persistidos são
 * conferidos por um oráculo independente (leitura crua), não pelos próprios services.
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startEnv, makeRealIo, makeBarrier, dump, attempt, ALICE } from './helpers/real-io.mjs';
import { seedAccount, seedDebtor, seedPlan, oracle, derivedBalance, MONTH, NOW } from './helpers/world.mjs';
import { settleInstallment, settleMonthInstallments } from '../../js/services/debtPayments.js';
import { loadDashboard } from '../../js/services/dashboard.js';

let env;
before(async () => { env = await startEnv(); });
after(async () => { await env?.cleanup(); });
beforeEach(async () => { await env.clearFirestore(); });

const pay = (accountId, extra = {}) => ({ date: '2026-12-06', accountId, ...extra });
/** N clientes independentes; `worst` = barreira que força todos a ler o estado antigo antes de gravar. */
const clients = (n, worst) => {
  const barrier = worst ? makeBarrier(n) : null;
  return Array.from({ length: n }, () => makeRealIo(env, ALICE, barrier ? { beforeCommit: barrier } : {}));
};
const setup = async (total, installments) => {
  const io = makeRealIo(env);
  const accountId = await seedAccount(io);
  const debtorId = await seedDebtor(io);
  const plan = await seedPlan(io, debtorId, total, installments);
  return { io, accountId, debtorId, debtIds: plan.ids };
};

for (const worst of [true, false]) {
  const mode = worst ? 'pior caso (todos leem o estado antigo)' : 'natural (Promise.all)';

  describe(`Cenário A — duas parcelas de R$ 50 quitadas simultaneamente — ${mode}`, () => {
    it('dois recebimentos, total 100,00, saldo devedor 0, dívida paga, saldo +100,00, dashboard coerente', async () => {
      const { io, accountId, debtorId, debtIds } = await setup('100,00', 2);
      const before = await derivedBalance(io, accountId);
      const [c1, c2] = clients(2, worst);
      const results = await Promise.all([
        attempt(() => settleInstallment(ALICE, debtorId, { debtId: debtIds[0] }, pay(accountId), c1)),
        attempt(() => settleInstallment(ALICE, debtorId, { debtId: debtIds[1] }, pay(accountId), c2)),
      ]);
      assert.deepEqual(results.map((r) => r.ok), [true, true], JSON.stringify(results));
      const o = await oracle(env, { accountId, debtorId });
      assert.equal(o.payments.length, 2); // nenhum duplicado
      assert.equal(new Set(o.payments.map((p) => p.id)).size, 2);
      assert.deepEqual(o.payments.map((p) => p.amountCents), [5000, 5000]);
      assert.equal(o.received, 10000);
      assert.equal(o.sumPayments, o.received); // total gravado == soma dos recebimentos
      assert.equal(o.pending, 0);
      assert.equal(o.debtor.status, 'paid');
      assert.deepEqual(o.debts.map((d) => d.status), ['paid', 'paid']);
      assert.equal(await derivedBalance(io, accountId), before + 10000);
      assert.equal((await derivedBalance(io, accountId)), o.balance);
      const dash = await loadDashboard(ALICE, { list: io.list, month: MONTH, now: NOW, includeDebtors: true });
      assert.equal(dash.monthlyForecast.debtors.receivableCents, 0);
      assert.equal(dash.totalBalanceCents, o.balance);
    });
  });

  describe(`Cenário B — dois recebimentos PARCIAIS de R$ 40 simultâneos (2 × R$ 100) — ${mode}`, () => {
    it('dois recebimentos, total 80,00, saldo devedor 120,00, devedor aberto, parcelas pendentes, saldo +80,00', async () => {
      const { io, accountId, debtorId, debtIds } = await setup('200,00', 2);
      const before = await derivedBalance(io, accountId);
      const [c1, c2] = clients(2, worst);
      const results = await Promise.all([
        attempt(() => settleInstallment(ALICE, debtorId, { debtId: debtIds[0] }, pay(accountId, { amountCents: '40,00' }), c1)),
        attempt(() => settleInstallment(ALICE, debtorId, { debtId: debtIds[1] }, pay(accountId, { amountCents: '40,00' }), c2)),
      ]);
      assert.deepEqual(results.map((r) => r.ok), [true, true], JSON.stringify(results));
      const o = await oracle(env, { accountId, debtorId });
      assert.deepEqual(o.payments.map((p) => p.amountCents), [4000, 4000]);
      assert.equal(new Set(o.payments.map((p) => p.id)).size, 2);
      assert.equal(o.received, 8000);
      assert.equal(o.pending, 12000);
      assert.equal(o.debtor.status, 'open');
      assert.deepEqual(o.debts.map((d) => d.status), ['pending', 'pending']); // parcial = pendente com recebido < valor
      assert.deepEqual(Object.values(o.receivedByInstallment).sort(), [4000, 4000]);
      assert.equal(await derivedBalance(io, accountId), before + 8000);
    });
  });

  describe(`Cenário C — recebimentos que totalizariam R$ 120 numa dívida de R$ 100 — ${mode}`, () => {
    it('parcelas 60 + 40: a 60 e a 40 passam; a tentativa extra de 20 na parcela de 60 é rejeitada; nunca passa de 100', async () => {
      const io = makeRealIo(env);
      const accountId = await seedAccount(io);
      const debtorId = await seedDebtor(io);
      // duas dívidas à vista: R$ 60 e R$ 40 (emprestado total 100)
      const a = (await seedPlan(io, debtorId, '60,00', 1, 'A')).ids[0];
      const b = (await seedPlan(io, debtorId, '40,00', 1, 'B')).ids[0];
      const [c1, c2, c3] = clients(3, worst);
      const results = await Promise.all([
        attempt(() => settleInstallment(ALICE, debtorId, { debtId: a }, pay(accountId), c1)), // 60
        attempt(() => settleInstallment(ALICE, debtorId, { debtId: b }, pay(accountId), c2)), // 40
        attempt(() => settleInstallment(ALICE, debtorId, { debtId: a }, pay(accountId, { amountCents: '20,00' }), c3)), // +20 = 120
      ]);
      const oks = results.filter((r) => r.ok).length;
      const o = await oracle(env, { accountId, debtorId });
      assert.ok(o.sumPayments <= 10000, `recebido ${o.sumPayments} acima do devido`);
      assert.ok(o.pending >= 0, 'saldo devedor negativo');
      assert.equal(o.received, o.sumPayments); // sem divergência recebimentos × total recebido
      assert.ok(oks >= 2 && oks <= 3);
      // as rejeitadas têm erro identificável (código do Firestore ou mensagem de negócio), não falha silenciosa
      for (const r of results.filter((x) => !x.ok)) assert.ok(r.code || r.result?.errors, JSON.stringify(r));
      assert.equal(await derivedBalance(io, accountId), 100000 + o.sumPayments);
    });

    it('dívida de R$ 100 em uma parcela: 60 + 60 simultâneos → só um passa; recebido 60; nunca 120', async () => {
      const { io, accountId, debtorId, debtIds } = await setup('100,00', 1);
      const [c1, c2] = clients(2, worst);
      const results = await Promise.all([
        attempt(() => settleInstallment(ALICE, debtorId, { debtId: debtIds[0] }, pay(accountId, { amountCents: '60,00' }), c1)),
        attempt(() => settleInstallment(ALICE, debtorId, { debtId: debtIds[0] }, pay(accountId, { amountCents: '60,00' }), c2)),
      ]);
      assert.equal(results.filter((r) => r.ok).length, 1, JSON.stringify(results));
      const rejected = results.find((r) => !r.ok);
      assert.ok(rejected.code === 'permission-denied' || rejected.result?.errors?.amountCents, JSON.stringify(rejected));
      const o = await oracle(env, { accountId, debtorId });
      assert.equal(o.sumPayments, 6000);
      assert.equal(o.received, 6000);
      assert.equal(o.pending, 4000);
      assert.equal(o.debts[0].status, 'pending');
    });
  });

  describe(`Cenário D — duas operações de R$ 60 na MESMA parcela de R$ 100 — ${mode}`, () => {
    it('total ≤ 100, parcela não quitada indevidamente, sem saldo negativo; a excedente é rejeitada com erro', async () => {
      const { io, accountId, debtorId, debtIds } = await setup('100,00', 1);
      const [c1, c2] = clients(2, worst);
      const results = await Promise.all([
        attempt(() => settleInstallment(ALICE, debtorId, { debtId: debtIds[0] }, pay(accountId, { amountCents: '60,00' }), c1)),
        attempt(() => settleInstallment(ALICE, debtorId, { debtId: debtIds[0] }, pay(accountId, { amountCents: '60,00' }), c2)),
      ]);
      assert.equal(results.filter((r) => r.ok).length, 1);
      const o = await oracle(env, { accountId, debtorId });
      assert.equal(o.payments.length, 1);
      assert.ok(o.sumPayments <= 10000);
      assert.equal(o.debts[0].status, 'pending'); // 60 de 100 não quita
      assert.ok(o.pending >= 0);
      assert.equal(await derivedBalance(io, accountId), 100000 + 6000);
    });
  });
}

describe('Quitação mensal em lote concorrente com recebimentos individuais', () => {
  it('lote do mês × recebimento individual da mesma parcela: nada é recebido duas vezes', async () => {
    const { io, accountId, debtorId, debtIds } = await setup('100,00', 2);
    const [c1, c2] = clients(2, true);
    const results = await Promise.all([
      attempt(() => settleMonthInstallments(ALICE, debtorId, MONTH, pay(accountId), c1)), // dez/2026: parcela 1 (50) [parcela 2 vence em jan]
      attempt(() => settleInstallment(ALICE, debtorId, { debtId: debtIds[0] }, pay(accountId), c2)),
    ]);
    assert.equal(results.filter((r) => r.ok).length, 1, JSON.stringify(results));
    const o = await oracle(env, { accountId, debtorId });
    assert.equal(o.payments.length, 1);
    assert.equal(o.sumPayments, 5000);
    assert.equal(o.received, 5000);
    assert.equal(await derivedBalance(io, accountId), 100000 + 5000);
    assert.equal((await dump(env, 'debtPayments')).length, 1);
  });
});

describe('Estresse — muitas operações simultâneas (pior caso: todas leem o estado antigo)', () => {
  it('8 clientes recebendo R$ 30 NA MESMA parcela de R$ 100: no máximo 3 passam (R$ 90) e os demais são recusados com erro identificável', async () => {
    const { io, accountId, debtorId, debtIds } = await setup('100,00', 1);
    const cs = clients(8, true);
    const results = await Promise.all(cs.map((c) => attempt(() => settleInstallment(ALICE, debtorId, { debtId: debtIds[0] }, pay(accountId, { amountCents: '30,00' }), c))));
    assert.equal(results.filter((r) => r.ok).length, 3, JSON.stringify(results.map((r) => r.ok)));
    assert.equal(results.filter((r) => !r.ok && ['EXCEEDS_REMAINING', 'INVALID_STATE'].includes(r.result?.code)).length, 5, JSON.stringify(results));
    const o = await oracle(env, { accountId, debtorId });
    assert.equal(o.payments.length, 3);
    assert.equal(o.sumPayments, 9000);
    assert.equal(o.received, 9000);
    assert.equal(await derivedBalance(io, accountId), 100000 + 9000);
  });

  it('10 parcelas de R$ 10, 10 clientes quitando uma cada, ao mesmo tempo: 10 recebimentos, total R$ 100, devedor quitado (conciliado), saldo +100', async () => {
    const { io, accountId, debtorId, debtIds } = await setup('100,00', 10);
    const cs = clients(10, true);
    const results = await Promise.all(debtIds.map((id, i) => attempt(() => settleInstallment(ALICE, debtorId, { debtId: id }, pay(accountId), cs[i]))));
    assert.deepEqual(results.map((r) => r.ok), Array(10).fill(true), JSON.stringify(results.filter((r) => !r.ok)));
    const o = await oracle(env, { accountId, debtorId });
    assert.equal(o.payments.length, 10);
    assert.equal(new Set(o.payments.map((p) => p.id)).size, 10);
    assert.equal(o.received, 10000);
    assert.equal(o.sumPayments, o.received);
    assert.equal(o.pending, 0);
    assert.equal(o.debtor.status, 'paid'); // nenhuma operação viu "pendente zero": a conciliação marcou paid
    assert.ok(o.debts.every((d) => d.status === 'paid'));
    assert.equal(await derivedBalance(io, accountId), 100000 + 10000);
  });

  it('12 clientes tentando quitar tudo (cada um 1 parcela diferente + repetição) com excesso: nunca passa do emprestado', async () => {
    const { io, accountId, debtorId, debtIds } = await setup('100,00', 2);
    const cs = clients(12, true);
    // 6 tentativas em cada parcela de R$ 50: apenas 1 por parcela pode gravar; total ≤ 100
    const results = await Promise.all(cs.map((c, i) => attempt(() => settleInstallment(ALICE, debtorId, { debtId: debtIds[i % 2] }, pay(accountId), c))));
    assert.equal(results.filter((r) => r.ok).length, 2);
    const o = await oracle(env, { accountId, debtorId });
    assert.equal(o.sumPayments, 10000);
    assert.equal(o.received, 10000);
    assert.ok(o.pending >= 0);
    assert.equal(await derivedBalance(io, accountId), 100000 + 10000);
  });
});
