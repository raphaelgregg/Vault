/**
 * Testes do serviço de Transferências (Fase 3).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  getTransferStatusOptions,
  confirmTransfer,
  cancelTransfer,
  canTransitionTransfer,
  formatCents,
  parseMoneyToCents,
} from '../../js/services/transfers.js';
import { buildEntity } from '../../js/core/model.js';

describe('transfers service — validação e helpers', () => {
  it('getTransferStatusOptions retorna status esperados', () => {
    const options = getTransferStatusOptions();
    assert.equal(options.length, 3);
    assert.deepEqual(options.map((o) => o.value), ['pending', 'confirmed', 'cancelled']);
  });

  it('formatCents formata corretamente', () => {
    assert.equal(formatCents(10000), 'R$ 100,00');
    assert.equal(formatCents(123456), 'R$ 1.234,56');
  });

  it('parseMoneyToCents aceita formatos pt-BR', () => {
    assert.equal(parseMoneyToCents('100,00'), 10000);
    assert.equal(parseMoneyToCents('1.234,56'), 123456);
  });

  it('buildEntity aceita transferência válida', () => {
    const valid = {
      fromAccountId: 'acc1',
      toAccountId: 'acc2',
      amountCents: '100,00',
      date: '2026-11-16',
      reason: 'Reserva',
      status: 'confirmed',
    };
    const { ok, data } = buildEntity('transfers', valid);
    assert.ok(ok);
    assert.equal(data.amountCents, 10000);
    assert.equal(data.fromAccountId, 'acc1');
    assert.equal(data.toAccountId, 'acc2');
  });

  it('buildEntity rejeita fromAccountId === toAccountId', () => {
    const invalid = {
      fromAccountId: 'acc1',
      toAccountId: 'acc1',
      amountCents: '100,00',
      date: '2026-11-16',
      reason: 'Reserva',
      status: 'confirmed',
    };
    const { ok, errors } = buildEntity('transfers', invalid);
    assert.ok(!ok);
    assert.ok(errors.toAccountId);
    assert.match(errors.toAccountId, /diferente/);
  });

  it('buildEntity exige amountCents > 0', () => {
    const invalid = {
      fromAccountId: 'acc1',
      toAccountId: 'acc2',
      amountCents: '0,00',
      date: '2026-11-16',
      reason: 'Reserva',
      status: 'confirmed',
    };
    const { ok, errors } = buildEntity('transfers', invalid);
    assert.ok(!ok);
    assert.match(errors.amountCents, /maior que zero/);
  });

  it('buildEntity aceita notes opcional', () => {
    const valid = {
      fromAccountId: 'acc1',
      toAccountId: 'acc2',
      amountCents: '100,00',
      date: '2026-11-16',
      reason: 'Reserva',
      notes: 'Transferência para reserva',
      status: 'confirmed',
    };
    const { ok, data } = buildEntity('transfers', valid);
    assert.ok(ok);
    assert.equal(data.notes, 'Transferência para reserva');
  });

  it('buildEntity rejeita date inválida', () => {
    const invalid = {
      fromAccountId: 'acc1',
      toAccountId: 'acc2',
      amountCents: '100,00',
      date: '2026-02-30',
      reason: 'Reserva',
      status: 'confirmed',
    };
    const { ok, errors } = buildEntity('transfers', invalid);
    assert.ok(!ok);
    assert.ok(errors.date);
  });
});

describe('transfers service — transições de status (VF-2-01)', () => {
  const uid = 'u1';
  const transfer = (status) => ({ id: 't1', status, fromAccountId: 'a1', toAccountId: 'a2' });

  function makeIo({ status = 'pending', missing = [], failAccounts = false, exists = true } = {}) {
    const calls = { update: [], audit: [] };
    return {
      calls,
      io: {
        getById: async (_uid, collection, id) => {
          if (collection === 'transfers') return exists ? transfer(status) : null;
          if (failAccounts) throw new Error('unavailable');
          return missing.includes(id) ? null : { id };
        },
        update: async (_u, _c, id, data) => { calls.update.push({ id, data }); },
        writeAudit: async (_u, entry) => { calls.audit.push(entry); },
      },
    };
  }

  it('canTransitionTransfer cobre a matriz de transições', () => {
    assert.ok(canTransitionTransfer('pending', 'confirmed'));
    assert.ok(canTransitionTransfer('pending', 'cancelled'));
    assert.ok(canTransitionTransfer('confirmed', 'cancelled'));
    assert.ok(!canTransitionTransfer('confirmed', 'confirmed'));
    assert.ok(!canTransitionTransfer('confirmed', 'pending'));
    assert.ok(!canTransitionTransfer('cancelled', 'confirmed'));
    assert.ok(!canTransitionTransfer('cancelled', 'cancelled'));
    assert.ok(!canTransitionTransfer('bogus', 'confirmed'));
  });

  it('confirma transferência pendente e audita', async () => {
    const { io, calls } = makeIo();
    assert.deepEqual(await confirmTransfer(uid, 't1', io), { ok: true });
    assert.deepEqual(calls.update, [{ id: 't1', data: { status: 'confirmed' } }]);
    assert.equal(calls.audit.length, 1);
    assert.equal(calls.audit[0].action, 'confirm');
  });

  it('rejeita confirmar transferência cancelada (sem update nem auditoria)', async () => {
    const { io, calls } = makeIo({ status: 'cancelled' });
    const r = await confirmTransfer(uid, 't1', io);
    assert.equal(r.ok, false);
    assert.match(r.errors._form, /cancelada/);
    assert.equal(calls.update.length, 0);
    assert.equal(calls.audit.length, 0);
  });

  it('rejeita confirmar transferência já confirmada', async () => {
    const { io, calls } = makeIo({ status: 'confirmed' });
    const r = await confirmTransfer(uid, 't1', io);
    assert.equal(r.ok, false);
    assert.equal(calls.update.length, 0);
  });

  it('rejeita confirmar quando uma das contas não existe mais', async () => {
    const { io, calls } = makeIo({ missing: ['a2'] });
    const r = await confirmTransfer(uid, 't1', io);
    assert.equal(r.ok, false);
    assert.match(r.errors._form, /não existe mais/);
    assert.equal(calls.update.length, 0);
  });

  it('fail-closed: falha ao verificar contas bloqueia a confirmação', async () => {
    const { io, calls } = makeIo({ failAccounts: true });
    const r = await confirmTransfer(uid, 't1', io);
    assert.equal(r.ok, false);
    assert.equal(calls.update.length, 0);
  });

  it('cancela pendente e confirmada; rejeita cancelar já cancelada', async () => {
    for (const status of ['pending', 'confirmed']) {
      const { io, calls } = makeIo({ status });
      assert.deepEqual(await cancelTransfer(uid, 't1', io), { ok: true });
      assert.equal(calls.update[0].data.status, 'cancelled');
      assert.equal(calls.audit[0].action, 'cancel');
    }
    const { io, calls } = makeIo({ status: 'cancelled' });
    const r = await cancelTransfer(uid, 't1', io);
    assert.equal(r.ok, false);
    assert.equal(calls.update.length, 0);
  });

  it('cancelar não revalida contas (conta removida não impede cancelar)', async () => {
    const { io } = makeIo({ status: 'confirmed', missing: ['a1', 'a2'] });
    assert.equal((await cancelTransfer(uid, 't1', io)).ok, true);
  });

  it('transferência inexistente retorna erro', async () => {
    const { io, calls } = makeIo({ exists: false });
    const r = await confirmTransfer(uid, 'nope', io);
    assert.equal(r.ok, false);
    assert.match(r.errors._form, /não encontrada/);
    assert.equal(calls.update.length, 0);
  });
});
