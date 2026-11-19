/**
 * VF-2-03i — débitos de devedor por origem (empréstimo × cartão), erro amigável e dashboard resiliente.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { registerCardPurchase, deleteCardPurchase } from '../../js/services/creditCards.js';
import { createDebtPlan, settleDebts, registerDebtPayment } from '../../js/services/debtPayments.js';
import { deleteDebtor, getDebtorOverview, listOpenDebtors, loadDebtorStatements, getDebtorStatement, DEBTOR_LINK_QUERIES } from '../../js/services/debtors.js';
import { debtorOverview, debtorMonthStatement, debtorObligations } from '../../js/core/model.js';
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
  it('devedor sem empréstimo inicial (lentCents 0): compra soma ao emprestado e o fechamento funciona', async () => {
    const zero = debtor({ lentCents: 0, receivedCents: 0 });
    const { io, atomic } = makeIo({ debtors: [zero] });
    const r = await registerCardPurchase(uid, 'c1', rawBuy(), io);
    assert.equal(r.ok, true);
    assert.equal(atomic.at(-1).find((o) => o.collection === 'debtors').data.lentCents, 30000);
    const none = debtorMonthStatement({ debtor: zero, month: '2026-11' });
    assert.equal(none.totalCents, 0); // sem nada vinculado: 0, sem erro
    const st = debtorMonthStatement({ debtor: debtor({ lentCents: 30000, receivedCents: 0 }), month: '2026-11', purchases: [{ amountCents: 10000, purchaseDate: '2026-11-05' }] });
    assert.equal(st.totalCents, 10000);
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

describe('fechamento do mês por devedor (VF-2-03j)', () => {
  const inv = new Map([
    ['i11', { id: 'i11', referenceMonth: '2026-11', status: 'open' }],
    ['i12', { id: 'i12', referenceMonth: '2026-12', status: 'paid' }],
  ]);
  const buys = [
    { id: 'p1', description: 'TV', installmentNumber: 1, installmentsTotal: 2, amountCents: 15000, invoiceId: 'i11', purchaseDate: '2026-11-05' },
    { id: 'p2', description: 'TV', installmentNumber: 2, installmentsTotal: 2, amountCents: 15000, invoiceId: 'i12', purchaseDate: '2026-11-05' },
  ];
  const debts = [
    { id: 'b1', principalCents: 20000, dueDate: '2026-11-20', status: 'pending' },
    { id: 'b2', principalCents: 10000, dueDate: '2026-12-20', status: 'pending' },
    { id: 'b3', principalCents: 5000, dueDate: '2026-11-25', status: 'cancelled' },
  ];
  // lent = 100000 (inclui 30000 de cartão); recebido 20000 → pendente 80000
  const d = debtor({ lentCents: 100000, receivedCents: 20000 });

  it('soma cartão (mês da FATURA) + parcelas de empréstimo do mês (restante), em centavos', () => {
    const st = debtorMonthStatement({ debtor: d, month: '2026-11', purchases: buys, invoicesById: inv, debts, receivedByDebt: new Map([['b1', 5000]]) });
    assert.equal(st.cardCents, 15000);
    assert.equal(st.loanCents, 15000); // 20000 − 5000 recebidos; cancelada e de dezembro fora
    assert.equal(st.totalCents, 30000);
    assert.equal(st.capped, false);
    assert.deepEqual(st.card.map((p) => p.installmentNumber), [1]);
    assert.equal(debtorMonthStatement({ debtor: d, month: '2026-12', purchases: buys, invoicesById: inv, debts }).cardCents, 15000);
  });
  it('limita ao pendente e zera para devedor não aberto', () => {
    const small = debtor({ lentCents: 100000, receivedCents: 80000 }); // pendente 20000
    const st = debtorMonthStatement({ debtor: small, month: '2026-11', purchases: buys, invoicesById: inv, debts });
    assert.equal(st.rawCents, 35000);
    assert.equal(st.totalCents, 20000);
    assert.equal(st.capped, true);
    assert.equal(debtorMonthStatement({ debtor: debtor({ status: 'cancelled' }), month: '2026-11', purchases: buys, invoicesById: inv, debts }).totalCents, 0);
  });
  it('sem fatura usa o mês da compra', () => {
    const st = debtorMonthStatement({ debtor: d, month: '2026-11', purchases: [{ ...buys[0], invoiceId: undefined }], debts });
    assert.equal(st.cardCents, 15000);
    assert.equal('overlapCents' in st, false); // sem alerta de duplicidade (VF-2-03m)
  });
  it('loadDebtorStatements: consultas `in` por lote, só devedores abertos, recebimentos por parcela', async () => {
    const calls = [];
    const io = {
      list: async (u, c, opts) => {
        calls.push({ c, where: opts.where });
        return ({
          cardPurchases: buys.map((p) => ({ ...p, debtorId: 'd1', cardId: 'c1' })),
          debts: debts.map((x) => ({ ...x, debtorId: 'd1' })),
          debtPayments: [{ debtId: 'b1', debtorId: 'd1', amountCents: 5000 }],
          invoices: [...inv.values()],
        })[c];
      },
    };
    const open = [d, debtor({ id: 'd2', status: 'cancelled' })];
    const map = await loadDebtorStatements(uid, open, '2026-11', io);
    assert.deepEqual([...map.keys()], ['d1']);
    assert.equal(map.get('d1').totalCents, 30000);
    assert.deepEqual(calls.find((x) => x.c === 'cardPurchases').where, [['debtorId', 'in', ['d1']]]);
    assert.deepEqual(calls.find((x) => x.c === 'invoices').where, [['cardId', 'in', ['c1']]]);
    assert.equal((await loadDebtorStatements(uid, [debtor({ status: 'paid' })], '2026-11', io)).size, 0);
    const single = await getDebtorStatement(uid, debtor({ id: 'd1', status: 'paid' }), '2026-11', io);
    assert.equal(single.totalCents, 0);
    assert.equal(single.purchases.length, 2);
  });
  it('lotes de 30 no operador `in`', async () => {
    const many = Array.from({ length: 65 }, (_, i) => debtor({ id: `d${i}` }));
    const seen = [];
    await loadDebtorStatements(uid, many, '2026-11', { list: async (u, c, o) => { if (c === 'cardPurchases') seen.push(o.where[0][2].length); return []; } });
    assert.deepEqual(seen, [30, 30, 5]);
  });
});

describe('listOpenDebtors (seletor da compra de cartão)', () => {
  it('lista sem where/orderBy no servidor (evita índice composto) e filtra/ordena no cliente', async () => {
    const calls = [];
    const rows = [debtor({ id: 'a', name: 'Zé' }), debtor({ id: 'b', name: 'Ana' }), debtor({ id: 'c', name: 'Bia', status: 'cancelled' }), debtor({ id: 'd', name: 'Caio', status: 'paid' })];
    const out = await listOpenDebtors(uid, { list: async (u, c, opts) => { calls.push({ c, opts }); return rows; } });
    assert.deepEqual(out.map((d) => d.name), ['Ana', 'Zé']);
    assert.deepEqual(calls, [{ c: 'debtors', opts: {} }]); // sem where/orderBy
  });
});

describe('dívidas do devedor (VF-2-03m)', () => {
  const planIo = (debtors = [debtor({ lentCents: 0, receivedCents: 0 })]) => {
    const atomic = [];
    return {
      atomic,
      io: {
        getById: async (u, c, id) => debtors.find((x) => x.id === id) ?? null,
        commitAtomic: async (u, ops) => { atomic.push(ops); return ops.map((o, i) => `n${i}`); },
        groupId: () => 'grp1',
      },
    };
  };
  const plan = (o = {}) => ({ debtorId: 'd1', description: 'Moto', totalCents: '1.000,01', installments: 3, firstDueDate: '2026-01-31', ...o });

  it('parcelada: N parcelas em um lote, centavos exatos, mesmo grupo, vencimento mensal com clamp e lentCents += total', async () => {
    const { io, atomic } = planIo();
    const r = await createDebtPlan(uid, plan(), io);
    assert.equal(r.ok, true);
    const ops = atomic[0];
    const parcels = ops.filter((o) => o.collection === 'debts');
    assert.deepEqual(parcels.map((o) => o.data.principalCents), [33335, 33333, 33333]);
    assert.equal(parcels.reduce((t, o) => t + o.data.principalCents, 0), 100001);
    assert.deepEqual(parcels.map((o) => o.data.installmentNumber), [1, 2, 3]);
    assert.ok(parcels.every((o) => o.data.installmentsTotal === 3 && o.data.debtGroupId === 'grp1' && o.data.status === 'pending'));
    assert.deepEqual(parcels.map((o) => o.data.dueDate), ['2026-01-31', '2026-02-28', '2026-03-31']);
    assert.deepEqual(ops.at(-1), { type: 'update', collection: 'debtors', docId: 'd1', action: 'debt-plan', data: { lentCents: 100001 } });
  });
  it('à vista (1 parcela) e várias dívidas independentes somam no emprestado', async () => {
    const { io, atomic } = planIo([debtor({ lentCents: 50000, receivedCents: 0 })]);
    const r = await createDebtPlan(uid, plan({ installments: '', totalCents: '200,00' }), io);
    assert.equal(r.ok, true);
    assert.equal(atomic[0].filter((o) => o.collection === 'debts').length, 1);
    assert.equal(atomic[0].filter((o) => o.collection === 'debts')[0].data.installmentsTotal, 1);
    assert.equal(atomic[0].at(-1).data.lentCents, 70000);
  });
  it('valida devedor, valor, parcelas e data sem gravar', async () => {
    const bad = [
      [plan({ debtorId: 'zz' }), 'debtorId'], [plan({ totalCents: '0' }), 'totalCents'], [plan({ installments: 0 }), 'installments'],
      [plan({ installments: 121 }), 'installments'], [plan({ firstDueDate: '2026-13-01' }), 'firstDueDate'], [plan({ totalCents: '0,02', installments: 3 }), 'totalCents'],
      [plan({ description: '' }), 'description'],
    ];
    for (const [raw, field] of bad) {
      const { io, atomic } = planIo();
      const r = await createDebtPlan(uid, raw, io);
      assert.equal(r.ok, false, field);
      assert.ok(r.errors[field], field);
      assert.equal(atomic.length, 0);
    }
    const { io, atomic } = planIo([debtor({ status: 'cancelled' })]);
    assert.equal((await createDebtPlan(uid, plan(), io)).ok, false);
    assert.equal(atomic.length, 0);
  });
  it('obrigações: à vista, parcelada, legada e cartão em lista única; sem alerta de duplicidade', () => {
    const d = debtor({ lentCents: 200000, receivedCents: 30000 }); // aberto 170000
    const o = debtorObligations({
      debtor: d,
      debts: [
        { id: 'x1', description: 'Moto', principalCents: 50000, installmentNumber: 1, installmentsTotal: 2, debtGroupId: 'g', dueDate: '2026-11-10', status: 'pending' },
        { id: 'x2', description: 'Moto', principalCents: 50000, installmentNumber: 2, installmentsTotal: 2, debtGroupId: 'g', dueDate: '2026-12-10', status: 'pending' },
        { id: 'x3', description: 'Notebook', principalCents: 80000, installmentNumber: 1, installmentsTotal: 1, dueDate: '2026-11-15', status: 'paid' },
        { id: 'x4', description: 'Antiga', principalCents: 10000, installmentNumber: 1, dueDate: '2026-11-01', status: 'pending' },
        { id: 'x5', description: 'Cancelada', principalCents: 99999, installmentNumber: 1, installmentsTotal: 1, dueDate: '2026-11-01', status: 'cancelled' },
      ],
      receivedByDebt: new Map([['x4', 4000]]),
      purchases: [{ id: 'p1', cardId: 'c1', description: 'TV', installmentNumber: 2, installmentsTotal: 6, amountCents: 20000, invoiceId: 'i1', purchaseDate: '2026-10-01' }],
      invoicesById: new Map([['i1', { id: 'i1', referenceMonth: '2026-11', dueDate: '2026-11-17', status: 'closed' }]]),
      cardsById: new Map([['c1', 'Nubank']]),
    });
    assert.deepEqual(o.items.map((i) => `${i.kind}:${i.description}:${i.installmentNumber}`),
      ['legacy:Antiga:1', 'installment:Moto:1', 'cash:Notebook:1', 'card:TV:2', 'installment:Moto:2']);
    const tv = o.items.find((i) => i.kind === 'card');
    assert.deepEqual([tv.cardName, tv.installmentsTotal, tv.amountCents, tv.referenceMonth, tv.dueDate, tv.status], ['Nubank', 6, 20000, '2026-11', '2026-11-17', 'pending']);
    assert.equal(o.items.find((i) => i.id === 'x3').status, 'paid');
    assert.equal(o.openCents, 170000);
    assert.equal(o.listedCents, 6000 + 20000 + 50000 + 50000); // paga e cancelada não entram
    assert.equal(o.unlistedCents, 170000 - 126000);
    assert.ok(o.listedCents + o.unlistedCents === o.openCents);
    // restante listado acima do em aberto é limitado (sem negativo)
    assert.equal(debtorObligations({ debtor: debtor({ lentCents: 1000, receivedCents: 0 }), purchases: [{ id: 'p', amountCents: 5000 }] }).unlistedCents, 0);
  });
});

describe('antecipar e quitar (VF-2-03n)', () => {
  const dv = (o = {}) => ({ id: 'd1', name: 'João', status: 'open', lentCents: 100000, receivedCents: 0, ...o });
  const pd = (id, n, principal, due, o = {}) => ({ id, debtorId: 'd1', description: 'Moto', principalCents: principal, installmentNumber: n, installmentsTotal: 3, debtGroupId: 'g1', dueDate: due, status: 'pending', ...o });
  const make = ({ debtor = dv(), debts = [], payments = [], accounts = [{ id: 'a1', status: 'active' }] } = {}) => {
    const atomic = [];
    return {
      atomic,
      io: {
        getById: async (u, c, id) => ({ debtors: [debtor], debts, accounts }[c] ?? []).find((x) => x.id === id) ?? null,
        list: async (u, c) => (c === 'debtPayments' ? payments : debts),
        commitAtomic: async (u, ops) => { atomic.push(ops); return ['x']; },
      },
    };
  };
  const rawS = (o = {}) => ({ date: '2026-11-19', accountId: 'a1', ...o });

  it('antecipação: pagar parcela futura (parcial e total) sinaliza `anticipated` e atualiza parcela e devedor', async () => {
    const future = pd('f1', 3, 30000, '2027-01-10');
    const { io, atomic } = make({ debts: [future] });
    const part = await registerDebtPayment(uid, 'f1', { amountCents: '100,00', date: '2026-11-19', accountId: 'a1' }, { ...io, list: async () => [] });
    assert.deepEqual([part.ok, part.anticipated, part.debtPaid], [true, true, false]);
    assert.equal(atomic.at(-1).find((o) => o.collection === 'debtors').data.receivedCents, 10000);
    const full = await registerDebtPayment(uid, 'f1', { amountCents: '300,00', date: '2026-11-19', accountId: 'a1' }, { ...io, list: async () => [] });
    assert.deepEqual([full.ok, full.anticipated, full.debtPaid], [true, true, true]);
    assert.ok(atomic.at(-1).some((o) => o.collection === 'debts' && o.data.status === 'paid'));
    const late = await registerDebtPayment(uid, 'f1', { amountCents: '300,00', date: '2027-01-10', accountId: 'a1' }, { ...io, list: async () => [] });
    assert.equal(late.anticipated, false); // no vencimento não é antecipação
  });

  it('quitar dívida (grupo): um recebimento por parcela com o restante, parcelas pagas, devedor soma o total', async () => {
    const debts = [pd('p1', 1, 33335, '2026-11-10'), pd('p2', 2, 33333, '2026-12-10'), pd('p3', 3, 33333, '2027-01-10'),
      pd('q1', 1, 20000, '2026-11-10', { debtGroupId: 'g2' }), pd('c1', 1, 5000, '2026-11-10', { debtGroupId: 'g1', status: 'cancelled' })];
    const payments = [{ debtId: 'p1', debtorId: 'd1', amountCents: 10000 }]; // p1 já recebeu 100,00
    const { io, atomic } = make({ debts, payments });
    const r = await settleDebts(uid, 'd1', { groupId: 'g1' }, rawS({ notes: 'quitação' }), io);
    assert.equal(r.ok, true);
    assert.equal(r.count, 3);
    assert.equal(r.totalCents, 23335 + 33333 + 33333);
    const ops = atomic[0];
    assert.deepEqual(ops.filter((o) => o.collection === 'debtPayments').map((o) => [o.data.debtId, o.data.amountCents]),
      [['p1', 23335], ['p2', 33333], ['p3', 33333]]);
    assert.deepEqual(ops.filter((o) => o.collection === 'debts').map((o) => o.docId), ['p1', 'p2', 'p3']); // g2 e cancelada intactas
    assert.ok(ops.filter((o) => o.collection === 'debts').every((o) => o.data.status === 'paid'));
    assert.deepEqual(ops.at(-1).data, { receivedCents: 90001, status: 'open' }); // 100000 emprestado: cartão/restante mantém aberto
    assert.equal(r.debtorPaid, false);
  });

  it('quitar todas as dívidas e quitar o devedor inteiro quando recebido == emprestado', async () => {
    const debts = [pd('p1', 1, 60000, '2026-11-10', { debtGroupId: undefined, installmentsTotal: undefined }), pd('q1', 1, 40000, '2026-12-10', { debtGroupId: 'g2' })];
    const { io, atomic } = make({ debts });
    const r = await settleDebts(uid, 'd1', {}, rawS(), io);
    assert.deepEqual([r.ok, r.count, r.totalCents, r.debtorPaid], [true, 2, 100000, true]);
    assert.deepEqual(atomic[0].at(-1).data, { receivedCents: 100000, status: 'paid' });
    const legacy = await settleDebts(uid, 'd1', { groupId: 'p1' }, rawS(), make({ debts }).io); // parcela legada: grupo = próprio id
    assert.equal(legacy.count, 1);
  });

  it('não quita sem parcelas pendentes, com conta inválida/inativa, devedor fechado, acima do pendente ou > 120 parcelas; nada é gravado', async () => {
    const one = [pd('p1', 1, 30000, '2026-11-10')];
    const cases = [
      [make({ debts: [pd('p1', 1, 1, '2026-11-10', { status: 'paid' })] }), rawS(), '_form'],
      [make({ debts: one, accounts: [] }), rawS(), 'accountId'],
      [make({ debts: one, accounts: [{ id: 'a1', status: 'archived' }] }), rawS(), 'accountId'],
      [make({ debts: one }), rawS({ date: '2026-02-30' }), 'date'],
      [make({ debts: one, debtor: dv({ status: 'cancelled' }) }), rawS(), '_form'],
      [make({ debts: one, debtor: dv({ lentCents: 10000 }) }), rawS(), '_form'], // restante 300 > pendente 100
      [make({ debts: Array.from({ length: 121 }, (_, i) => pd(`z${i}`, i + 1, 100, '2026-11-10')), debtor: dv({ lentCents: 99999999 }) }), rawS(), '_form'],
    ];
    for (const [{ io, atomic }, raw, field] of cases) {
      const r = await settleDebts(uid, 'd1', {}, raw, io);
      assert.equal(r.ok, false, field);
      assert.ok(r.errors[field], field);
      assert.equal(atomic.length, 0);
    }
  });
});
