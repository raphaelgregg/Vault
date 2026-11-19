/**
 * Testes do serviço de Devedores (VF-2-03b): modelo, cálculos, CRUD com `io` injetado.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createDebtor,
  updateDebtor,
  deleteDebtor,
  setDebtorStatus,
  cancelDebtor,
  reopenDebtor,
  getDebtorStatusOptions,
} from '../../js/services/debtors.js';
import {
  validateEntity,
  SCHEMAS,
  debtorPendingCents,
  summarizeDebtors,
  centsToMoneyString,
  parseMoneyToCents,
} from '../../js/core/model.js';
import { toFirestoreData, fromFirestoreDoc } from '../../js/services/firestore.js';
import { isDateFieldName } from '../../js/utils/dates.js';

const uid = 'u1';
const raw = (over = {}) => ({ name: ' João ', lentCents: '1.000,00', loanDate: '2026-11-10', ...over });

function makeIo(current, extra = {}) {
  const calls = { create: [], update: [], remove: [], audit: [], count: [] };
  const io = {
    getById: async () => current,
    create: async (u, c, data) => { calls.create.push({ u, c, data }); return 'new1'; },
    update: async (u, c, id, data) => { calls.update.push({ u, c, id, data }); },
    remove: async (u, c, id) => { calls.remove.push({ u, c, id }); },
    writeAudit: async (u, entry) => { calls.audit.push({ u, entry }); return { ok: true }; },
    count: async (u, c, opts) => { calls.count.push({ c, opts }); return 0; },
    ...extra,
  };
  return { io, calls };
}

describe('debtors — schema (espelha firestore.rules)', () => {
  it('chaves, enums e campo de data', () => {
    assert.deepEqual(
      Object.keys(SCHEMAS.debtors.fields).sort(),
      ['lentCents', 'loanDate', 'name', 'notes', 'receivedCents', 'status']
    );
    assert.deepEqual(getDebtorStatusOptions().map((o) => o.value), ['open', 'paid', 'cancelled']);
    assert.ok(isDateFieldName('loanDate'));
    assert.deepEqual(SCHEMAS.debtors.dateFields, ['loanDate']);
  });

  it('rejeita emprestado <= 0, recebido negativo e recebido > emprestado', () => {
    const base = { name: 'A', loanDate: '2026-11-10', status: 'open' };
    assert.ok(validateEntity('debtors', { ...base, lentCents: 0, receivedCents: 0 }).errors.lentCents);
    assert.ok(validateEntity('debtors', { ...base, lentCents: 100, receivedCents: -1 }).errors.receivedCents);
    assert.ok(validateEntity('debtors', { ...base, lentCents: 100, receivedCents: 101 }).errors.receivedCents);
    assert.equal(validateEntity('debtors', { ...base, lentCents: 100, receivedCents: 100 }).ok, true);
  });

  it('rejeita data inexistente, status inválido e campo extra', () => {
    const { errors } = validateEntity('debtors', {
      name: 'A', loanDate: '2026-02-30', lentCents: 100, receivedCents: 0, status: 'x', extra: 1,
    });
    assert.deepEqual(Object.keys(errors).sort(), ['extra', 'loanDate', 'status']);
  });

  it('data vira meio-dia UTC e volta ao mesmo dia', () => {
    const stored = toFirestoreData({ loanDate: '2026-11-10' });
    assert.equal(stored.loanDate.toDate().toISOString(), '2026-11-10T12:00:00.000Z');
    assert.equal(fromFirestoreDoc('x', stored).loanDate, '2026-11-10');
  });
});

describe('debtors — centsToMoneyString', () => {
  it('round-trip com parseMoneyToCents e entradas inválidas', () => {
    for (const c of [0, 5, 99, 100, 20000, 123456]) {
      assert.equal(parseMoneyToCents(centsToMoneyString(c)), c);
    }
    assert.equal(centsToMoneyString(-1), null);
    assert.equal(centsToMoneyString(1.5), null);
    assert.equal(centsToMoneyString('x'), null);
  });
});

describe('debtors — cálculos', () => {
  it('pendente = emprestado − recebido, nunca negativo', () => {
    assert.equal(debtorPendingCents({ lentCents: 1000, receivedCents: 250 }), 750);
    assert.equal(debtorPendingCents({ lentCents: 1000 }), 1000);
    assert.equal(debtorPendingCents({ lentCents: 100, receivedCents: 500 }), 0);
    assert.equal(debtorPendingCents({ lentCents: 'x' }), 0);
  });

  it('summarize: a receber só dos em aberto; cancelados fora de tudo', () => {
    const s = summarizeDebtors([
      { status: 'open', lentCents: 1000, receivedCents: 400 },
      { status: 'open', lentCents: 500, receivedCents: 0 },
      { status: 'paid', lentCents: 300, receivedCents: 300 },
      { status: 'cancelled', lentCents: 9999, receivedCents: 100 },
    ]);
    assert.deepEqual(s, { openCount: 2, pendingCents: 1100, receivedCents: 700 });
    assert.deepEqual(summarizeDebtors([]), { openCount: 0, pendingCents: 0, receivedCents: 0 });
  });
});

describe('debtors — service', () => {
  it('create: força receivedCents 0 e status open (ignora o que vier), grava e audita', async () => {
    const { io, calls } = makeIo(null);
    const r = await createDebtor(uid, raw({ receivedCents: 999, status: 'paid' }), io);
    assert.deepEqual([r.ok, r.id], [true, 'new1']);
    assert.deepEqual(calls.create[0].data, {
      name: 'João', loanDate: '2026-11-10', lentCents: 100000, receivedCents: 0, status: 'open',
    });
    assert.equal(calls.create[0].c, 'debtors');
    assert.deepEqual(
      [calls.audit[0].entry.action, calls.audit[0].entry.collection, calls.audit[0].entry.docId],
      ['create', 'debtors', 'new1']
    );
  });

  it('create inválido: sem escrita nem auditoria', async () => {
    const { io, calls } = makeIo(null);
    const r = await createDebtor(uid, raw({ lentCents: '0' }), io);
    assert.equal(r.ok, false);
    assert.ok(r.errors.lentCents);
    assert.equal(calls.create.length + calls.audit.length, 0);
  });

  it('update: preserva recebido/status, audita action update', async () => {
    const { io, calls } = makeIo({ id: 'd1', status: 'open', receivedCents: 20000, lentCents: 100000 });
    const r = await updateDebtor(uid, 'd1', raw({ lentCents: '500,00' }), io);
    assert.equal(r.ok, true);
    assert.equal(calls.update[0].data.receivedCents, 20000);
    assert.equal(calls.update[0].data.status, 'open');
    assert.equal(calls.update[0].data.lentCents, 50000);
    assert.equal(calls.audit[0].entry.action, 'update');
  });

  it('update: emprestado menor que o já recebido é erro em lentCents', async () => {
    const { io, calls } = makeIo({ id: 'd1', status: 'open', receivedCents: 20000 });
    const r = await updateDebtor(uid, 'd1', raw({ lentCents: '100,00' }), io);
    assert.equal(r.ok, false);
    assert.ok(r.errors.lentCents);
    assert.equal('receivedCents' in r.errors, false);
    assert.equal(calls.update.length, 0);
  });

  it('update: inexistente, cancelado e quitado são rejeitados sem escrita', async () => {
    for (const current of [null, { status: 'cancelled' }, { status: 'paid' }]) {
      const { io, calls } = makeIo(current);
      const r = await updateDebtor(uid, 'd1', raw(), io);
      assert.equal(r.ok, false);
      assert.ok(r.errors._form);
      assert.equal(calls.update.length + calls.audit.length, 0);
    }
  });

  it('delete: sem vínculos remove e audita com before; consulta debts e debtPayments por debtorId', async () => {
    const doc = { id: 'd1', name: 'João', status: 'open' };
    const { io, calls } = makeIo(doc);
    const r = await deleteDebtor(uid, 'd1', io);
    assert.equal(r.ok, true);
    assert.deepEqual(calls.count.map((c) => c.c).sort(), ['debtPayments', 'debts']);
    assert.deepEqual(calls.count[0].opts, { where: [['debtorId', '==', 'd1']] });
    assert.equal(calls.remove.length, 1);
    assert.deepEqual(calls.audit[0].entry, { action: 'delete', collection: 'debtors', docId: 'd1', before: doc });
  });

  it('delete: com vínculos bloqueia sem remover nem auditar', async () => {
    const { io, calls } = makeIo({ id: 'd1' }, { count: async (u, c) => (c === 'debts' ? 2 : 0) });
    const r = await deleteDebtor(uid, 'd1', io);
    assert.equal(r.ok, false);
    assert.match(r.errors._form, /2 dívidas/);
    assert.equal(calls.remove.length + calls.audit.length, 0);
  });

  it('delete: falha na contagem é fail-closed; inexistente é rejeitado', async () => {
    const orig = console.error;
    console.error = () => {};
    try {
      const failing = makeIo({ id: 'd1' }, { count: async () => { throw new Error('boom'); } });
      const r = await deleteDebtor(uid, 'd1', failing.io);
      assert.equal(r.ok, false);
      assert.equal(failing.calls.remove.length, 0);
    } finally {
      console.error = orig;
    }
    const { io } = makeIo(null);
    assert.equal((await deleteDebtor(uid, 'x', io)).ok, false);
  });

  it('status: cancela e reabre com auditoria cancel/reopen; paid e transições inválidas rejeitadas', async () => {
    let m = makeIo({ status: 'open' });
    assert.equal((await cancelDebtor(uid, 'd1', m.io)).ok, true);
    assert.deepEqual(m.calls.update[0].data, { status: 'cancelled' });
    assert.equal(m.calls.audit[0].entry.action, 'cancel');

    m = makeIo({ status: 'cancelled' });
    assert.equal((await reopenDebtor(uid, 'd1', m.io)).ok, true);
    assert.equal(m.calls.audit[0].entry.action, 'reopen');

    for (const [current, target] of [['paid', 'open'], ['paid', 'cancelled'], ['open', 'open'], ['open', 'paid'], ['cancelled', 'cancelled']]) {
      m = makeIo({ status: current });
      const r = await setDebtorStatus(uid, 'd1', target, m.io);
      assert.equal(r.ok, false, `${current}→${target}`);
      assert.equal(m.calls.update.length + m.calls.audit.length, 0);
    }
    assert.equal((await setDebtorStatus(uid, 'x', 'open', makeIo(null).io)).ok, false);
  });
});
