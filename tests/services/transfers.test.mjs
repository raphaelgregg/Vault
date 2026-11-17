/**
 * Testes do serviço de Transferências (Fase 3).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  getTransferStatusOptions,
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