/**
 * AUDITORIA FINAL VF-ARQ-02 — retry, idempotência de ponta a ponta (cliente real → servidor real), matriz de concorrência
 * entre operações que movem dinheiro e corridas de lote. Firebase Emulator real, sem mocks de transação.
 */
import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { adminDb, clearAll, call, callOk, opId, seed, seedAccount, seedCategory, dump, getDoc, oracleBalance, UID, seedPurchase } from './helpers/server.mjs';
import { handleFinance } from '../../server/finance/index.mjs';
import { callFinance } from '../../js/services/financeApi.js';

before(() => adminDb());
beforeEach(clearAll);

const REPEAT = 10;
const repeat = async (fn) => { for (let i = 0; i < REPEAT; i += 1) { await clearAll(); await fn(i); } };
const T = (from, to, amountCents, extra = {}) => ({ fromAccountId: from, toAccountId: to, amountCents, date: '2026-12-05', reason: 'Teste', status: 'confirmed', ...extra });
const world = async () => { await seedAccount('A', 10000); await seedAccount('B', 0); await seedAccount('C', 10000); await seedAccount('D', 0); await seedCategory('cat', 'expense'); };
const expense = (id, accountId, amountCents) => seed(UID, 'expenses', id, { description: id, categoryId: 'cat', amountCents, accountId, purchaseDate: '2026-12-01', dueDate: '2026-12-10', status: 'pending', recurrence: 'none' });

/** `fetch` do navegador ligado ao handler REAL; `hook(n, run)` decide o que acontece em cada tentativa. */
const bridgeFetch = (hook = async (n, run) => run()) => {
  let n = 0;
  const attempts = [];
  const fetch = async (_url, init) => {
    n += 1;
    attempts.push(JSON.parse(init.body));
    const run = async () => {
      const res = await handleFinance({ method: 'POST', headers: { authorization: init.headers.authorization }, body: JSON.parse(init.body) },
        { db: adminDb(), verifyIdToken: async (t) => ({ uid: t.replace(/^tok-/, '') }), log: () => {} });
      return { ok: res.status < 300, status: res.status, json: async () => res.body };
    };
    return hook(n, run);
  };
  return { fetch, attempts };
};
const client = (f, extra = {}) => ({ fetch: f.fetch, getToken: async () => `tok-${UID}`, sleep: async () => {}, ...extra });

describe('retry — falha transitória INVALID_ARGUMENT "Transaction is invalid or closed"', () => {
  it('o servidor repete a transação (mesma operationId) e persiste UMA vez; após 4 falhas devolve 503 retentável', async () => {
    await world();
    const real = adminDb();
    let fails = 2;
    const flakyDb = new Proxy(real, { get: (t, k) => (k === 'runTransaction'
      ? (fn, opts) => (fails-- > 0 ? Promise.reject(Object.assign(new Error('3 INVALID_ARGUMENT: Transaction is invalid or closed.'), { code: 3 })) : t.runTransaction(fn, opts))
      : (typeof t[k] === 'function' ? t[k].bind(t) : t[k])) });
    const body = { op: 'transfer.create', operationId: opId('tr'), params: T('A', 'B', 3000) };
    const res = await handleFinance({ method: 'POST', headers: { authorization: `Bearer tok-${UID}` }, body }, { db: flakyDb, verifyIdToken: async () => ({ uid: UID }), log: () => {} });
    assert.equal(res.status, 200, JSON.stringify(res));
    assert.equal(fails, -1); // 2 falhas simuladas + 1 sucesso = 3 chamadas
    assert.equal((await dump('transfers')).length, 1);
    assert.equal((await dump('operations')).filter((o) => o.id === body.operationId).length, 1);
    assert.equal(await oracleBalance('A'), 7000);
    // esgotando as 4 tentativas: nada gravado, erro retentável (503) e a MESMA chave funciona depois
    let always = 99;
    const deadDb = new Proxy(real, { get: (t, k) => (k === 'runTransaction'
      ? () => { always -= 1; return Promise.reject(Object.assign(new Error('3 INVALID_ARGUMENT: Transaction is invalid or closed.'), { code: 3 })); }
      : (typeof t[k] === 'function' ? t[k].bind(t) : t[k])) });
    const body2 = { op: 'transfer.create', operationId: opId('tr2'), params: T('A', 'B', 1000) };
    const failed = await handleFinance({ method: 'POST', headers: { authorization: `Bearer tok-${UID}` }, body: body2 }, { db: deadDb, verifyIdToken: async () => ({ uid: UID }), log: () => {} });
    assert.deepEqual([failed.status, failed.body.error, failed.body.retryable], [503, 'TEMPORARILY_UNAVAILABLE', true]);
    assert.equal(99 - always, 4); // exatamente SERVER_ATTEMPTS
    assert.equal((await dump('transfers')).length, 1);
    await callOk(UID, 'transfer.create', body2.operationId, body2.params);
    assert.equal(await oracleBalance('A'), 6000);
  });
});

