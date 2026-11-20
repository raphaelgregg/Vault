/**
 * Idempotência (cenário E), falhas após a gravação (F) e reconciliação/recuperação (G) — Firebase Emulator real.
 * "Falha simulada" = o cliente perde a resposta/cai DEPOIS que o servidor gravou (afterCommit lança) ou a etapa de
 * reconciliação falha; o que fica no Firestore é conferido por leitura crua.
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startEnv, makeRealIo, makeBarrier, dump, attempt, ALICE } from './helpers/real-io.mjs';
import { seedAccount, seedDebtor, seedPlan, oracle, derivedBalance, MONTH } from './helpers/world.mjs';
import { settleInstallment, settleMonthInstallments, reconcileDebtorStatus } from '../../js/services/debtPayments.js';
import { auditFinancialIntegrity } from '../../js/services/integrity.js';

let env;
before(async () => { env = await startEnv(); });
after(async () => { await env?.cleanup(); });
beforeEach(async () => { await env.clearFirestore(); });

const pay = (accountId, extra = {}) => ({ date: '2026-12-06', accountId, ...extra });
const setup = async (total, installments) => {
  const io = makeRealIo(env);
  const accountId = await seedAccount(io);
  const debtorId = await seedDebtor(io);
  const plan = await seedPlan(io, debtorId, total, installments);
  return { io, accountId, debtorId, debtIds: plan.ids };
};
/** Cliente que PERDE a resposta: o servidor gravou, mas a chamada falha (timeout/queda de rede). */
const lostResponse = () => makeRealIo(env, ALICE, { afterCommit: async (ops) => { if (!ops.some((o) => o.action === 'reconcile')) throw Object.assign(new Error('timeout: resposta perdida'), { code: 'deadline-exceeded' }); } });

describe('Cenário E — repetição da mesma operação (timeout, retry, duplo clique)', () => {
  it('duplo clique CONCORRENTE (mesmo operationId): um único recebimento', async () => {
    const { io, accountId, debtorId, debtIds } = await setup('100,00', 1);
    const raw = pay(accountId, { amountCents: '40,00', operationId: 'op-dc-1' });
    const results = await Promise.all([
      attempt(() => settleInstallment(ALICE, debtorId, { debtId: debtIds[0] }, raw, makeRealIo(env))),
      attempt(() => settleInstallment(ALICE, debtorId, { debtId: debtIds[0] }, raw, makeRealIo(env))),
    ]);
    assert.ok(results.some((r) => r.ok), JSON.stringify(results));
    const o = await oracle(env, { accountId, debtorId });
    assert.equal(o.payments.length, 1);
    assert.equal(o.sumPayments, 4000);
    assert.equal(o.received, 4000);
    assert.equal(await derivedBalance(io, accountId), 100000 + 4000);
  });

  it('retry SEQUENCIAL após timeout (o servidor já gravou): mesmo operationId → idempotente, sem 2º recebimento', async () => {
    const { io, accountId, debtorId, debtIds } = await setup('100,00', 1);
    const raw = pay(accountId, { amountCents: '40,00', operationId: 'op-retry-1' });
    const first = await attempt(() => settleInstallment(ALICE, debtorId, { debtId: debtIds[0] }, raw, lostResponse()));
    assert.equal(first.ok, false); // o cliente achou que falhou…
    assert.equal(first.code, 'deadline-exceeded');
    assert.equal((await dump(env, 'debtPayments')).length, 1); // …mas o servidor gravou
    const retry = await settleInstallment(ALICE, debtorId, { debtId: debtIds[0] }, raw, makeRealIo(env));
    assert.equal(retry.ok, true);
    assert.equal(retry.idempotent, true);
    const o = await oracle(env, { accountId, debtorId });
    assert.equal(o.payments.length, 1); // continua UM só
    assert.equal(o.received, 4000);
    assert.equal(await derivedBalance(io, accountId), 100000 + 4000); // saldo +40,00 uma vez
  });

  it('operationId diferente = operação nova legítima (segundo recebimento de R$ 40 é aceito)', async () => {
    const { accountId, debtorId, debtIds } = await setup('100,00', 1);
    await settleInstallment(ALICE, debtorId, { debtId: debtIds[0] }, pay(accountId, { amountCents: '40,00', operationId: 'op-a' }), makeRealIo(env));
    const second = await settleInstallment(ALICE, debtorId, { debtId: debtIds[0] }, pay(accountId, { amountCents: '40,00', operationId: 'op-b' }), makeRealIo(env));
    assert.equal(second.ok, true);
    assert.equal((await oracle(env, { accountId, debtorId })).sumPayments, 8000);
  });

  it('retry da quitação do MÊS após timeout: mesmo operationId → sem recebimentos duplicados', async () => {
    const { io, accountId, debtorId } = await setup('100,00', 1);
    const raw = pay(accountId, { operationId: 'op-month-1' });
    const first = await attempt(() => settleMonthInstallments(ALICE, debtorId, MONTH, raw, lostResponse()));
    assert.equal(first.ok, false);
    const retry = await settleMonthInstallments(ALICE, debtorId, MONTH, raw, makeRealIo(env));
    assert.equal(retry.ok, true);
    assert.equal(retry.idempotent, true);
    const o = await oracle(env, { accountId, debtorId });
    assert.equal(o.payments.length, 1);
    assert.equal(o.received, 10000);
    assert.equal(await derivedBalance(io, accountId), 100000 + 10000);
  });

  it('SEM operationId (chamador legado), um retry após timeout de recebimento PARCIAL grava um 2º recebimento — por isso a tela sempre envia a chave', async () => {
    const { accountId, debtorId, debtIds } = await setup('100,00', 1);
    const raw = pay(accountId, { amountCents: '40,00' });
    await attempt(() => settleInstallment(ALICE, debtorId, { debtId: debtIds[0] }, raw, lostResponse()));
    await settleInstallment(ALICE, debtorId, { debtId: debtIds[0] }, raw, makeRealIo(env));
    const o = await oracle(env, { accountId, debtorId });
    assert.equal(o.payments.length, 2); // indistinguível de dois recebimentos legítimos de R$ 40
    assert.equal(o.sumPayments, 8000);
    assert.equal(o.sumPayments, o.received); // ainda assim consistente e dentro do valor da parcela
  });

  it('retry de recebimento que QUITA (sem operationId): a parcela já paga recusa — nunca duplica', async () => {
    const { io, accountId, debtorId, debtIds } = await setup('100,00', 1);
    await attempt(() => settleInstallment(ALICE, debtorId, { debtId: debtIds[0] }, pay(accountId), lostResponse()));
    const retry = await settleInstallment(ALICE, debtorId, { debtId: debtIds[0] }, pay(accountId), makeRealIo(env));
    assert.equal(retry.ok, false);
    assert.match(retry.errors._form, /já foi quitada|já quitado/);
    assert.equal((await dump(env, 'debtPayments')).length, 1);
    assert.equal(await derivedBalance(io, accountId), 100000 + 10000);
  });
});

