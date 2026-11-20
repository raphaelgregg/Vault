/**
 * FASE 1 — Transferências na camada confiável (Admin SDK + transações), Firebase Emulator real, sem mocks.
 * Operações simultâneas de verdade (Promise.all contra o emulador); cada cenário de concorrência roda 10 vezes.
 */
import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { adminDb, clearAll, call, callOk, opId, seed, seedAccount, seedCategory, dump, getDoc, oracleBalance, UID, OTHER, noon, seedPurchase } from './helpers/server.mjs';
import { executeOnce, FieldValue } from '../../server/finance/core.mjs';

before(() => adminDb());
beforeEach(clearAll);

const T = (from, to, amountCents, extra = {}) => ({ fromAccountId: from, toAccountId: to, amountCents, date: '2026-12-05', reason: 'Teste', ...extra });
const REPEAT = 10;
const repeat = async (fn) => { for (let i = 0; i < REPEAT; i += 1) { await clearAll(); await fn(i); } };

describe('transferências — concorrência real (10 repetições cada)', () => {
  it('duas transferências simultâneas de R$ 80 com saldo de R$ 100: exatamente UMA passa; a outra 409 INSUFFICIENT_BALANCE; saldo nunca negativo', async () => {
    await repeat(async () => {
      await seedAccount('A', 10000); await seedAccount('B', 0);
      const [r1, r2] = await Promise.all([call(UID, 'transfer.create', opId(), T('A', 'B', 8000)), call(UID, 'transfer.create', opId(), T('A', 'B', 8000))]);
      const statuses = [r1.status, r2.status].sort();
      assert.deepEqual(statuses, [200, 409], JSON.stringify([r1, r2]));
      assert.equal([r1, r2].find((r) => r.status === 409).body.error, 'INSUFFICIENT_BALANCE');
      assert.equal((await dump('transfers')).length, 1); // nenhum documento parcial
      assert.equal(await oracleBalance('A'), 2000);
      assert.equal(await oracleBalance('B'), 8000);
    });
  });

  it('transferências válidas simultâneas que cabem no saldo (5 × R$ 20 de R$ 100): todas passam e o saldo fecha em zero', async () => {
    await repeat(async () => {
      await seedAccount('A', 10000); await seedAccount('B', 0);
      const rs = await Promise.all(Array.from({ length: 5 }, () => call(UID, 'transfer.create', opId(), T('A', 'B', 2000))));
      assert.deepEqual(rs.map((r) => r.status), [200, 200, 200, 200, 200], JSON.stringify(rs.filter((r) => r.status !== 200)));
      assert.equal(await oracleBalance('A'), 0);
      assert.equal(await oracleBalance('B'), 10000);
      assert.equal((await dump('transfers')).length, 5);
    });
  });

  it('6 transferências de R$ 20 com saldo de R$ 100 simultâneas: 5 passam, 1 é recusada (nunca negativo)', async () => {
    await repeat(async () => {
      await seedAccount('A', 10000); await seedAccount('B', 0);
      const rs = await Promise.all(Array.from({ length: 6 }, () => call(UID, 'transfer.create', opId(), T('A', 'B', 2000))));
      assert.equal(rs.filter((r) => r.status === 200).length, 5);
      assert.equal(rs.filter((r) => r.status === 409).length, 1);
      assert.equal(await oracleBalance('A'), 0);
    });
  });

  it('transferência e DESPESA simultâneas (R$ 80 cada, saldo R$ 100): só uma passa', async () => {
    await repeat(async () => {
      await seedAccount('A', 10000); await seedAccount('B', 0); await seedCategory('cat', 'expense');
      await seed(UID, 'expenses', 'e1', { description: 'Luz', categoryId: 'cat', amountCents: 8000, accountId: 'A', purchaseDate: '2026-12-01', dueDate: '2026-12-10', status: 'pending', recurrence: 'none' });
      const rs = await Promise.all([call(UID, 'transfer.create', opId(), T('A', 'B', 8000)), call(UID, 'expense.pay', opId(), { id: 'e1', date: '2026-12-05' })]);
      assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409], JSON.stringify(rs));
      assert.equal(await oracleBalance('A'), 2000);
    });
  });

  it('transferência e PAGAMENTO DE FATURA simultâneos (R$ 80 cada, saldo R$ 100): só um passa', async () => {
    await repeat(async () => {
      await seedAccount('A', 10000); await seedAccount('B', 0);
      await seed(UID, 'creditCards', 'k', { name: 'Cartão' });
      await seed(UID, 'invoices', 'inv', { cardId: 'k', referenceMonth: '2026-12', dueDate: '2026-12-20', status: 'closed', totalCents: 8000 });
      await seedPurchase('inv', 8000);
      const rs = await Promise.all([call(UID, 'transfer.create', opId(), T('A', 'B', 8000)), call(UID, 'invoice.pay', opId(), { invoiceId: 'inv', accountId: 'A', date: '2026-12-05' })]);
      assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409], JSON.stringify(rs));
      assert.equal(await oracleBalance('A'), 2000);
    });
  });

  it('confirmar a MESMA transferência pendente duas vezes ao mesmo tempo (chaves diferentes): um débito só', async () => {
    await repeat(async () => {
      await seedAccount('A', 10000); await seedAccount('B', 0);
      const { transferId } = await callOk(UID, 'transfer.create', opId(), T('A', 'B', 3000, { status: 'pending' }));
      assert.equal(await oracleBalance('A'), 10000); // pendente não afeta o saldo realizado
      const rs = await Promise.all([call(UID, 'transfer.confirm', opId(), { transferId }), call(UID, 'transfer.confirm', opId(), { transferId })]);
      assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409]);
      assert.equal(rs.find((r) => r.status === 409).body.error, 'INVALID_STATE');
      assert.equal(await oracleBalance('A'), 7000);
      assert.equal(await oracleBalance('B'), 3000);
    });
  });
});