describe('idempotência ponta a ponta (cliente real → handler real → Emulator)', () => {
  it('TIMEOUT DEPOIS DA GRAVAÇÃO: o servidor confirmou, a resposta se perdeu; o cliente repete com a MESMA chave e recebe o resultado original (10×)', async () => {
    await repeat(async () => {
      await world();
      const f = bridgeFetch(async (n, run) => { const r = await run(); if (n === 1) throw new TypeError('fetch failed (resposta perdida)'); return r; });
      const key = opId('lost');
      const r = await callFinance('transfer.create', T('A', 'B', 3000), client(f, { operationId: key }));
      assert.equal(r.idempotent, true); // a 2ª tentativa achou a operação já gravada
      assert.equal(f.attempts.length, 2);
      assert.ok(f.attempts.every((a) => a.operationId === key));
      assert.equal((await dump('transfers')).length, 1);
      assert.equal(await oracleBalance('A'), 7000);
      assert.equal(await oracleBalance('B'), 3000);
    });
  });

  it('TIMEOUT ANTES DA GRAVAÇÃO (requisição nunca chegou): a repetição executa UMA vez', async () => {
    await world();
    const f = bridgeFetch(async (n, run) => { if (n === 1) throw new TypeError('fetch failed'); return run(); });
    const r = await callFinance('transfer.create', T('A', 'B', 3000), client(f, { operationId: opId('early') }));
    assert.equal(r.idempotent, false);
    assert.equal((await dump('transfers')).length, 1);
  });

  it('TIMEOUT real do cliente (AbortController) com o servidor ainda processando: a repetição concorrente não duplica (10×)', async () => {
    await repeat(async () => {
      await world();
      // 1ª tentativa: o servidor processa, mas a resposta chega DEPOIS do timeout do cliente (cliente aborta e reenvia)
      let firstDone;
      const f = bridgeFetch((n, run) => (n === 1 ? new Promise((resolve) => { firstDone = run().then((r) => setTimeout(() => resolve(r), 400)); }) : run()));
      const abortable = (url, init) => new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(Object.assign(new Error('abort'), { name: 'AbortError' })));
        f.fetch(url, init).then(resolve, reject);
      });
      const r = await callFinance('transfer.create', T('A', 'B', 3000), { fetch: abortable, getToken: async () => `tok-${UID}`, sleep: async () => {}, timeoutMs: 150, operationId: opId('abort') });
      assert.equal(r.ok, true);
      assert.equal(r.idempotent, true); // o servidor já tinha gravado a 1ª tentativa (abortada pelo cliente)
      await firstDone; // nenhuma operação em voo vaza para o próximo cenário
      assert.equal((await dump('transfers')).length, 1);
      assert.equal(await oracleBalance('A'), 7000);
    });
  });

  it('mesma chave + mesmo payload, retry depois de sucesso, e mesma chave + payload diferente (10×)', async () => {
    await repeat(async () => {
      await world();
      const key = opId('k');
      const first = await callOk(UID, 'transfer.create', key, T('A', 'B', 3000));
      const same = await call(UID, 'transfer.create', key, T('A', 'B', 3000));
      assert.deepEqual([same.status, same.body.idempotent, same.body.transferId], [200, true, first.transferId]);
      for (const other of [T('A', 'B', 3001), T('A', 'D', 3000), T('B', 'A', 3000), T('A', 'B', 3000, { reason: 'outra' })]) {
        const r = await call(UID, 'transfer.create', key, other);
        assert.deepEqual([r.status, r.body.error], [409, 'OPERATION_ID_REUSED']);
      }
      assert.equal((await dump('transfers')).length, 1);
      assert.equal(await oracleBalance('A'), 7000);
    });
  });

  it('duas requisições SIMULTÂNEAS com a mesma chave (payload igual): um documento; (payload diferente): um vence, o outro 409 ou idempotente — nunca dois lançamentos (10×)', async () => {
    await repeat(async () => {
      await world();
      const k1 = opId('same');
      const rs = await Promise.all([call(UID, 'transfer.create', k1, T('A', 'B', 3000)), call(UID, 'transfer.create', k1, T('A', 'B', 3000)), call(UID, 'transfer.create', k1, T('A', 'B', 3000))]);
      assert.ok(rs.every((r) => r.status === 200), JSON.stringify(rs));
      assert.equal(rs.filter((r) => r.body.idempotent === false).length, 1);
      const k2 = opId('diff');
      const ds = await Promise.all([call(UID, 'transfer.create', k2, T('C', 'D', 1000)), call(UID, 'transfer.create', k2, T('C', 'D', 2000))]);
      assert.deepEqual(ds.map((r) => r.status).sort(), [200, 409], JSON.stringify(ds));
      assert.equal((await dump('transfers')).length, 2); // 1 (k1) + 1 (k2)
      assert.equal((await dump('operations')).length, 2);
    });
  });
});

