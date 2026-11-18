/**
 * Testes do serviço de Despesas (Fase 3).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  getRecurrenceOptions,
  getExpenseStatusOptions,
  createExpense,
  updateExpense,
  formatCents,
  parseMoneyToCents,
} from '../../js/services/expenses.js';
import { buildEntity, CATEGORY_KIND_ERROR } from '../../js/core/model.js';

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

// ---------------------------------------------------------------------------
// Etapa 2 — validação autoritativa da categoria no serviço
// ---------------------------------------------------------------------------

const expenseData = {
  description: 'Mercado',
  categoryId: 'cat-mercado',
  amountCents: '250,90',
  accountId: 'acc1',
  purchaseDate: '2026-11-10',
  dueDate: '2026-11-20',
  status: 'pending',
  recurrence: 'none',
};

function stubs(category) {
  const calls = { lookup: [], create: 0, update: 0, audit: 0 };
  return {
    calls,
    deps: {
      lookupCategory: async (uid, categoryId) => {
        calls.lookup.push([uid, categoryId]);
        return category === undefined ? null : category;
      },
      create: async () => {
        calls.create += 1;
        return 'novo-id';
      },
      update: async () => {
        calls.update += 1;
      },
      writeAudit: async () => {
        calls.audit += 1;
      },
    },
  };
}

describe('expenses service — categoria compatível (Etapa 2)', () => {
  it('aceita categoria expense e grava com o uid do próprio usuário', async () => {
    const { deps, calls } = stubs({ id: 'cat-mercado', kind: 'expense' });
    const result = await createExpense('uid-1', expenseData, deps);
    assert.equal(result.ok, true);
    assert.equal(result.id, 'novo-id');
    assert.deepEqual(calls.lookup, [['uid-1', 'cat-mercado']]);
    assert.equal(calls.create, 1);
  });

  it('aceita categoria both', async () => {
    const { deps } = stubs({ id: 'cat-mercado', kind: 'both' });
    const result = await createExpense('uid-1', expenseData, deps);
    assert.equal(result.ok, true);
  });

  it('recusa categoria inexistente sem gravar', async () => {
    const { deps, calls } = stubs(undefined);
    const result = await createExpense('uid-1', expenseData, deps);
    assert.equal(result.ok, false);
    assert.match(result.errors.categoryId, /não encontrada/i);
    assert.equal(calls.create, 0);
  });

  it('isolamento: a leitura da categoria usa o uid da sessão', async () => {
    const { deps, calls } = stubs(undefined);
    await createExpense('uid-2', expenseData, deps);
    assert.deepEqual(calls.lookup, [['uid-2', 'cat-mercado']]);
  });

  it('recusa categoria income mesmo sem contexto no formulário', async () => {
    const { deps, calls } = stubs({ kind: 'income' });
    const result = await createExpense('uid-1', expenseData, deps);
    assert.equal(result.ok, false);
    assert.equal(result.errors.categoryId, CATEGORY_KIND_ERROR);
    assert.equal(calls.create, 0);
  });

  it('updateExpense aplica a mesma checagem', async () => {
    const incompat = stubs({ kind: 'income' });
    const refused = await updateExpense('uid-1', 'exp-1', expenseData, incompat.deps);
    assert.equal(refused.ok, false);
    assert.equal(incompat.calls.update, 0);

    const compat = stubs({ kind: 'expense' });
    const accepted = await updateExpense('uid-1', 'exp-1', expenseData, compat.deps);
    assert.equal(accepted.ok, true);
    assert.equal(compat.calls.update, 1);
  });

  it('dados inválidos param antes de qualquer leitura de categoria', async () => {
    const { deps, calls } = stubs({ kind: 'expense' });
    const result = await createExpense('uid-1', { ...expenseData, description: '' }, deps);
    assert.equal(result.ok, false);
    assert.equal(calls.lookup.length, 0);
  });
});