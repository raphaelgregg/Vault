/**
 * Testes de Parcelas e Recebimentos de devedores (VF-2-03b2): modelo, fluxo atômico e transições.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createDebt,
  cancelDebt,
  registerDebtPayment,
  getDebtStatusOptions,
} from '../../js/services/debtPayments.js';
import {
  SCHEMAS,
  validateEntity,
  applyPaymentToDebtor,
  accountBalances,
} from '../../js/core/model.js';
import { commitAtomic } from '../../js/services/firestore.js';

const uid = 'u1';
const debtor = (over = {}) => ({ id: 'dev1', status: 'open', lentCents: 100000, receivedCents: 0, ...over });
const debt = (over = {}) => ({ id: 'd1', debtorId: 'dev1', principalCents: 50000, status: 'pending', ...over });
const account = (over = {}) => ({ id: 'acc1', status: 'active', ...over });
const rawPay = (over = {}) => ({ amountCents: '500,00', date: '2026-11-18', accountId: 'acc1', ...over });

function makeIo({ debts = [debt()], debtors = [debtor()], accounts = [account()], payments = [], listDebts = [] } = {}) {
  const calls = { atomic: [], update: [], create: [], audit: [] };
  const io = {
    getById: async (u, c, id) => {
      const table = { debts, debtors, accounts }[c] ?? [];
      return table.find((x) => x.id === id) ?? null;
    },
    list: async (u, c) => (c === 'debtPayments' ? payments : listDebts),
    commitAtomic: async (u, ops) => { calls.atomic.push(ops); return ['pay1']; },
    create: async (u, c, data) => { calls.create.push({ c, data }); return 'new1'; },
    update: async (u, c, id, data) => { calls.update.push({ c, id, data }); },
    writeAudit: async (u, e) => { calls.audit.push(e); return { ok: true }; },
  };
  return { io, calls };
}

describe('debts/debtPayments — schema', () => {
  it('chaves e datas espelham as Rules', () => {
    assert.deepEqual(Object.keys(SCHEMAS.debts.fields).sort(),
      ['debtGroupId', 'debtorId', 'description', 'dueDate', 'installmentNumber', 'installmentsTotal', 'principalCents', 'status']);
    assert.deepEqual(Object.keys(SCHEMAS.debtPayments.fields).sort(),
      ['accountId', 'amountCents', 'date', 'debtId', 'debtorId', 'notes', 'purchaseId']);
    assert.deepEqual(SCHEMAS.debts.dateFields, ['dueDate']);
    assert.deepEqual(getDebtStatusOptions().map((o) => o.value), ['pending', 'paid', 'late', 'cancelled']);
  });

  it('installmentNumber: inteiro 1..360', () => {
    const base = { debtorId: 'x', description: 'P1', principalCents: 100, dueDate: '2026-12-01', status: 'pending' };
    for (const n of [0, 361, 1.5, 'abc']) {
      assert.ok(validateEntity('debts', { ...base, installmentNumber: n }).errors.installmentNumber, String(n));
    }
    assert.equal(validateEntity('debts', { ...base, installmentNumber: 360 }).ok, true);
  });
});

describe('applyPaymentToDebtor (puro)', () => {
  it('parcial mantém open; total quita; excesso e inválidos rejeitados', () => {
    assert.deepEqual(applyPaymentToDebtor(debtor(), 30000), { ok: true, receivedCents: 30000, status: 'open' });
    assert.deepEqual(applyPaymentToDebtor(debtor({ receivedCents: 30000 }), 70000), { ok: true, receivedCents: 100000, status: 'paid' });
    assert.equal(applyPaymentToDebtor(debtor(), 100001).ok, false);
    assert.equal(applyPaymentToDebtor(debtor(), 0).ok, false);
    assert.equal(applyPaymentToDebtor(debtor(), 10.5).ok, false);
    assert.equal(applyPaymentToDebtor(debtor({ status: 'cancelled' }), 100).ok, false);
    assert.equal(applyPaymentToDebtor(debtor({ status: 'paid', receivedCents: 100000 }), 1).ok, false);
  });
});

describe('createDebt', () => {
  it('cria pendente, numera sequencialmente e audita', async () => {
    const { io, calls } = makeIo({ listDebts: [{ installmentNumber: 1 }, { installmentNumber: 2 }] });
    const r = await createDebt(uid, { debtorId: 'dev1', description: 'Parcela', principalCents: '500,00', dueDate: '2026-12-10' }, io);
    assert.equal(r.ok, true);
    assert.deepEqual(calls.create[0].data, {
      debtorId: 'dev1', description: 'Parcela', principalCents: 50000, dueDate: '2026-12-10', installmentNumber: 3, status: 'pending',
    });
    assert.equal(calls.audit[0].action, 'create');
  });

  it('ignora status enviado, rejeita devedor inexistente/não aberto', async () => {
    const { io, calls } = makeIo({ debtors: [debtor({ status: 'cancelled' })] });
    const bad = await createDebt(uid, { debtorId: 'dev1', description: 'x', principalCents: '1', dueDate: '2026-12-10' }, io);
    assert.equal(bad.ok, false);
    const none = await createDebt(uid, { debtorId: 'zzz', description: 'x', principalCents: '1', dueDate: '2026-12-10' }, io);
    assert.ok(none.errors.debtorId);
    assert.equal(calls.create.length, 0);
    const { io: io2, calls: c2 } = makeIo();
    await createDebt(uid, { debtorId: 'dev1', description: 'x', principalCents: '1', dueDate: '2026-12-10', installmentNumber: 2, status: 'paid' }, io2);
    assert.equal(c2.create[0].data.status, 'pending');
  });
});

describe('registerDebtPayment — fluxo atômico', () => {
  it('quitação total da parcela e do devedor: 1 lote com recebimento, parcela paga e devedor paid', async () => {
    const { io, calls } = makeIo({ debtors: [debtor({ lentCents: 50000 })] });
    const r = await registerDebtPayment(uid, 'd1', rawPay(), io);
    assert.deepEqual([r.ok, r.id, r.debtPaid, r.debtorPaid], [true, 'pay1', true, true]);
    assert.equal(calls.atomic.length, 1);
    const [pay, debtOp, debtorOp] = calls.atomic[0];
    assert.deepEqual(pay.data, { debtId: 'd1', debtorId: 'dev1', amountCents: 50000, date: '2026-11-18', accountId: 'acc1' });
    assert.deepEqual(debtOp, { type: 'update', collection: 'debts', docId: 'd1', data: { status: 'paid' }, action: 'pay' });
    // total do devedor por `increment` atômico (não valor absoluto de leitura velha); `status: paid` só quando zera o pendente
    assert.deepEqual([debtorOp.data, debtorOp.increments], [{ status: 'paid' }, { receivedCents: 50000 }]);
    assert.equal(debtorOp.action, 'receive');
    assert.equal(calls.create.length + calls.update.length, 0); // nada fora do lote
  });

  it('recebimento parcial: parcela e devedor continuam abertos (sem op de parcela)', async () => {
    const { io, calls } = makeIo();
    const r = await registerDebtPayment(uid, 'd1', rawPay({ amountCents: '200,00' }), io);
    assert.deepEqual([r.ok, r.debtPaid, r.debtorPaid], [true, false, false]);
    const ops = calls.atomic[0];
    assert.equal(ops.length, 2);
    assert.deepEqual([ops[1].data, ops[1].increments], [{}, { receivedCents: 20000 }]); // parcial: não reescreve o status
  });

  it('considera recebimentos anteriores da parcela e quita ao completar', async () => {
    const { io, calls } = makeIo({ payments: [{ amountCents: 20000 }], debtors: [debtor({ receivedCents: 20000 })] });
    const r = await registerDebtPayment(uid, 'd1', rawPay({ amountCents: '300,00' }), io);
    assert.equal(r.debtPaid, true);
    assert.deepEqual([calls.atomic[0][2].data, calls.atomic[0][2].increments], [{}, { receivedCents: 30000 }]);
    const over = await registerDebtPayment(uid, 'd1', rawPay({ amountCents: '300,01' }), io);
    assert.ok(over.errors.amountCents);
  });

  it('rejeita excesso sobre o pendente do devedor', async () => {
    const { io, calls } = makeIo({ debts: [debt({ principalCents: 90000 })], debtors: [debtor({ lentCents: 60000 })] });
    const r = await registerDebtPayment(uid, 'd1', rawPay({ amountCents: '700,00' }), io);
    assert.ok(r.errors.amountCents);
    assert.equal(calls.atomic.length, 0);
  });

  it('rejeita parcela inexistente/paga/cancelada, devedor não aberto, conta inválida e dados inválidos', async () => {
    const run = (setup, raw = rawPay(), id = 'd1') => {
      const { io, calls } = makeIo(setup);
      return registerDebtPayment(uid, id, raw, io).then((r) => ({ r, calls }));
    };
    assert.equal((await run({}, rawPay(), 'zzz')).r.ok, false);
    assert.equal((await run({ debts: [debt({ status: 'paid' })] })).r.ok, false);
    assert.equal((await run({ debts: [debt({ status: 'cancelled' })] })).r.ok, false);
    assert.equal((await run({ debtors: [debtor({ status: 'cancelled' })] })).r.ok, false);
    assert.ok((await run({ accounts: [] })).r.errors.accountId);
    assert.ok((await run({ accounts: [account({ status: 'archived' })] })).r.errors.accountId);
    assert.ok((await run({}, rawPay({ amountCents: '0' }))).r.errors.amountCents);
    assert.ok((await run({}, rawPay({ date: '18/11/2026' }))).r.errors.date);
    const { calls } = await run({ debtors: [debtor({ status: 'paid', receivedCents: 100000 })] });
    assert.equal(calls.atomic.length, 0);
  });

  it('aceita parcela atrasada (late)', async () => {
    const { io } = makeIo({ debts: [debt({ status: 'late' })] });
    assert.equal((await registerDebtPayment(uid, 'd1', rawPay({ amountCents: '10,00' }), io)).ok, true);
  });
});

describe('cancelDebt', () => {
  it('cancela pendente sem recebimentos com auditoria `cancel`', async () => {
    const { io, calls } = makeIo();
    assert.equal((await cancelDebt(uid, 'd1', io)).ok, true);
    assert.deepEqual(calls.update[0], { c: 'debts', id: 'd1', data: { status: 'cancelled' } });
    assert.equal(calls.audit[0].action, 'cancel');
  });
  it('bloqueia paga, com recebimentos ou inexistente', async () => {
    assert.equal((await cancelDebt(uid, 'd1', makeIo({ debts: [debt({ status: 'paid' })] }).io)).ok, false);
    assert.equal((await cancelDebt(uid, 'd1', makeIo({ payments: [{ amountCents: 1 }] }).io)).ok, false);
    assert.equal((await cancelDebt(uid, 'x', makeIo().io)).ok, false);
  });
});

describe('commitAtomic (lote)', () => {
  it('monta set/update + auditoria no mesmo lote e commita uma vez; datas em Timestamp', async () => {
    const log = [];
    let n = 0;
    const batch = {
      set: (ref, data) => log.push(['set', ref.path, data]),
      update: (ref, data) => log.push(['update', ref.path, data]),
      commit: async () => log.push(['commit']),
    };
    const io = {
      newBatch: () => batch,
      userDoc: (u, c, id) => ({ id, path: `${c}/${id}` }),
      newDocRef: (u, c) => ({ id: `n${++n}`, path: `${c}/n${n}` }),
    };
    const ids = await commitAtomic(uid, [
      { type: 'create', collection: 'debtPayments', data: { amountCents: 100, date: '2026-11-18' } },
      { type: 'update', collection: 'debtors', docId: 'dev1', data: { receivedCents: 100 }, action: 'receive' },
    ], io);
    assert.deepEqual(ids, ['n1', 'dev1']);
    assert.deepEqual(log.map((l) => l[0]), ['set', 'set', 'update', 'set', 'commit']);
    assert.equal(log[0][2].date.toDate().toISOString(), '2026-11-18T12:00:00.000Z');
    assert.equal(log[1][2].action, 'create');
    assert.equal(log[1][2].entity, 'debtPayments');
    assert.equal(log[3][2].action, 'receive');
  });
});

describe('accountBalances com recebimentos', () => {
  it('soma debtPayments na conta de destino', () => {
    const b = accountBalances([{ id: 'a', initialBalanceCents: 1000 }], { debtPayments: [{ accountId: 'a', amountCents: 500 }] });
    assert.equal(b.get('a'), 1500);
  });
});
