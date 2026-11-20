/**
 * Cliente da camada financeira confiável (VF-ARQ-02): ID token, `operationId` preservado em retry, timeout, renovação de
 * token, deduplicação de envio em voo, erros reais do servidor e adaptador `financeResult`. `fetch`/`getToken`/`sleep` injetados.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { callFinance, financeResult, FinanceApiError, newOperationId } from '../../js/services/financeApi.js';
import { createReversal, listReversals, REVERSAL_KINDS } from '../../js/services/reversals.js';

const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const noSleep = async () => {};
const base = (fetch, extra = {}) => ({ fetch, getToken: async () => 'tok', sleep: noSleep, ...extra });

describe('callFinance', () => {
  it('envia POST com Bearer do ID token e corpo { op, operationId, params } — sem uid', async () => {
    const seen = [];
    const fetch = async (url, init) => { seen.push({ url, init }); return json(200, { ok: true, id: 'x' }); };
    const r = await callFinance('expense.pay', { id: 'e1' }, base(fetch, { operationId: 'op-123456789' }));
    assert.equal(r.id, 'x');
    assert.equal(seen[0].url, '/api/finance');
    assert.equal(seen[0].init.method, 'POST');
    assert.equal(seen[0].init.headers.authorization, 'Bearer tok');
    assert.deepEqual(JSON.parse(seen[0].init.body), { op: 'expense.pay', operationId: 'op-123456789', params: { id: 'e1' } });
  });

  it('503/rede: repete com a MESMA operationId até o limite e depois falha com erro identificável; 409 não é repetido', async () => {
    const ids = [];
    let n = 0;
    const flaky = async (_u, init) => { ids.push(JSON.parse(init.body).operationId); n += 1; return n < 3 ? json(503, { ok: false, error: 'TEMPORARILY_UNAVAILABLE', message: 'Falha temporária' }) : json(200, { ok: true, v: 1 }); };
    const r = await callFinance('transfer.create', {}, base(flaky, { operationId: 'op-abcdefgh' }));
    assert.equal(r.v, 1);
    assert.deepEqual(ids, ['op-abcdefgh', 'op-abcdefgh', 'op-abcdefgh']);

    let calls = 0;
    const conflict = async () => { calls += 1; return json(409, { ok: false, error: 'INSUFFICIENT_BALANCE', message: 'Saldo insuficiente.' }); };
    await assert.rejects(() => callFinance('transfer.create', {}, base(conflict)), (e) => e instanceof FinanceApiError && e.code === 'INSUFFICIENT_BALANCE' && e.status === 409 && e.retryable === false);
    assert.equal(calls, 1);

    let down = 0;
    const offline = async () => { down += 1; throw new TypeError('fetch failed'); };
    await assert.rejects(() => callFinance('transfer.create', {}, base(offline, { retries: 2 })), (e) => e.code === 'NETWORK_ERROR' && e.retryable === true);
    assert.equal(down, 3);
  });

  it('timeout aborta a requisição e é tratado como falha temporária (TIMEOUT), reenviando com a mesma chave', async () => {
    let calls = 0;
    const hang = (_u, init) => new Promise((_resolve, reject) => { calls += 1; init.signal.addEventListener('abort', () => reject(Object.assign(new Error('abort'), { name: 'AbortError' }))); });
    await assert.rejects(() => callFinance('x.y', {}, base(hang, { timeoutMs: 5, retries: 1 })), (e) => e.code === 'TIMEOUT' && e.retryable);
    assert.equal(calls, 2);
  });

  it('401: renova o token UMA vez e repete; segundo 401 falha', async () => {
    const tokens = [];
    let n = 0;
    const fetch = async () => { n += 1; return n === 1 ? json(401, { ok: false, error: 'INVALID_TOKEN', message: 'Token inválido ou expirado.' }) : json(200, { ok: true }); };
    const getToken = async (force) => { tokens.push(force); return force ? 'novo' : 'velho'; };
    assert.equal((await callFinance('a.b', {}, { fetch, getToken, sleep: noSleep })).ok, true);
    assert.deepEqual(tokens, [false, true]);
    const always401 = async () => json(401, { ok: false, error: 'INVALID_TOKEN', message: 'x' });
    await assert.rejects(() => callFinance('a.b', {}, { fetch: always401, getToken, sleep: noSleep }), (e) => e.status === 401);
  });

  it('duplo clique: dois envios com a mesma operationId em voo viram UMA requisição', async () => {
    let calls = 0;
    let release;
    const gate = new Promise((r) => { release = r; });
    const fetch = async () => { calls += 1; await gate; return json(200, { ok: true, n: calls }); };
    const a = callFinance('a.b', {}, base(fetch, { operationId: 'same-op-key' }));
    const b = callFinance('a.b', {}, base(fetch, { operationId: 'same-op-key' }));
    release();
    const [ra, rb] = await Promise.all([a, b]);
    assert.equal(calls, 1);
    assert.deepEqual([ra.n, rb.n], [1, 1]);
  });

  it('newOperationId gera chaves distintas que o servidor aceita (8–100 caracteres seguros)', () => {
    const ids = new Set(Array.from({ length: 50 }, newOperationId));
    assert.equal(ids.size, 50);
    for (const id of ids) assert.match(id, /^[A-Za-z0-9._~-]{8,100}$/);
  });
});

describe('financeResult', () => {
  it('sucesso: { ok:true, ... }; erro real do servidor: { ok:false, errors._form, code, status, retryable }', async () => {
    const good = await financeResult('a.b', {}, base(async () => json(200, { ok: true, id: 'z' })));
    assert.deepEqual([good.ok, good.id], [true, 'z']);
    const bad = await financeResult('a.b', {}, base(async () => json(409, { ok: false, error: 'EXCEEDS_REMAINING', message: 'O valor excede o restante da parcela.', details: { field: 'amountCents', remainingCents: 10 } })));
    assert.deepEqual([bad.ok, bad.code, bad.status, bad.retryable], [false, 'EXCEEDS_REMAINING', 409, false]);
    assert.equal(bad.errors._form, 'O valor excede o restante da parcela.');
    assert.equal(bad.errors.amountCents, 'O valor excede o restante da parcela.');
    assert.equal(bad.details.remainingCents, 10);
  });
});

describe('reversals service', () => {
  it('valida tipo e motivo no cliente; envia reversal.create com a chave informada', async () => {
    const ops = [];
    const finance = async (op, params, options) => { ops.push({ op, params, options }); return { ok: true, reversalId: 'expenses_e1', amountCents: 500 }; };
    assert.equal((await createReversal('u', 'foo', 'x', { reason: 'abc' }, { finance })).ok, false);
    assert.ok((await createReversal('u', 'expense', 'e1', { reason: 'ab' }, { finance })).errors.reason);
    assert.ok((await createReversal('u', 'expense', 'e1', { reason: 'x'.repeat(301) }, { finance })).errors.reason);
    assert.deepEqual(ops, []);
    const r = await createReversal('u', 'expense', 'e1', { reason: '  Lançado por engano  ', operationId: 'rev-op-1234' }, { finance });
    assert.deepEqual([r.ok, r.reversalId, r.amountCents], [true, 'expenses_e1', 500]);
    assert.deepEqual(ops[0], { op: 'reversal.create', params: { kind: 'expense', targetId: 'e1', reason: 'Lançado por engano' }, options: { operationId: 'rev-op-1234' } });
    assert.deepEqual(Object.keys(REVERSAL_KINDS).sort(), ['debtPayment', 'expense', 'goalTransaction', 'income', 'invoice', 'transfer']);
  });

  it('erro do servidor (já estornado) volta com o código real; listReversals consulta a coleção reversals', async () => {
    const dup = await createReversal('u', 'income', 'i1', { reason: 'engano' }, { finance: async () => ({ ok: false, code: 'ALREADY_REVERSED', errors: { _form: 'Este lançamento já foi estornado.' } }) });
    assert.deepEqual([dup.ok, dup.code], [false, 'ALREADY_REVERSED']);
    let seen;
    await listReversals('u', { limit: 10 }, { list: async (u, c, o) => { seen = [u, c, o]; return []; } });
    assert.deepEqual([seen[0], seen[1], seen[2].limit], ['u', 'reversals', 10]);
  });
});