describe('Cenário F — falha depois da gravação do recebimento', () => {
  it('o lote é ATÔMICO: recebimento, parcela, devedor e auditoria persistem juntos (resposta perdida não deixa meio-estado)', async () => {
    const { accountId, debtorId, debtIds } = await setup('100,00', 1);
    const r = await attempt(() => settleInstallment(ALICE, debtorId, { debtId: debtIds[0] }, pay(accountId, { operationId: 'op-f1' }), lostResponse()));
    assert.equal(r.ok, false);
    const o = await oracle(env, { accountId, debtorId });
    assert.equal(o.payments.length, 1); // recebimento persistido
    assert.equal(o.received, 10000); // total recebido atualizado no MESMO lote
    assert.equal(o.debts[0].status, 'paid'); // parcela atualizada no MESMO lote
    assert.equal(o.debtor.status, 'paid');
    assert.equal(o.balance, 110000); // saldo (derivado do recebimento) correto
    const audits = await dump(env, 'auditLog');
    assert.ok(audits.some((a) => a.entity === 'debtPayments'));
    assert.deepEqual((await auditFinancialIntegrity(ALICE, makeRealIo(env))).findings, []); // consistente
  });

  it('um lote com UMA escrita rejeitada pelas Rules não persiste NADA (sem recebimento órfão)', async () => {
    const { accountId, debtorId, debtIds } = await setup('100,00', 1);
    // estado adulterado: o devedor já tem tudo recebido → o increment do lote estoura `receivedCents <= lentCents`
    await env.withSecurityRulesDisabled(async (ctx) => {
      const { doc, updateDoc } = await import('firebase/firestore');
      await updateDoc(doc(ctx.firestore(), 'users', ALICE, 'debtors', debtorId), { receivedCents: 10000 });
    });
    const stale = makeRealIo(env);
    const r = await attempt(() => settleInstallment(ALICE, debtorId, { debtId: debtIds[0] }, pay(accountId), {
      ...stale, // lê o devedor "antigo" (pendente 100) — o servidor já está em 100 recebidos
      getById: async (u, c, id) => (c === 'debtors' ? { id, name: 'x', status: 'open', lentCents: 10000, receivedCents: 0 } : stale.getById(u, c, id)),
    }));
    assert.equal(r.ok, false);
    assert.equal(r.code, 'permission-denied'); // erro identificável
    assert.equal((await dump(env, 'debtPayments')).length, 0); // nenhum recebimento persistido
    const debts = await dump(env, 'debts');
    assert.equal(debts[0].status, 'pending'); // parcela intacta
  });
});