describe('matriz de concorrência — mesma conta e contas diferentes (documentos persistidos + saldo final)', () => {
  const goal = () => seed(UID, 'goals', 'g1', { name: 'V', targetCents: 1000000, status: 'active' });

  it('transferência × movimentação de meta (R$ 80 cada, saldo R$ 100): só uma passa (10×)', async () => {
    await repeat(async () => {
      await world(); await goal();
      const rs = await Promise.all([call(UID, 'transfer.create', opId(), T('A', 'B', 8000)), call(UID, 'goal.deposit', opId(), { goalId: 'g1', amountCents: 8000, date: '2026-12-05', accountId: 'A' })]);
      assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409], JSON.stringify(rs));
      assert.equal(await oracleBalance('A'), 2000);
      assert.equal((await dump('transfers')).length + (await dump('goalTransactions')).length, 1);
    });
  });

  it('TEMPESTADE na MESMA conta: 12 operações simultâneas (transferências, despesas, fatura, aportes) disputando R$ 100: saldo nunca negativo; documentos == sucessos; saldo == oráculo (10×)', async () => {
    await repeat(async () => {
      await world(); await goal();
      await seed(UID, 'invoices', 'inv', { cardId: 'c', referenceMonth: '2026-12', closingDate: '2026-12-01', dueDate: '2026-12-10', status: 'closed', totalCents: 2500 });
      await seedPurchase('inv', 2500);
      for (let i = 0; i < 4; i += 1) await expense(`e${i}`, 'A', 2000);
      const jobs = [
        ...Array.from({ length: 4 }, () => call(UID, 'transfer.create', opId(), T('A', 'B', 3000))),
        ...Array.from({ length: 4 }, (_, i) => call(UID, 'expense.pay', opId(), { id: `e${i}` })),
        call(UID, 'invoice.pay', opId(), { invoiceId: 'inv', accountId: 'A' }),
        ...Array.from({ length: 3 }, () => call(UID, 'goal.deposit', opId(), { goalId: 'g1', amountCents: 2500, date: '2026-12-05', accountId: 'A' })),
      ];
      const rs = await Promise.all(jobs);
      assert.ok(rs.every((r) => [200, 409].includes(r.status)), JSON.stringify(rs.filter((r) => ![200, 409].includes(r.status))));
      const okTransfers = rs.slice(0, 4).filter((r) => r.status === 200).length;
      const okExpenses = rs.slice(4, 8).filter((r) => r.status === 200).length;
      const okInvoice = rs[8].status === 200 ? 1 : 0;
      const okGoals = rs.slice(9).filter((r) => r.status === 200).length;
      const spent = okTransfers * 3000 + okExpenses * 2000 + okInvoice * 2500 + okGoals * 2500;
      assert.ok(spent <= 10000, `gasto ${spent}`);
      assert.equal(await oracleBalance('A'), 10000 - spent);
      assert.ok((await oracleBalance('A')) >= 0);
      assert.equal((await dump('transfers')).length, okTransfers);
      assert.equal((await dump('expenses')).filter((e) => e.status === 'paid').length, okExpenses);
      assert.equal((await dump('invoices')).filter((i) => i.status === 'paid').length, okInvoice);
      assert.equal((await dump('goalTransactions')).length, okGoals);
      assert.equal((await dump('operations')).length, okTransfers + okExpenses + okInvoice + okGoals); // só sucesso consome chave
      assert.equal(await oracleBalance('B'), okTransfers * 3000);
    });
  });

  it('contas DIFERENTES: A→B e C→D simultâneas passam as duas; cruzadas A→B e B→A (sem deadlock) e anel de 4 contas fecham os saldos (10×)', async () => {
    await repeat(async () => {
      await world();
      const rs = await Promise.all([call(UID, 'transfer.create', opId(), T('A', 'B', 4000)), call(UID, 'transfer.create', opId(), T('C', 'D', 5000))]);
      assert.deepEqual(rs.map((r) => r.status), [200, 200]);
      const cross = await Promise.all([call(UID, 'transfer.create', opId(), T('A', 'B', 1000)), call(UID, 'transfer.create', opId(), T('B', 'A', 2000))]);
      assert.ok(cross.every((r) => r.status === 200), JSON.stringify(cross));
      const ring = await Promise.all([['A', 'B'], ['B', 'C'], ['C', 'D'], ['D', 'A']].map(([f, t]) => call(UID, 'transfer.create', opId(), T(f, t, 500))));
      assert.ok(ring.every((r) => r.status === 200), JSON.stringify(ring));
      const total = (await Promise.all(['A', 'B', 'C', 'D'].map((a) => oracleBalance(a)))).reduce((x, y) => x + y, 0);
      assert.equal(total, 20000); // transferências conservam o dinheiro
      assert.equal(await oracleBalance('A'), 10000 - 4000 - 1000 + 2000 - 500 + 500);
      assert.equal((await dump('transfers')).length, 8);
    });
  });
});