describe('transferências — idempotência', () => {
  it('retry após timeout (mesmo operationId e parâmetros): mesmo resultado, 1 documento, 1 débito', async () => {
    await seedAccount('A', 10000); await seedAccount('B', 0);
    const key = opId('retry');
    const first = await callOk(UID, 'transfer.create', key, T('A', 'B', 4000));
    const second = await callOk(UID, 'transfer.create', key, T('A', 'B', 4000));
    assert.equal(first.idempotent, false);
    assert.equal(second.idempotent, true);
    assert.equal(second.transferId, first.transferId);
    assert.equal((await dump('transfers')).length, 1);
    assert.equal(await oracleBalance('A'), 6000);
    assert.equal(await oracleBalance('B'), 4000);
  });

  it('duplo clique CONCORRENTE com a mesma chave (10×): um único débito', async () => {
    await repeat(async () => {
      await seedAccount('A', 10000); await seedAccount('B', 0);
      const key = opId('dc');
      const rs = await Promise.all([1, 2, 3, 4].map(() => call(UID, 'transfer.create', key, T('A', 'B', 3000))));
      assert.ok(rs.every((r) => r.status === 200), JSON.stringify(rs.filter((r) => r.status !== 200)));
      assert.equal(new Set(rs.map((r) => r.body.transferId)).size, 1);
      assert.equal((await dump('transfers')).length, 1);
      assert.equal(await oracleBalance('A'), 7000);
    });
  });

  it('mesma chave com PARÂMETROS DIFERENTES é rejeitada (409 OPERATION_ID_REUSED) e não grava nada', async () => {
    await seedAccount('A', 10000); await seedAccount('B', 0);
    const key = opId('reuse');
    await callOk(UID, 'transfer.create', key, T('A', 'B', 1000));
    const r = await call(UID, 'transfer.create', key, T('A', 'B', 2000));
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'OPERATION_ID_REUSED');
    assert.equal((await dump('transfers')).length, 1);
    assert.equal(await oracleBalance('A'), 9000);
    // outra operação com a mesma chave também é rejeitada
    const other = await call(UID, 'transfer.confirm', key, { transferId: 'qualquer' });
    assert.equal(other.body.error, 'OPERATION_ID_REUSED');
  });

  it('a mesma chave em OUTRO usuário é independente (namespace por uid): não vê nem herda o resultado', async () => {
    await seedAccount('A', 10000); await seedAccount('B', 0);
    await seedAccount('A', 10000, OTHER); await seedAccount('B', 0, OTHER);
    const key = opId('shared');
    const mine = await callOk(UID, 'transfer.create', key, T('A', 'B', 1000));
    const theirs = await callOk(OTHER, 'transfer.create', key, T('A', 'B', 1000));
    assert.equal(theirs.idempotent, false);
    assert.notEqual(theirs.transferId, mine.transferId);
    assert.equal((await dump('transfers', OTHER)).length, 1);
    assert.equal((await dump('transfers')).length, 1);
  });
});

