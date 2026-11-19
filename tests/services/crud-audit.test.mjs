/**
 * VF-3-01 — helpers CRUD+auditoria (firestore.js) e delegação pelos services.
 * Tudo via injeção de `io`/`deps`; sem rede nem emulador.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createAudited, updateAudited, removeAudited, commitAtomic } from '../../js/services/firestore.js';
import { createAccount, updateAccount, deleteAccount } from '../../js/services/accounts.js';
import { createCategory, updateCategory, deleteCategory } from '../../js/services/categories.js';
import { createTransfer, updateTransfer, deleteTransfer } from '../../js/services/transfers.js';
import {
  createIncome, updateIncome, deleteIncome, markIncomeReceived, cancelIncome,
} from '../../js/services/incomes.js';
import {
  createExpense, updateExpense, deleteExpense, markExpensePaid, cancelExpense,
} from '../../js/services/expenses.js';

const uid = 'u1';

function makeIo(extra = {}) {
  const calls = { create: [], update: [], remove: [], audit: [] };
  const io = {
    create: async (u, c, data) => { calls.create.push({ u, c, data }); return 'new1'; },
    update: async (u, c, id, data) => { calls.update.push({ u, c, id, data }); },
    remove: async (u, c, id) => { calls.remove.push({ u, c, id }); },
    writeAudit: async (u, entry) => { calls.audit.push({ u, entry }); return { ok: true }; },
    ...extra,
  };
  return { io, calls };
}

describe('helpers createAudited/updateAudited/removeAudited', () => {
  it('createAudited grava e audita com o id retornado', async () => {
    const { io, calls } = makeIo();
    const id = await createAudited(uid, 'accounts', { a: 1 }, io);
    assert.equal(id, 'new1');
    assert.deepEqual(calls.audit[0], {
      u: uid, entry: { action: 'create', collection: 'accounts', docId: 'new1', after: { a: 1 } },
    });
  });

  it('updateAudited usa action customizada e after = patch', async () => {
    const { io, calls } = makeIo();
    await updateAudited(uid, 'incomes', 'i1', { status: 'cancelled' }, io, 'cancel');
    assert.deepEqual(calls.update, [{ u: uid, c: 'incomes', id: 'i1', data: { status: 'cancelled' } }]);
    assert.deepEqual(calls.audit[0].entry,
      { action: 'cancel', collection: 'incomes', docId: 'i1', after: { status: 'cancelled' } });
  });

  it('removeAudited audita com before', async () => {
    const { io, calls } = makeIo();
    await removeAudited(uid, 'accounts', 'a1', { name: 'x' }, io);
    assert.equal(calls.remove.length, 1);
    assert.deepEqual(calls.audit[0].entry,
      { action: 'delete', collection: 'accounts', docId: 'a1', before: { name: 'x' } });
  });

  it('falha na escrita principal propaga e NÃO audita', async () => {
    const { io, calls } = makeIo({ create: async () => { throw new Error('negado'); } });
    await assert.rejects(() => createAudited(uid, 'accounts', {}, io), /negado/);
    assert.equal(calls.audit.length, 0);
  });

  it('falha na auditoria ({ok:false}) não derruba a operação', async () => {
    const { io, calls } = makeIo({ writeAudit: async () => ({ ok: false, error: new Error('x') }) });
    await updateAudited(uid, 'accounts', 'a1', { name: 'y' }, io);
    assert.equal(calls.update.length, 1);
  });
});

describe('services delegam aos helpers (criar/atualizar/excluir/status)', () => {
  const account = {
    institution: 'Banco', name: 'Conta', type: 'checking',
    initialBalanceCents: '10,00', color: '#1f7a5c', status: 'active',
  };
  const category = { name: 'Salário', kind: 'income', color: '#1f7a5c' };
  const transfer = {
    fromAccountId: 'a1', toAccountId: 'a2', amountCents: '1,00',
    date: '2026-11-16', reason: 'x', status: 'pending',
  };
  const income = {
    description: 'Sal', categoryId: 'c1', amountCents: '5,00', expectedDate: '2026-12-05',
    accountId: 'a1', status: 'pending', recurrence: 'none',
  };
  const expense = {
    description: 'Mer', categoryId: 'c1', amountCents: '5,00', accountId: 'a1',
    purchaseDate: '2026-11-10', dueDate: '2026-11-20', status: 'pending', recurrence: 'none',
  };
  const okCategory = { lookupCategory: async () => ({ id: 'c1', kind: 'both', archived: false }) };

  const cases = [
    ['accounts', createAccount, updateAccount, account, {}],
    ['categories', createCategory, updateCategory, category, {}],
    ['transfers', createTransfer, updateTransfer, transfer, {}],
    ['incomes', createIncome, updateIncome, income, okCategory],
    ['expenses', createExpense, updateExpense, expense, okCategory],
  ];

  for (const [name, createFn, updateFn, raw, extra] of cases) {
    it(`${name}: create e update gravam e auditam`, async () => {
      const { io, calls } = makeIo(extra);
      const created = await createFn(uid, raw, io);
      assert.deepEqual([created.ok, created.id], [true, 'new1']);
      assert.equal(calls.create[0].c, name);
      assert.equal(calls.audit[0].entry.action, 'create');
      assert.equal(calls.audit[0].entry.collection, name);

      const updated = await updateFn(uid, 'x1', raw, io);
      assert.equal(updated.ok, true);
      assert.equal(calls.update[0].id, 'x1');
      assert.equal(calls.audit[1].entry.action, 'update');
    });

    it(`${name}: dados inválidos não gravam nem auditam`, async () => {
      const { io, calls } = makeIo(extra);
      const result = await createFn(uid, {}, io);
      assert.equal(result.ok, false);
      assert.equal(calls.create.length + calls.audit.length, 0);
    });
  }

  const deletes = [
    ['accounts', deleteAccount, { count: async () => 0 }],
    ['categories', deleteCategory, { count: async () => 0 }],
    ['transfers', deleteTransfer, {}],
  ];

  for (const [name, deleteFn, extra] of deletes) {
    it(`${name}: delete remove e audita com before`, async () => {
      const { io, calls } = makeIo({ ...extra, getById: async () => ({ id: 'd1', name: 'x' }) });
      const result = await deleteFn(uid, 'd1', io);
      assert.equal(result.ok, true);
      assert.equal(calls.remove[0].id, 'd1');
      assert.deepEqual(calls.audit[0].entry,
        { action: 'delete', collection: name, docId: 'd1', before: { id: 'd1', name: 'x' } });
    });

    it(`${name}: delete de inexistente não remove nem audita`, async () => {
      const { io, calls } = makeIo({ ...extra, getById: async () => null });
      const result = await deleteFn(uid, 'nope', io);
      assert.equal(result.ok, false);
      assert.equal(calls.remove.length + calls.audit.length, 0);
    });
  }

  for (const [name, deleteFn] of [['accounts', deleteAccount], ['categories', deleteCategory]]) {
    it(`${name}: em uso ou falha de contagem bloqueia sem remover/auditar`, async () => {
      for (const count of [async () => 2, async () => { throw new Error('offline'); }]) {
        const { io, calls } = makeIo({ count, getById: async () => ({ id: 'd1' }) });
        const result = await deleteFn(uid, 'd1', io);
        assert.equal(result.ok, false);
        assert.equal(calls.remove.length + calls.audit.length, 0);
      }
    });
  }

  it('markIncomeReceived / cancelIncome auditam com action própria', async () => {
    const { io, calls } = makeIo();
    await markIncomeReceived(uid, 'i1', '2026-11-18', io);
    await cancelIncome(uid, 'i1', io);
    assert.deepEqual(calls.update[0].data, { status: 'received', receivedDate: '2026-11-18' });
    assert.deepEqual(calls.audit.map((a) => a.entry.action), ['mark_received', 'cancel']);
    assert.deepEqual(calls.audit[1].entry.after, { status: 'cancelled' });
  });

  it('markExpensePaid / cancelExpense auditam com action própria', async () => {
    const { io, calls } = makeIo();
    await markExpensePaid(uid, 'e1', '2026-11-18', io);
    await cancelExpense(uid, 'e1', io);
    assert.deepEqual(calls.update[0].data, { status: 'paid', paidDate: '2026-11-18' });
    assert.deepEqual(calls.audit.map((a) => a.entry.action), ['mark_paid', 'cancel']);
  });
});

describe('exclusão atômica de despesas e receitas (VF-2-03o)', () => {
  for (const [name, deleteFn, paidStatus] of [['expenses', deleteExpense, 'paid'], ['incomes', deleteIncome, 'received']]) {
    it(`${name}: um lote com delete + auditoria e estorno informado (pago/recebido com conta)`, async () => {
      const doc = { id: 'x1', status: paidStatus, accountId: 'a1', amountCents: 12345 };
      const batches = [];
      const r = await deleteFn(uid, 'x1', { getById: async () => doc, commitAtomic: async (u, ops) => { batches.push(ops); return ['x1']; } });
      assert.deepEqual(r, { ok: true, reversedCents: 12345, accountId: 'a1' });
      assert.deepEqual(batches, [[{ type: 'delete', collection: name, docId: 'x1', before: doc }]]);
    });
    it(`${name}: pendente/sem conta não informa estorno; inexistente não grava`, async () => {
      for (const doc of [{ id: 'x1', status: 'pending', accountId: 'a1', amountCents: 500 }, { id: 'x1', status: paidStatus, amountCents: 500 }]) {
        const r = await deleteFn(uid, 'x1', { getById: async () => doc, commitAtomic: async () => ['x1'] });
        assert.deepEqual([r.ok, r.reversedCents, r.accountId], [true, 0, null]);
      }
      let called = false;
      const r = await deleteFn(uid, 'x1', { getById: async () => null, commitAtomic: async () => { called = true; } });
      assert.equal(r.ok, false);
      assert.equal(called, false);
    });
  }
  it('commitAtomic: op delete apaga o doc e grava a auditoria com `before` no MESMO lote', async () => {
    const calls = [];
    const batch = { set: (ref, data) => calls.push(['set', ref.path, data]), update: () => {}, delete: (ref) => calls.push(['delete', ref.path]), commit: async () => calls.push(['commit']) };
    const ids = await commitAtomic(uid, [{ type: 'delete', collection: 'expenses', docId: 'x1', before: { id: 'x1', amountCents: 5 } }], {
      newBatch: () => batch,
      userDoc: (u, c, id) => ({ path: `${c}/${id}`, id }),
      newDocRef: (u, c) => ({ path: `${c}/auto`, id: 'auto' }),
    });
    assert.deepEqual(ids, ['x1']);
    assert.deepEqual(calls.map((c) => c[0]), ['delete', 'set', 'commit']);
    assert.equal(calls[1][1], 'auditLog/auto');
    assert.deepEqual([calls[1][2].action, calls[1][2].entity, calls[1][2].entityId, calls[1][2].before], ['delete', 'expenses', 'x1', { id: 'x1', amountCents: 5 }]);
  });
});