describe('corridas de parcela e de lote', () => {
  const debtWorld = async () => {
    await seedAccount('A', 0);
    await seed(UID, 'debtors', 'dev', { name: 'João', loanDate: '2026-11-10', lentCents: 10000, receivedCents: 0, status: 'open' });
    await seed(UID, 'debts', 'p0', { debtorId: 'dev', description: 'P', principalCents: 10000, dueDate: '2026-12-10', installmentNumber: 1, status: 'pending' });
  };

  it('debt.cancel × debt.receive parcial simultâneos na MESMA parcela: nunca "cancelada com recebimento" (10×)', async () => {
    await repeat(async () => {
      await debtWorld();
      const rs = await Promise.all([call(UID, 'debt.cancel', opId(), { debtId: 'p0' }), call(UID, 'debt.receive', opId(), { debtId: 'p0', date: '2026-12-05', accountId: 'A', amountCents: 4000 })]);
      const debt = await getDoc('debts', 'p0');
      const payments = await dump('debtPayments');
      assert.ok(!(debt.status === 'cancelled' && payments.length > 0), JSON.stringify({ rs, debt, payments }));
      assert.equal(rs.filter((r) => r.status === 200).length, 1, JSON.stringify(rs)); // exatamente um dos dois vence
    });
  });

  it('lote: duas chamadas simultâneas com a MESMA chave e parâmetros DIFERENTES (contas/datas): um lote só, com os parâmetros do vencedor; o outro 409 (10×)', async () => {
    await repeat(async () => {
      await seedAccount('A', 0); await seedAccount('B', 0);
      await seed(UID, 'debtors', 'dev', { name: 'João', loanDate: '2026-11-10', lentCents: 30000, receivedCents: 0, status: 'open' });
      for (let i = 0; i < 3; i += 1) await seed(UID, 'debts', `p${i}`, { debtorId: 'dev', description: 'P', principalCents: 10000, dueDate: '2026-12-10', installmentNumber: i + 1, status: 'pending' });
      const key = opId('batch');
      const b = (accountId, date) => ({ debtorId: 'dev', accountId, date, scope: { all: true } });
      const rs = await Promise.all([call(UID, 'debt.settleBatch', key, b('A', '2026-12-05')), call(UID, 'debt.settleBatch', key, b('B', '2026-12-06'))]);
      assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409], JSON.stringify(rs));
      const payments = await dump('debtPayments');
      assert.equal(payments.length, 3);
      assert.equal(new Set(payments.map((p) => p.accountId)).size, 1, 'todos os recebimentos usam a conta do lote vencedor');
      assert.equal(new Set(payments.map((p) => p.date.toISOString?.() ?? String(p.date))).size, 1);
      assert.equal((await getDoc('debtors', 'dev')).receivedCents, 30000);
      const winner = payments[0].accountId;
      assert.equal(await oracleBalance(winner), 30000);
      assert.equal(await oracleBalance(winner === 'A' ? 'B' : 'A'), 0);
    });
  });
});
