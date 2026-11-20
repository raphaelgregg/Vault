/**
 * Camada confiável — validação e roteamento SEM banco (os caminhos que recusam antes de tocar o Firestore) e utilitários
 * puros. As garantias transacionais (saldo, idempotência, concorrência) estão em tests/integration (Firebase Emulator).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { handleFinance, registry } from '../../server/finance/index.mjs';
import { v, requestHash, FinanceError, isTransient } from '../../server/finance/core.mjs';

const verifyIdToken = async (t) => { if (t !== 'good') throw new Error('bad'); return { uid: 'alice' }; };
const call = (over = {}, deps = {}) => handleFinance({ method: 'POST', headers: { authorization: 'Bearer good' }, body: { op: 'transfer.create', operationId: 'op-12345678', params: {}, ...over }, ...over.req }, { db: {}, verifyIdToken, log: () => {}, ...deps });

describe('handleFinance — recusas antes do banco', () => {
  it('método, token ausente/inválido, corpo inválido, operação desconhecida e operationId inválido', async () => {
    assert.equal((await handleFinance({ method: 'GET', headers: {}, body: null }, { db: {}, verifyIdToken, log: () => {} })).status, 405);
    assert.equal((await handleFinance({ method: 'POST', headers: {}, body: {} }, { db: {}, verifyIdToken, log: () => {} })).status, 401);
    assert.equal((await handleFinance({ method: 'POST', headers: { authorization: 'Bearer ruim' }, body: {} }, { db: {}, verifyIdToken, log: () => {} })).status, 401);
    assert.equal((await handleFinance({ method: 'POST', headers: { authorization: 'Bearer good' }, body: '{json quebrado' }, { db: {}, verifyIdToken, log: () => {} })).status, 400);
    assert.ok([400, 404].includes((await call({ op: 'nao.existe' })).status));
    for (const operationId of ['', 'curto', 'espaço no meio 123', 'x'.repeat(101), undefined, 12345678]) assert.equal((await call({ operationId })).status, 400, String(operationId));
  });

  it('parâmetros proibidos (uid, userId, balanceCents, receivedCents) e valores inválidos são recusados (400) sem tocar o banco', async () => {
    for (const forbidden of ['uid', 'userId', 'balanceCents', 'receivedCents']) {
      const r = await call({ params: { [forbidden]: 1, fromAccountId: 'a', toAccountId: 'b', amountCents: 1, date: '2026-12-01', reason: 'x', status: 'confirmed' } });
      assert.deepEqual([r.status, r.body.error], [400, 'FORBIDDEN_PARAM'], forbidden);
    }
    const bad = await call({ params: { fromAccountId: 'a', toAccountId: 'b', amountCents: 10.5, date: '2026-12-01', reason: 'x', status: 'confirmed' } });
    assert.equal(bad.status, 400);
  });

  it('toda operação de dinheiro está registrada no servidor', () => {
    for (const op of ['transfer.create', 'transfer.confirm', 'income.create', 'income.receive', 'expense.create', 'expense.pay', 'invoice.pay', 'goal.deposit', 'goal.withdraw',
      'debt.receive', 'debt.settleBatch', 'debt.cancel', 'reversal.create', 'account.adjustOpening', 'account.archive', 'account.unarchive', 'account.delete', 'debtor.archive', 'debtor.unarchive', 'debtor.delete', 'data.clearOwn']) {
      assert.ok(registry.has?.(op) ?? registry[op], op);
    }
  });
});

describe('validadores e utilitários', () => {
  it('centavos: só inteiros positivos até o teto; datas AAAA-MM-DD reais', () => {
    assert.equal(v.cents(100), 100);
    for (const bad of [0, -1, 1.5, '10', NaN, Infinity, 1e12, null, undefined]) assert.throws(() => v.cents(bad), FinanceError, String(bad));
    assert.equal(v.date('2026-02-28'), '2026-02-28');
    for (const bad of ['2026-02-30', '2026-13-01', '28/02/2026', 20260228, '', null]) assert.throws(() => v.date(bad), FinanceError, String(bad));
  });

  it('requestHash é determinístico, independente da ordem das chaves, e sensível a qualquer mudança', () => {
    const a = requestHash('transfer.create', { x: 1, y: [1, 2], z: { b: 2, a: 1 } });
    assert.equal(a, requestHash('transfer.create', { z: { a: 1, b: 2 }, y: [1, 2], x: 1 }));
    assert.notEqual(a, requestHash('transfer.create', { x: 2, y: [1, 2], z: { a: 1, b: 2 } }));
    assert.notEqual(a, requestHash('transfer.confirm', { x: 1, y: [1, 2], z: { a: 1, b: 2 } }));
    assert.equal(requestHash('o', { a: 1, b: undefined }), requestHash('o', { a: 1 }));
  });

  it('falhas transitórias (contenção/expiração) são repetíveis; erros de negócio não', () => {
    assert.equal(isTransient({ code: 10 }), true);
    assert.equal(isTransient({ code: 14 }), true);
    assert.equal(isTransient({ code: 3, message: '3 INVALID_ARGUMENT: Transaction is invalid or closed.' }), true);
    assert.equal(isTransient({ code: 3, message: 'valor inválido' }), false);
    assert.equal(isTransient(new FinanceError(409, 'INSUFFICIENT_BALANCE', 'x')), false);
  });
});