describe('Cenário G — falha durante a reconciliação do status do devedor', () => {
  /** Duas parcelas quitadas ao mesmo tempo no pior caso deixam o devedor `open` com recebido == emprestado até a conciliação. */
  const leaveOpenWithZeroPending = async () => {
    const { io, accountId, debtorId, debtIds } = await setup('100,00', 2);
    await env.withSecurityRulesDisabled(async (ctx) => {
      // simula o estado deixado por 2 recebimentos concorrentes cujas leituras não viram "pendente zero"
      const { doc, setDoc, updateDoc } = await import('firebase/firestore');
      const db = ctx.firestore();
      const base = { createdAt: new Date(), updatedAt: new Date() };
      await setDoc(doc(db, 'users', ALICE, 'debtPayments', `pay-${debtIds[0]}-1`), { debtId: debtIds[0], debtorId, amountCents: 5000, date: new Date('2026-12-06T12:00:00Z'), accountId, ...base });
      await setDoc(doc(db, 'users', ALICE, 'debtPayments', `pay-${debtIds[1]}-1`), { debtId: debtIds[1], debtorId, amountCents: 5000, date: new Date('2026-12-06T12:00:00Z'), accountId, ...base });
      await updateDoc(doc(db, 'users', ALICE, 'debts', debtIds[0]), { status: 'paid' });
      await updateDoc(doc(db, 'users', ALICE, 'debts', debtIds[1]), { status: 'paid' });
      await updateDoc(doc(db, 'users', ALICE, 'debtors', debtorId), { receivedCents: 10000 }); // status continua 'open'
    });
    return { io, accountId, debtorId };
  };

  it('a inconsistência é DETECTADA pela auditoria (não é corrigida em silêncio)', async () => {
    const { io, debtorId } = await leaveOpenWithZeroPending();
    const { findings } = await auditFinancialIntegrity(ALICE, io);
    assert.ok(findings.some((f) => f.code === 'DEBTOR_STATUS_OPEN_WITH_ZERO_PENDING' && f.debtorId === debtorId), JSON.stringify(findings));
    assert.equal((await oracle(env, { debtorId })).debtor.status, 'open'); // a auditoria não alterou nada
  });

  it('duas quitações simultâneas + falha na reconciliação: o resultado REPORTA a pendência; a recuperação é segura e idempotente', async () => {
    const { io, accountId, debtorId, debtIds } = await setup('100,00', 2);
    const barrier = makeBarrier(2);
    // cada cliente: espera o outro ler (ambos veem "pendente > 0") e a etapa de reconciliação falha
    const flaky = () => makeRealIo(env, ALICE, { beforeCommit: async (ops) => {
      if (ops.some((o) => o.action === 'reconcile')) throw Object.assign(new Error('rede caiu'), { code: 'unavailable' });
      await barrier();
    } });
    const results = await Promise.all(debtIds.map((id) => settleInstallment(ALICE, debtorId, { debtId: id }, pay(accountId), flaky())));
    assert.deepEqual(results.map((r) => r.ok), [true, true]);
    // o dinheiro está certo, mas o status do devedor ficou para trás — e isso foi REPORTADO, não escondido
    assert.ok(results.some((r) => r.reconcile && r.reconcile.ok === false && r.reconcile.error), JSON.stringify(results.map((r) => r.reconcile)));
    const mid = await oracle(env, { accountId, debtorId });
    assert.equal(mid.received, 10000);
    assert.equal(mid.payments.length, 2);
    assert.equal(mid.pending, 0);
    assert.equal(mid.debtor.status, 'open'); // inconsistência verificável…
    const audit = await auditFinancialIntegrity(ALICE, io);
    assert.ok(audit.findings.some((f) => f.code === 'DEBTOR_STATUS_OPEN_WITH_ZERO_PENDING')); // …detectada
    // recuperação explícita e idempotente
    const rec1 = await reconcileDebtorStatus(ALICE, debtorId, makeRealIo(env));
    const rec2 = await reconcileDebtorStatus(ALICE, debtorId, makeRealIo(env));
    assert.deepEqual([rec1.ok, rec1.changed, rec2.ok, rec2.changed], [true, true, true, false]);
    const o = await oracle(env, { accountId, debtorId });
    assert.equal(o.debtor.status, 'paid');
    assert.equal(o.received, 10000); // a recuperação NÃO duplicou valores
    assert.equal(o.payments.length, 2);
    assert.equal(await derivedBalance(io, accountId), 110000);
    assert.deepEqual((await auditFinancialIntegrity(ALICE, makeRealIo(env))).findings, []);
  });
});