describe('transferências — atomicidade e validações', () => {
  it('falha ENTRE o débito e o crédito: a transação inteira é desfeita (nenhum documento parcial)', async () => {
    await seedAccount('A', 10000);
    // a conta de destino não existe: o `touchAccount` do crédito falha no commit, DEPOIS de o documento ter sido enfileirado
    const run = executeOnce({ db: adminDb(), uid: UID, op: 'transfer.create', operationId: opId('atomic'), params: {} }, async (ctx) => ({
      result: { ok: true },
      apply(c) {
        c.tx.create(c.ref('transfers', 't-parcial'), { fromAccountId: 'A', toAccountId: 'fantasma', amountCents: 5000, status: 'confirmed', date: noon('2026-12-05'), reason: 'x', createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
        c.touchAccount('A'); // débito
        c.touchAccount('fantasma'); // crédito: documento inexistente → NOT_FOUND → rollback total
      },
    }));
    await assert.rejects(run);
    assert.equal(await getDoc('transfers', 't-parcial'), null);
    assert.equal((await getDoc('accounts', 'A')).ledgerSeq, undefined); // nem o débito ficou
    assert.equal(await oracleBalance('A'), 10000);
    assert.equal((await dump('operations')).length, 0);
  });

  it('validações: mesma conta, valores inválidos, datas inválidas, conta de OUTRO usuário, conta inativa/arquivada — nada é criado', async () => {
    await seedAccount('A', 10000); await seedAccount('B', 0); await seedAccount('X', 0, UID, { status: 'inactive' }); await seedAccount('Y', 0, UID, { status: 'archived' });
    await seedAccount('C', 99999, OTHER);
    const bad = [
      [T('A', 'A', 100), 400, 'SAME_ACCOUNT'], [T('A', 'B', 0), 400, 'INVALID_AMOUNT'], [T('A', 'B', -5), 400, 'INVALID_AMOUNT'], [T('A', 'B', 10.5), 400, 'INVALID_AMOUNT'],
      [T('A', 'B', '100'), 400, 'INVALID_AMOUNT'], [T('A', 'B', 1e15), 400, 'INVALID_AMOUNT'], [T('A', 'B', 100, { date: '2026-02-30' }), 400, 'INVALID_DATE'],
      [T('A', 'B', 100, { reason: '' }), 400, 'INVALID_PARAM'], [T('A', 'B', 100, { status: 'cancelled' }), 400, 'INVALID_PARAM'],
      [T('A', 'X', 100), 409, 'ACCOUNT_NOT_ACTIVE'], [T('Y', 'B', 100), 409, 'ACCOUNT_NOT_ACTIVE'],
      [T('A', 'C', 100), 404, 'ACCOUNT_NOT_FOUND'], [T('C', 'B', 100), 404, 'ACCOUNT_NOT_FOUND'], [T('A', 'zzz', 100), 404, 'ACCOUNT_NOT_FOUND'],
      [{ ...T('A', 'B', 100), balanceCents: 999999 }, 400, 'FORBIDDEN_PARAM'], [{ ...T('A', 'B', 100), receivedCents: 1 }, 400, 'FORBIDDEN_PARAM'],
    ];
    for (const [params, status, error] of bad) {
      const r = await call(UID, 'transfer.create', opId(), params);
      assert.deepEqual([r.status, r.body.error], [status, error], JSON.stringify(params));
    }
    assert.equal((await dump('transfers')).length, 0);
    assert.equal((await dump('transfers', OTHER)).length, 0);
    assert.equal(await oracleBalance('C', OTHER), 99999); // conta alheia intacta
    assert.equal((await dump('operations')).length, 0); // rejeições não consomem a chave
  });

  it('o resultado e o documento persistido têm o formato do modelo (centavos inteiros, data como Timestamp, status)', async () => {
    await seedAccount('A', 10000); await seedAccount('B', 0);
    const r = await callOk(UID, 'transfer.create', opId(), T('A', 'B', 2500, { notes: 'obs' }));
    assert.deepEqual([r.status, r.fromBalanceAfterCents], ['confirmed', 7500]);
    const doc = await adminDb().doc(`users/${UID}/transfers/${r.transferId}`).get();
    const d = doc.data();
    assert.deepEqual([d.fromAccountId, d.toAccountId, d.amountCents, d.status, d.reason, d.notes], ['A', 'B', 2500, 'confirmed', 'Teste', 'obs']);
    assert.equal(d.date.toDate().toISOString(), '2026-12-05T12:00:00.000Z');
    assert.ok(d.createdAt && d.updatedAt && d.operationId);
    assert.equal(typeof (await getDoc('accounts', 'A')).ledgerSeq, 'number');
  });
});
