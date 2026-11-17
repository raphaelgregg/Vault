/**
 * Testes do serviço de Despesas (Fase 3).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  getRecurrenceOptions,
  getExpenseStatusOptions,
  formatCents,
  parseMoneyToCents,
} from '../../js/services/expenses.js';
import { buildEntity } from '../../js/core/model.js';

describe('expenses service — validação e helpers', () => {
  it('getRecurrenceOptions retorna recorrências esperadas', () => {
    const options = getRecurrenceOptions();
    assert.equal(options.length, 4);
    assert.deepEqual(options.map((o) => o.value), ['none', 'monthly', 'weekly', 'yearly']);
  });

  it('getExpenseStatusOptions retorna status esperados', () => {
    const options = getExpenseStatusOptions();
    assert.equal(options.length, 3);
    assert.deepEqual(options.map((o) => o.value), ['pending', 'paid', 'cancelled']);
  });

  it('formatCents formata corretamente', () => {
    assert.equal(formatCents(25090), 'R$ 250,90');
    assert.equal(formatCents(100), 'R$ 1,00');
  });

  it('parseMoneyToCents aceita formatos pt-BR', () => {
    assert.equal(parseMoneyToCents('250,90'), 25090);
    assert.equal(parseMoneyToCents('1.234,56'), 123456);
  });

  it('buildEntity aceita despesa válida', () => {
    const valid = {
      description: 'Mercado',
      categoryId: 'cat1',
      amountCents: '250,90',
      accountId: 'acc1',
      purchaseDate: '2026-11-10',
      dueDate: '2026-11-20',
      status: 'pending',
      recurrence: 'none',
    };
    const { ok, data } = buildEntity('expenses', valid);
    assert.ok(ok);
    assert.equal(data.amountCents, 25090);
  });

  it('buildEntity aceita opcionais (paidDate, notes, installmentGroupId)', () => {
    const valid = {
      description: 'Mercado',
      categoryId: 'cat1',
      amountCents: '250,90',
      accountId: 'acc1',
      purchaseDate: '2026-11-10',
      dueDate: '2026-11-20',
      paidDate: '2026-11-18',
      status: 'paid',
      recurrence: 'none',
      notes: 'pago no débito',
      installmentGroupId: 'g1',
    };
    const { ok, data } = buildEntity('expenses', valid);
    assert.ok(ok);
    assert.equal(data.paidDate, '2026-11-18');
    assert.equal(data.notes, 'pago no débito');
    assert.equal(data.installmentGroupId, 'g1');
  });

  it('buildEntity rejeita notes > 500 caracteres', () => {
    const invalid = {
      description: 'Mercado',
      categoryId: 'cat1',
      amountCents: '250,90',
      accountId: 'acc1',
      purchaseDate: '2026-11-10',
      dueDate: '2026-11-20',
      status: 'pending',
      recurrence: 'none',
      notes: 'x'.repeat(501),
    };
    const { ok, errors } = buildEntity('expenses', invalid);
    assert.ok(!ok);
    assert.ok(errors.notes);
  });

  it('buildEntity rejeita dueDate inválida', () => {
    const invalid = {
      description: 'Mercado',
      categoryId: 'cat1',
      amountCents: '250,90',
      accountId: 'acc1',
      purchaseDate: '2026-11-10',
      dueDate: '2026-13-01',
      status: 'pending',
      recurrence: 'none',
    };
    const { ok, errors } = buildEntity('expenses', invalid);
    assert.ok(!ok);
    assert.ok(errors.dueDate);
  });
});