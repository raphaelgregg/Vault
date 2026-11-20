/**
 * Testes do serviço de Receitas (Fase 3).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  getRecurrenceOptions,
  getIncomeStatusOptions,
  createIncome,
  updateIncome,
  deleteIncome,
  markIncomeReceived,
  formatCents,
  parseMoneyToCents,
} from '../../js/services/incomes.js';
import { buildEntity, CATEGORY_KIND_ERROR } from '../../js/core/model.js';

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

// ---------------------------------------------------------------------------
// Etapa 2 — validação autoritativa da categoria no serviço
// ---------------------------------------------------------------------------

const incomeData = {
  description: 'Salário',
  categoryId: 'cat-salario',
  amountCents: '3.000,00',
  expectedDate: '2026-12-05',
  accountId: 'acc1',
  status: 'pending',
  recurrence: 'monthly',
};

/** Stubs: impedem qualquer toque real no Firestore. */
function stubs(category) {
  const calls = { lookup: [], create: 0, update: 0, audit: 0 };
  return {
    calls,
    deps: {
      lookupCategory: async (uid, categoryId) => {
        calls.lookup.push([uid, categoryId]);
        return category === undefined ? null : category;
      },
      // VF-ARQ-02: a criação nasce no SERVIDOR (cliente de API falso); nada é gravado direto.
      finance: async (op, params, options) => {
        calls.create += 1;
        calls.ops = [...(calls.ops ?? []), { op, params, options }];
        return { ok: true, id: 'novo-id' };
      },
      getById: async () => ({ id: 'x', status: 'pending' }),
      update: async () => {
        calls.update += 1;
      },
      writeAudit: async () => {
        calls.audit += 1;
      },
    },
  };
}

describe('incomes service — categoria compatível (Etapa 2)', () => {
  it('aceita categoria income e grava com o uid do próprio usuário', async () => {
    const { deps, calls } = stubs({ id: 'cat-salario', kind: 'income' });
    const result = await createIncome('uid-1', incomeData, deps);
    assert.equal(result.ok, true);
    assert.equal(result.id, 'novo-id');
    assert.deepEqual(calls.lookup, [['uid-1', 'cat-salario']]);
    assert.equal(calls.create, 1);
  });

  it('aceita categoria both', async () => {
    const { deps } = stubs({ id: 'cat-salario', kind: 'both' });
    const result = await createIncome('uid-1', incomeData, deps);
    assert.equal(result.ok, true);
  });

  it('recusa categoria inexistente sem gravar', async () => {
    const { deps, calls } = stubs(undefined);
    const result = await createIncome('uid-1', incomeData, deps);
    assert.equal(result.ok, false);
    assert.match(result.errors.categoryId, /não encontrada/i);
    assert.equal(calls.create, 0);
  });

  it('isolamento: categoria de outro usuário não é visível (lookup recebe o uid correto)', async () => {
    const { deps, calls } = stubs(undefined);
    await createIncome('uid-2', incomeData, deps);
    assert.deepEqual(calls.lookup, [['uid-2', 'cat-salario']]);
  });

  it('recusa categoria expense mesmo sem contexto no formulário', async () => {
    const { deps, calls } = stubs({ kind: 'expense' });
    const result = await createIncome('uid-1', incomeData, deps);
    assert.equal(result.ok, false);
    assert.equal(result.errors.categoryId, CATEGORY_KIND_ERROR);
    assert.equal(calls.create, 0);
  });

  it('updateIncome aplica a mesma checagem', async () => {
    const incompat = stubs({ kind: 'expense' });
    const refused = await updateIncome('uid-1', 'inc-1', incomeData, incompat.deps);
    assert.equal(refused.ok, false);
    assert.equal(incompat.calls.update, 0);

    const compat = stubs({ kind: 'income' });
    const accepted = await updateIncome('uid-1', 'inc-1', incomeData, compat.deps);
    assert.equal(accepted.ok, true);
    assert.equal(compat.calls.update, 1);
  });

  it('dados inválidos param antes de qualquer leitura de categoria', async () => {
    const { deps, calls } = stubs({ kind: 'income' });
    const result = await createIncome('uid-1', { ...incomeData, description: '' }, deps);
    assert.equal(result.ok, false);
    assert.equal(calls.lookup.length, 0);
  });
});

describe('incomes service — camada confiável (VF-ARQ-02)', () => {
  it('criar chama income.create com centavos inteiros e operationId; nenhuma gravação direta', async () => {
    const { deps, calls } = stubs({ id: 'cat-1', kind: 'income' });
    const result = await createIncome('uid-1', { ...incomeData, operationId: 'op-9' }, deps);
    assert.equal(result.ok, true);
    assert.equal(calls.ops[0].op, 'income.create');
    assert.equal(calls.ops[0].options.operationId, 'op-9');
    assert.equal(Number.isInteger(calls.ops[0].params.amountCents), true);
    assert.equal('operationId' in calls.ops[0].params, false);
  });

  it('item recebido é imutável: editar/excluir exigem estorno', async () => {
    const { deps, calls } = stubs({ id: 'cat-1', kind: 'income' });
    deps.getById = async () => ({ id: 'x', status: 'received', amountCents: 1000, accountId: 'a' });
    const edit = await updateIncome('uid-1', 'x', incomeData, deps);
    assert.equal(edit.ok, false);
    assert.match(edit.errors._form, /estorn/i);
    const del = await deleteIncome('uid-1', 'x', deps);
    assert.equal(del.ok, false);
    assert.equal(calls.update, 0);
  });

  it('marcar como recebida chama income.receive no servidor', async () => {
    const ops = [];
    const r = await markIncomeReceived('uid-1', 'x', '2026-12-05', { finance: async (op, params) => { ops.push([op, params]); return { ok: true }; }, operationId: 'op-1' });
    assert.equal(r.ok, true);
    assert.deepEqual(ops, [['income.receive', { id: 'x', date: '2026-12-05' }]]);
  });
});
