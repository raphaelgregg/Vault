/**
 * VF-2-03h: avanço de nextChargeDate ao registrar cobrança e bloqueio de deleteCategory por assinaturas.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { registerSubscriptionCharge } from '../../js/services/subscriptions.js';
import { deleteCategory } from '../../js/services/categories.js';
import { advanceChargeDate } from '../../js/core/model.js';
import { toFirestoreData } from '../../js/services/firestore.js';

const uid = 'u1';
const sub = (o = {}) => ({ id: 's1', status: 'active', periodicity: 'monthly', nextChargeDate: '2026-11-18', ...o });
function makeIo(current) {
  const calls = { update: [], audit: [] };
  return {
    calls,
    io: {
      getById: async () => current,
      update: async (u, c, id, data) => { calls.update.push({ c, id, data }); },
      writeAudit: async (u, e) => { calls.audit.push(e); return { ok: true }; },
    },
  };
}

describe('advanceChargeDate (puro)', () => {
  it('semanal soma 7 dias, inclusive virando mês/ano', () => {
    assert.equal(advanceChargeDate('2026-11-18', 'weekly'), '2026-11-25');
    assert.equal(advanceChargeDate('2026-12-29', 'weekly'), '2027-01-05');
  });
  it('mensal mantém o dia, vira o ano e faz clamp ao fim do mês', () => {
    assert.equal(advanceChargeDate('2026-11-18', 'monthly'), '2026-12-18');
    assert.equal(advanceChargeDate('2026-12-15', 'monthly'), '2027-01-15');
    assert.equal(advanceChargeDate('2026-01-31', 'monthly'), '2026-02-28');
    assert.equal(advanceChargeDate('2028-01-31', 'monthly'), '2028-02-29');
    assert.equal(advanceChargeDate('2026-03-31', 'monthly'), '2026-04-30');
  });
  it('anual mantém dia/mês e faz clamp de 29/02', () => {
    assert.equal(advanceChargeDate('2026-11-18', 'yearly'), '2027-11-18');
    assert.equal(advanceChargeDate('2028-02-29', 'yearly'), '2029-02-28');
  });
  it('entradas inválidas retornam null', () => {
    assert.equal(advanceChargeDate('2026-02-30', 'monthly'), null);
    assert.equal(advanceChargeDate('18/11/2026', 'monthly'), null);
    assert.equal(advanceChargeDate('2026-11-18', 'daily'), null);
    assert.equal(advanceChargeDate(undefined, 'weekly'), null);
  });
  it('resultado é gravado em meio-dia UTC pela camada de serviço', () => {
    const { nextChargeDate } = toFirestoreData({ nextChargeDate: advanceChargeDate('2026-11-18', 'monthly') });
    assert.equal(nextChargeDate.toDate().toISOString(), '2026-12-18T12:00:00.000Z');
  });
});

describe('registerSubscriptionCharge', () => {
  it('avança a data, grava só nextChargeDate e audita `charge`', async () => {
    const { io, calls } = makeIo(sub());
    const r = await registerSubscriptionCharge(uid, 's1', io);
    assert.deepEqual(r, { ok: true, nextChargeDate: '2026-12-18' });
    assert.deepEqual(calls.update, [{ c: 'subscriptions', id: 's1', data: { nextChargeDate: '2026-12-18' } }]);
    assert.equal(calls.audit[0].action, 'charge');
    assert.deepEqual(calls.audit[0].after, { nextChargeDate: '2026-12-18' });
  });
  it('respeita a periodicidade (semanal/anual)', async () => {
    assert.equal((await registerSubscriptionCharge(uid, 's1', makeIo(sub({ periodicity: 'weekly' })).io)).nextChargeDate, '2026-11-25');
    assert.equal((await registerSubscriptionCharge(uid, 's1', makeIo(sub({ periodicity: 'yearly' })).io)).nextChargeDate, '2027-11-18');
  });
  it('rejeita pausada, cancelada, inexistente e dados inválidos sem gravar', async () => {
    for (const current of [sub({ status: 'paused' }), sub({ status: 'cancelled' }), null, sub({ nextChargeDate: 'x' }), sub({ periodicity: 'daily' })]) {
      const { io, calls } = makeIo(current);
      assert.equal((await registerSubscriptionCharge(uid, 's1', io)).ok, false);
      assert.equal(calls.update.length + calls.audit.length, 0);
    }
  });
});

describe('deleteCategory — assinaturas vinculadas', () => {
  const run = (counts, extra = {}) => {
    const calls = { remove: 0 };
    const io = {
      getById: async () => ({ id: 'c1', name: 'Streaming' }),
      count: async (u, collection) => counts[collection] ?? 0,
      remove: async () => { calls.remove += 1; },
      writeAudit: async () => ({ ok: true }),
      ...extra,
    };
    return deleteCategory(uid, 'c1', io).then((r) => ({ r, calls }));
  };
  it('bloqueia quando só há assinaturas (qualquer status) e informa o vínculo', async () => {
    const { r, calls } = await run({ subscriptions: 2 });
    assert.equal(r.ok, false);
    assert.match(r.errors._form, /assinaturas/);
    assert.equal(calls.remove, 0);
  });
  it('exclui quando não há vínculos', async () => {
    const { r, calls } = await run({});
    assert.equal(r.ok, true);
    assert.equal(calls.remove, 1);
  });
  it('fail-closed se a contagem de assinaturas falhar', async () => {
    const orig = console.error; console.error = () => {};
    const { r, calls } = await run({}, { count: async (u, c) => { if (c === 'subscriptions') throw new Error('x'); return 0; } });
    console.error = orig;
    assert.equal(r.ok, false);
    assert.equal(calls.remove, 0);
  });
});
