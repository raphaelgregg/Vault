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

  // VF-ARQ-02: contas e categorias seguem CRUD direto + auditoria; transferências/receitas/despesas NASCEM no servidor
  // (criação) e só os não liquidados são editados direto. `finance` falso registra a intenção.
  const server = () => {
    const ops = [];
    return { ops, finance: async (op, params) => { ops.push(op); return { ok: true, id: 'new1', transferId: 'new1', ...params }; } };
  };
  const pendingDoc = { getById: async (_u, _c, id) => ({ id, status: 'pending', initialBalanceCents: 1000 }) };

  const direct = [
    ['accounts', createAccount, updateAccount, account, pendingDoc],
    ['categories', createCategory, updateCategory, category, {}],
  ];
  for (const [name, createFn, updateFn, raw, extra] of direct) {
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
  }

  const viaServer = [
    ['transfers', createTransfer, updateTransfer, transfer, {}, 'transfer.create'],
    ['incomes', createIncome, updateIncome, income, okCategory, 'income.create'],
    ['expenses', createExpense, updateExpense, expense, okCategory, 'expense.create'],
  ];
  for (const [name, createFn, updateFn, raw, extra, opName] of viaServer) {
    it(`${name}: create vai ao SERVIDOR (sem gravação direta); update de item não liquidado grava e audita`, async () => {
      const api = server();
      const { io, calls } = makeIo({ ...extra, ...pendingDoc, finance: api.finance });
      const created = await createFn(uid, raw, io);
      assert.deepEqual([created.ok, created.id], [true, 'new1']);
      assert.deepEqual(api.ops, [opName]);
      assert.equal(calls.create.length, 0);

      const updated = await updateFn(uid, 'x1', raw, io);
      assert.equal(updated.ok, true);
      assert.equal(calls.update[0].id, 'x1');
      assert.equal(calls.audit[0].entry.action, 'update');
    });
  }

  for (const [name, createFn, , , extra] of [...direct, ...viaServer]) {
    it(`${name}: dados inválidos não gravam nem auditam`, async () => {
      const api = server();
      const { io, calls } = makeIo({ ...extra, finance: api.finance });
      const result = await createFn(uid, {}, io);
      assert.equal(result.ok, false);
      assert.equal(calls.create.length + calls.audit.length + api.ops.length, 0);
    });
  }

  const deletes = [
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

  it('accounts: exclusão e arquivamento são do SERVIDOR (sem remoção/auditoria direta no cliente)', async () => {
    const api = server();
    const { io, calls } = makeIo({ finance: api.finance, getById: async () => ({ id: 'd1' }) });
    assert.equal((await deleteAccount(uid, 'd1', io)).ok, true);
    assert.deepEqual(api.ops, ['account.delete']);
    assert.equal(calls.remove.length + calls.audit.length, 0);
  });

  it('categories: em uso ou falha de contagem bloqueia sem remover/auditar', async () => {
    for (const count of [async () => 2, async () => { throw new Error('offline'); }]) {
      const { io, calls } = makeIo({ count, getById: async () => ({ id: 'd1' }) });
      const result = await deleteCategory(uid, 'd1', io);
      assert.equal(result.ok, false);
      assert.equal(calls.remove.length + calls.audit.length, 0);
    }
  });

  it('markIncomeReceived / markExpensePaid vão ao SERVIDOR; cancelIncome / cancelExpense auditam com action própria', async () => {
    const api = server();
    const { io, calls } = makeIo({ getById: async (_u, c, id) => ({ id, status: 'pending' }), finance: api.finance });
    await markIncomeReceived(uid, 'i1', '2026-11-18', io);
    await markExpensePaid(uid, 'e1', '2026-11-18', io);
    assert.deepEqual(api.ops, ['income.receive', 'expense.pay']);
    assert.equal(calls.update.length, 0);
    await cancelIncome(uid, 'i1', io);
    await cancelExpense(uid, 'e1', io);
    assert.deepEqual(calls.audit.map((a) => a.entry.action), ['cancel', 'cancel']);
    assert.deepEqual(calls.audit[0].entry.after, { status: 'cancelled' });
  });
});

describe('exclusão de despesas e receitas (VF-2-03o / VF-ARQ-02)', () => {
  for (const [name, deleteFn, paidStatus] of [['expenses', deleteExpense, 'paid'], ['incomes', deleteIncome, 'received']]) {
    it(`${name}: item ${paidStatus} NÃO é excluído (histórico): orienta estornar; nada é gravado`, async () => {
      const doc = { id: 'x1', status: paidStatus, accountId: 'a1', amountCents: 12345 };
      const batches = [];
      const r = await deleteFn(uid, 'x1', { getById: async () => doc, commitAtomic: async (u, ops) => { batches.push(ops); return ['x1']; } });
      assert.equal(r.ok, false);
      assert.match(r.errors._form, /estorn/i);
      assert.deepEqual(batches, []);
    });
    it(`${name}: pendente é excluído em um lote (delete + auditoria) sem estorno; inexistente não grava`, async () => {
      const doc = { id: 'x1', status: 'pending', accountId: 'a1', amountCents: 500 };
      const batches = [];
      const r = await deleteFn(uid, 'x1', { getById: async () => doc, commitAtomic: async (u, ops) => { batches.push(ops); return ['x1']; } });
      assert.deepEqual([r.ok, r.reversedCents, r.accountId], [true, 0, null]);
      assert.deepEqual(batches, [[{ type: 'delete', collection: name, docId: 'x1', before: doc }]]);
      let called = false;
      const none = await deleteFn(uid, 'x1', { getById: async () => null, commitAtomic: async () => { called = true; } });
      assert.equal(none.ok, false);
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
