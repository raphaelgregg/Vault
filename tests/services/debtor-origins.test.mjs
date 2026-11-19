/**
 * VF-2-03i — débitos de devedor por origem (empréstimo × cartão), erro amigável e dashboard resiliente.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { registerCardPurchase, deleteCardPurchase } from '../../js/services/creditCards.js';
import { deleteDebtor, getDebtorOverview, DEBTOR_LINK_QUERIES } from '../../js/services/debtors.js';
import { debtorOverview } from '../../js/core/model.js';
import { describeError } from '../../js/utils/errors.js';
import { loadDashboard, DASHBOARD_SOURCES } from '../../js/services/dashboard.js';

const uid = 'u1';
const card = { id: 'c1', name: 'Nubank', brand: 'M', limitCents: 500000, closingDay: 10, dueDay: 17, status: 'active' };
const debtor = (o = {}) => ({ id: 'd1', name: 'João', lentCents: 100000, receivedCents: 20000, status: 'open', ...o });
const rawBuy = (o = {}) => ({ description: 'TV', amountCents: '300,00', purchaseDate: '2026-11-05', installmentsTotal: 3, debtorId: 'd1', ...o });

function makeIo({ debtors = [debtor()], purchases = [] } = {}) {
  const atomic = [];
  const io = {
    getById: async (u, c, id) => ({ creditCards: [card], debtors, cardPurchases: purchases }[c] ?? []).find((x) => x.id === id) ?? null,
    list: async (u, c) => (c === 'cardPurchases' ? purchases : []),
    commitAtomic: async (u, ops) => { atomic.push(ops); return ops.map((o, i) => o.docId ?? `n${i}`); },
    now: () => new Date('2026-11-18T12:00:00Z'),
  };
  return { io, atomic };
}

describe('compra de cartão vinculada a devedor', () => {
  it('soma ao emprestado no MESMO lote das parcelas e grava debtorId em cada parcela', async () => {
    const { io, atomic } = makeIo();
    const r = await registerCardPurchase(uid, 'c1', rawBuy(), io);
    assert.equal(r.ok, true);
    const batch = atomic.at(-1);
    const parts = batch.filter((o) => o.collection === 'cardPurchases');
    assert.equal(parts.length, 3);
    assert.ok(parts.every((o) => o.data.debtorId === 'd1'));
    const upd = batch.find((o) => o.collection === 'debtors');
    assert.deepEqual(upd, { type: 'update', collection: 'debtors', docId: 'd1', action: 'card-purchase', data: { lentCents: 130000 } });
    assert.ok(Number.isInteger(upd.data.lentCents));
  });
  it('rejeita devedor inexistente ou não aberto e não grava nada', async () => {
    for (const debtors of [[], [debtor({ status: 'cancelled' })]]) {
      const { io, atomic } = makeIo({ debtors });
      const r = await registerCardPurchase(uid, 'c1', rawBuy(), io);
      assert.equal(r.ok, false);
      assert.ok(r.errors.debtorId);
      assert.equal(atomic.length, 0);
    }
  });
  it('sem devedor, o lote não toca em debtors', async () => {
    const { io, atomic } = makeIo();
    await registerCardPurchase(uid, 'c1', rawBuy({ debtorId: undefined }), io);
    assert.equal(atomic.at(-1).some((o) => o.collection === 'debtors'), false);
  });
  it('compra vinculada não pode ser excluída', async () => {
    const { io } = makeIo({ purchases: [{ id: 'p1', cardId: 'c1', debtorId: 'd1' }] });
    const r = await deleteCardPurchase(uid, 'p1', io);
    assert.equal(r.ok, false);
    assert.match(r.errors._form, /devedor/);
  });
});

describe('visão consolidada do devedor', () => {
  it('separa cartão × empréstimo; pendente = emprestado − recebido', () => {
    const o = debtorOverview(debtor({ lentCents: 130000 }), [{ amountCents: 10000 }, { amountCents: 20000 }]);
    assert.deepEqual(o, { lentCents: 130000, receivedCents: 20000, pendingCents: 110000, cardCents: 30000, loanCents: 100000, cardCount: 2 });
    assert.equal(debtorOverview(debtor({ lentCents: 100 }), [{ amountCents: 500 }]).loanCents, 0); // limitado ao emprestado
  });
  it('getDebtorOverview lista compras vinculadas (mais recentes primeiro)', async () => {
    const purchases = [{ amountCents: 100, purchaseDate: '2026-01-01' }, { amountCents: 200, purchaseDate: '2026-02-01' }];
    const o = await getDebtorOverview(uid, debtor(), { list: async () => [...purchases] });
    assert.equal(o.cardPurchases[0].purchaseDate, '2026-02-01');
    assert.equal(o.cardCents, 300);
  });
  it('exclusão de devedor considera compras no cartão', async () => {
    assert.ok(DEBTOR_LINK_QUERIES.some((q) => q.collection === 'cardPurchases' && q.field === 'debtorId'));
    const calls = [];
    const r = await deleteDebtor(uid, 'd1', {
      getById: async () => debtor(),
      count: async (u, c) => { calls.push(c); return c === 'cardPurchases' ? 2 : 0; },
    });
    assert.equal(r.ok, false);
    assert.match(r.errors._form, /2 compras no cartão/);
  });
});

describe('describeError', () => {
  it('traduz códigos do Firebase', () => {
    assert.match(describeError({ code: 'permission-denied' }), /Permissão negada.*firestore\.rules/);
    assert.match(describeError({ code: 'unavailable' }), /conexão/);
    assert.match(describeError(new Error('x')), /Tente novamente/);
    assert.ok(describeError(undefined));
  });
});

describe('dashboard resiliente por fonte', () => {
  const base = { accounts: [{ id: 'a1', status: 'active', initialBalanceCents: 1000 }] };
  const ioWith = (failing = []) => ({
    now: () => new Date('2026-11-19T12:00:00Z'),
    list: async (u, c, opts = {}) => {
      if (failing.includes(`${c}:${opts.where?.[0]?.[2] ?? ''}`) || failing.includes(c)) throw Object.assign(new Error('x'), { code: 'permission-denied' });
      return base[c] ?? [];
    },
  });
  const silent = async (fn) => { const orig = console.error; console.error = () => {}; try { return await fn(); } finally { console.error = orig; } };

  it('coleções vazias não são falha', async () => {
    const d = await loadDashboard(uid, ioWith());
    assert.deepEqual(d.failed, []);
    assert.equal(d.debtors.pendingCents, 0);
  });
  it('falha em uma fonte não derruba as demais', async () => {
    const d = await silent(() => loadDashboard(uid, ioWith(['debtors', 'invoices'])));
    assert.deepEqual(d.failed.sort(), ['debtors', 'invoices']);
    assert.equal(d.debtors, null);
    assert.equal(typeof d.totalBalanceCents, 'number');
    assert.ok(d.result);
    assert.ok(Array.isArray(d.upcoming));
  });
  it('sem movimentos: saldo e resultado indisponíveis (null), resto intacto', async () => {
    const d = await silent(() => loadDashboard(uid, ioWith(['incomes'])));
    assert.deepEqual(d.failed, ['movements']);
    assert.equal(d.totalBalanceCents, null);
    assert.equal(d.result, null);
    assert.ok(d.debtors);
  });
  it('sem contas: saldo nulo e movimentos não consultados', async () => {
    const d = await silent(() => loadDashboard(uid, ioWith(['accounts'])));
    assert.deepEqual(d.failed, ['accounts']);
    assert.equal(d.accountCount, null);
    assert.equal(d.totalBalanceCents, null);
    assert.ok(DASHBOARD_SOURCES.includes('movements'));
  });
});
