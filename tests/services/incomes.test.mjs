/**
 * Testes do serviço de Receitas (Fase 3).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  getRecurrenceOptions,
  getIncomeStatusOptions,
  formatCents,
  parseMoneyToCents,
} from '../../js/services/incomes.js';
import { buildEntity } from '../../js/core/model.js';

describe('incomes service — validação e helpers', () => {
  it('getRecurrenceOptions retorna recorrências esperadas', () => {
    const options = getRecurrenceOptions();
    assert.equal(options.length, 4);
    assert.deepEqual(options.map((o) => o.value), ['none', 'monthly', 'weekly', 'yearly']);
  });

  it('getIncomeStatusOptions retorna status esperados', () => {
    const options = getIncomeStatusOptions();
    assert.equal(options.length, 3);
    assert.deepEqual(options.map((o) => o.value), ['pending', 'received', 'cancelled']);
  });

  it('formatCents formata corretamente', () => {
    assert.equal(formatCents(300000), 'R$ 3.000,00');
    assert.equal(formatCents(100), 'R$ 1,00');
  });

  it('parseMoneyToCents aceita formatos pt-BR', () => {
    assert.equal(parseMoneyToCents('3.000,00'), 300000);
    assert.equal(parseMoneyToCents('100,50'), 10050);
  });

  it('buildEntity aceita receita válida', () => {
    const valid = {
      description: 'Salário',
      categoryId: 'cat1',
      amountCents: '3.000,00',
      expectedDate: '2026-12-05',
      accountId: 'acc1',
      status: 'pending',
      recurrence: 'monthly',
    };
    const { ok, data } = buildEntity('incomes', valid);
    assert.ok(ok);
    assert.equal(data.amountCents, 300000);
  });

  it('buildEntity exige amountCents > 0', () => {
    const invalid = {
      description: 'Salário',
      categoryId: 'cat1',
      amountCents: '0,00',
      expectedDate: '2026-12-05',
      accountId: 'acc1',
      status: 'pending',
      recurrence: 'monthly',
    };
    const { ok, errors } = buildEntity('incomes', invalid);
    assert.ok(!ok);
    assert.match(errors.amountCents, /maior que zero/);
  });

  it('buildEntity aceita receivedDate opcional', () => {
    const valid = {
      description: 'Salário',
      categoryId: 'cat1',
      amountCents: '3.000,00',
      expectedDate: '2026-12-05',
      receivedDate: '2026-12-05',
      accountId: 'acc1',
      status: 'received',
      recurrence: 'monthly',
    };
    const { ok, data } = buildEntity('incomes', valid);
    assert.ok(ok);
    assert.equal(data.receivedDate, '2026-12-05');
  });

  it('buildEntity omite receivedDate quando não informado', () => {
    const valid = {
      description: 'Salário',
      categoryId: 'cat1',
      amountCents: '3.000,00',
      expectedDate: '2026-12-05',
      accountId: 'acc1',
      status: 'pending',
      recurrence: 'monthly',
    };
    const { ok, data } = buildEntity('incomes', valid);
    assert.ok(ok);
    assert.ok(!('receivedDate' in data));
  });

  it('buildEntity rejeita expectedDate inválida', () => {
    const invalid = {
      description: 'Salário',
      categoryId: 'cat1',
      amountCents: '3.000,00',
      expectedDate: '31/02/2026',
      accountId: 'acc1',
      status: 'pending',
      recurrence: 'monthly',
    };
    const { ok, errors } = buildEntity('incomes', invalid);
    assert.ok(!ok);
    assert.ok(errors.expectedDate);
  });
});