/** Paginação (VF-4-03): pager por cursor, saldos derivados com teto e rodapé de truncamento. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createPager, DEFAULT_PAGE_SIZE } from '../../js/services/pager.js';
import { loadBalances, READ_LIMIT } from '../../js/services/balances.js';

/** Fonte falsa: ids "d0".."d{n-1}" em ordem de busca; respeita limit e startAfterId. */
function source(n) {
  const all = Array.from({ length: n }, (_, i) => ({ id: `d${i}` }));
  const calls = [];
  const fetchPage = async ({ limit, startAfterId }) => {
    calls.push({ limit, startAfterId });
    const start = startAfterId ? all.findIndex((x) => x.id === startAfterId) + 1 : 0;
    return all.slice(start, start + limit);
  };
  return { fetchPage, calls };
}

describe('createPager', () => {
  it('padrão de 100 por página', () => {
    assert.equal(DEFAULT_PAGE_SIZE, 100);
    assert.equal(createPager({ fetchPage: async () => [] }).pageSize, 100);
  });
  it('lista menor que a página: sem "mais" e sem consulta extra', async () => {
    const { fetchPage, calls } = source(3);
    const pager = createPager({ fetchPage, pageSize: 5 });
    assert.equal((await pager.loadFirst()).length, 3);
    assert.equal(pager.hasMore, false);
    await pager.loadMore();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].limit, 6); // pageSize + 1 para detectar mais
  });
  it('exatamente uma página cheia: não há página vazia extra', async () => {
    const { fetchPage } = source(5);
    const pager = createPager({ fetchPage, pageSize: 5 });
    await pager.loadFirst();
    assert.equal(pager.hasMore, false);
    assert.equal(pager.items.length, 5);
  });
  it('páginas sucessivas usam o último id como cursor e não duplicam itens', async () => {
    const { fetchPage, calls } = source(12);
    const pager = createPager({ fetchPage, pageSize: 5 });
    await pager.loadFirst();
    assert.deepEqual([pager.items.length, pager.hasMore], [5, true]);
    await pager.loadMore();
    assert.deepEqual([pager.items.length, pager.hasMore], [10, true]);
    assert.equal(calls[1].startAfterId, 'd4');
    await pager.loadMore();
    assert.deepEqual([pager.items.length, pager.hasMore], [12, false]);
    assert.equal(calls[2].startAfterId, 'd9');
    assert.deepEqual(pager.items.map((x) => x.id), Array.from({ length: 12 }, (_, i) => `d${i}`));
    await pager.loadMore();
    assert.equal(calls.length, 3); // sem mais páginas, não consulta
  });
  it('loadFirst reinicia o estado; chamadas concorrentes de loadMore não duplicam', async () => {
    const { fetchPage, calls } = source(12);
    const pager = createPager({ fetchPage, pageSize: 5 });
    await pager.loadFirst();
    await Promise.all([pager.loadMore(), pager.loadMore()]);
    assert.equal(pager.items.length, 10);
    assert.equal(calls.length, 2);
    await pager.loadFirst();
    assert.equal(pager.items.length, 5);
  });
  it('falha ao carregar mais mantém itens e permite tentar de novo', async () => {
    const { fetchPage } = source(12);
    let fail = false;
    const pager = createPager({ fetchPage: async (o) => { if (fail && o.startAfterId) throw new Error('x'); return fetchPage(o); }, pageSize: 5 });
    await pager.loadFirst();
    fail = true;
    await assert.rejects(pager.loadMore(), /x/);
    assert.equal(pager.items.length, 5);
    assert.equal(pager.hasMore, true);
    assert.equal(pager.loading, false);
    fail = false;
    await pager.loadMore();
    assert.equal(pager.items.length, 10);
  });
});

describe('loadBalances', () => {
  const rows = (n, o = {}) => Array.from({ length: n }, () => ({ accountId: 'a1', amountCents: 1, ...o }));
  it('deriva saldo de movimentos realizados e usa filtros de status e teto de leitura', async () => {
    const calls = [];
    const tables = {
      incomes: [{ accountId: 'a1', status: 'received', amountCents: 500 }],
      expenses: [{ accountId: 'a1', status: 'paid', amountCents: 200 }],
      transfers: [{ fromAccountId: 'a1', toAccountId: 'a2', status: 'confirmed', amountCents: 100 }],
      debtPayments: [{ accountId: 'a2', amountCents: 50 }],
      goalTransactions: [{ accountId: 'a1', type: 'deposit', amountCents: 30 }],
    };
    const io = { list: async (u, c, opts) => { calls.push([c, opts]); return tables[c]; } };
    const { balances, truncated } = await loadBalances('u', [{ id: 'a1', initialBalanceCents: 1000 }, { id: 'a2', initialBalanceCents: 0 }], io);
    assert.equal(balances.get('a1'), 1000 + 500 - 200 - 100 - 30);
    assert.equal(balances.get('a2'), 100 + 50);
    assert.deepEqual(truncated, []);
    assert.ok(calls.every(([, o]) => o.limit === READ_LIMIT));
    assert.deepEqual(calls.find(([c]) => c === 'incomes')[1].where, [['status', '==', 'received']]);
    assert.deepEqual(calls.find(([c]) => c === 'transfers')[1].where, [['status', '==', 'confirmed']]);
  });
  it('sinaliza coleções que atingiram o teto', async () => {
    const io = { list: async (u, c) => (c === 'expenses' ? rows(READ_LIMIT, { status: 'paid' }) : []) };
    assert.deepEqual((await loadBalances('u', [{ id: 'a1' }], io)).truncated, ['expenses']);
  });
});
