/**
 * Testes do modelo financeiro (Fase 3.1) — puros, sem emulador.
 * Executar: node --test tests/model
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseMoneyToCents,
  formatCents,
  isValidIsoDate,
  validateEntity,
  buildEntity,
  accountBalances,
  sumAmounts,
  filterMovements,
  isKindCompatible,
  checkCategoryForMovement,
  CATEGORY_KIND_ERROR,
} from '../../js/core/model.js';

describe('parseMoneyToCents (dinheiro em centavos)', () => {
  it('aceita formatos pt-BR comuns', () => {
    assert.equal(parseMoneyToCents(1234), 123400);
    assert.equal(parseMoneyToCents('1234'), 123400);
    assert.equal(parseMoneyToCents('1234,56'), 123456);
    assert.equal(parseMoneyToCents('1.234,56'), 123456);
    assert.equal(parseMoneyToCents('R$ 1.234,56'), 123456);
    assert.equal(parseMoneyToCents('1234.56'), 123456);
    assert.equal(parseMoneyToCents('0,10'), 10);
    assert.equal(parseMoneyToCents('0,005'), 1); // arredonda para o centavo
  });

  it('rejeita valores inválidos', () => {
    assert.equal(parseMoneyToCents(''), null);
    assert.equal(parseMoneyToCents('abc'), null);
    assert.equal(parseMoneyToCents('-5'), null);
    assert.equal(parseMoneyToCents('1,2,3'), null);
    assert.equal(parseMoneyToCents(null), null);
  });

  it('nunca perde centavos por ponto flutuante', () => {
    assert.equal(parseMoneyToCents('0.07'), 7);
    assert.equal(parseMoneyToCents('19.99'), 1999);
  });
});

describe('formatCents', () => {
  it('formata pt-BR com prefixo R$', () => {
    assert.equal(formatCents(123456), 'R$ 1.234,56');
    assert.equal(formatCents(5), 'R$ 0,05');
    assert.equal(formatCents(-500), '-R$ 5,00');
    assert.equal(formatCents('x'), '—');
  });
});

describe('isValidIsoDate', () => {
  it('aceita datas reais', () => {
    assert.ok(isValidIsoDate('2026-11-16'));
    assert.ok(isValidIsoDate('2024-02-29')); // bissexto
  });
  it('rejeita datas impossíveis', () => {
    assert.ok(!isValidIsoDate('2026-13-01'));
    assert.ok(!isValidIsoDate('2026-02-30'));
    assert.ok(!isValidIsoDate('16/11/2026'));
    assert.ok(!isValidIsoDate('abc'));
  });
});

describe('validateEntity — accounts', () => {
  const valid = {
    institution: 'Banco Exemplo',
    name: 'Conta principal',
    type: 'checking',
    initialBalanceCents: '1.500,00',
    color: '#1f7a5c',
    status: 'active',
  };

  it('aceita payload válido', () => {
    const { ok, errors } = validateEntity('accounts', valid);
    assert.ok(ok, JSON.stringify(errors));
  });

  it('rejeita campo fora do schema (Rules negariam)', () => {
    const { ok, errors } = validateEntity('accounts', { ...valid, admin: true });
    assert.ok(!ok);
    assert.ok(errors.admin);
  });

  it('rejeita enum inválido e texto vazio', () => {
    const { ok, errors } = validateEntity('accounts', { ...valid, type: 'grana-facil' });
    assert.ok(!ok);
    assert.ok(errors.type);
    const empty = validateEntity('accounts', { ...valid, institution: '   ' });
    assert.ok(!empty.ok);
    assert.ok(empty.errors.institution);
  });

  it('rejeita saldo inicial negativo ou não numérico', () => {
    assert.ok(!validateEntity('accounts', { ...valid, initialBalanceCents: '-10' }).ok);
    assert.ok(!validateEntity('accounts', { ...valid, initialBalanceCents: 'xicara' }).ok);
  });
});

describe('validateEntity — incomes', () => {
  const valid = {
    description: 'Salário',
    categoryId: 'cat1',
    amountCents: '3.000,00',
    expectedDate: '2026-12-05',
    accountId: 'acc1',
    status: 'pending',
    recurrence: 'monthly',
  };

  it('aceita payload válido e recebido opcional', () => {
    assert.ok(validateEntity('incomes', valid).ok);
    assert.ok(validateEntity('incomes', { ...valid, receivedDate: '2026-12-05' }).ok);
  });

  it('exige valor maior que zero', () => {
    const { ok, errors } = validateEntity('incomes', { ...valid, amountCents: '0,00' });
    assert.ok(!ok);
    assert.match(errors.amountCents, /maior que zero/);
  });

  it('exige datas obrigatórias válidas', () => {
    const { ok, errors } = validateEntity('incomes', { ...valid, expectedDate: '31/02/2026' });
    assert.ok(!ok);
    assert.ok(errors.expectedDate);
  });
});

describe('validateEntity — expenses', () => {
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

  it('aceita payload válido e opcionais', () => {
    assert.ok(validateEntity('expenses', valid).ok);
    assert.ok(validateEntity('expenses', {
      ...valid, paidDate: '2026-11-18', notes: 'pago no débito', installmentGroupId: 'g1',
    }).ok);
  });

  it('rejeita notas acima de 500 caracteres', () => {
    const { ok, errors } = validateEntity('expenses', { ...valid, notes: 'x'.repeat(501) });
    assert.ok(!ok);
    assert.ok(errors.notes);
  });
});

describe('validateEntity — transfers', () => {
  const valid = {
    fromAccountId: 'acc1',
    toAccountId: 'acc2',
    amountCents: '100,00',
    date: '2026-11-16',
    reason: 'Reserva',
    status: 'confirmed',
  };

  it('aceita payload válido', () => {
    assert.ok(validateEntity('transfers', valid).ok);
  });

  it('rejeita transferência para a mesma conta', () => {
    const { ok, errors } = validateEntity('transfers', { ...valid, toAccountId: 'acc1' });
    assert.ok(!ok);
    assert.ok(errors.toAccountId);
  });
});

describe('buildEntity (normalização)', () => {
  it('normaliza dinheiro para centavos inteiros e aparar textos', () => {
    const { ok, data } = buildEntity('accounts', {
      institution: '  Banco Exemplo  ',
      name: 'Conta',
      type: 'checking',
      initialBalanceCents: '1.500,00',
      color: '#1f7a5c',
      status: 'active',
    });
    assert.ok(ok);
    assert.equal(data.institution, 'Banco Exemplo');
    assert.equal(data.initialBalanceCents, 150000);
  });

  it('omite opcionais não informados (Rules: optional*)', () => {
    const { data } = buildEntity('incomes', {
      description: 'Salário', categoryId: 'cat1', amountCents: '100,00',
      expectedDate: '2026-12-05', accountId: 'acc1', status: 'pending', recurrence: 'none',
    });
    assert.ok(!('receivedDate' in data));
    assert.ok(!('notes' in data));
  });

  it('retorna erros quando inválido', () => {
    const { ok, errors } = buildEntity('accounts', { name: '' });
    assert.ok(!ok);
    assert.ok(Object.keys(errors).length > 0);
  });
});

describe('accountBalances (saldo sempre derivado)', () => {
  const accounts = [
    { id: 'a1', initialBalanceCents: 100000 },
    { id: 'a2', initialBalanceCents: 5000 },
  ];

  it('aplica receitas recebidas, despesas pagas e transferências confirmadas', () => {
    const balances = accountBalances(accounts, {
      incomes: [
        { accountId: 'a1', amountCents: 30000, status: 'received' },
        { accountId: 'a1', amountCents: 10000, status: 'pending' }, // não conta
      ],
      expenses: [
        { accountId: 'a1', amountCents: 20000, status: 'paid' },
        { accountId: 'a1', amountCents: 5000, status: 'pending' }, // não conta
      ],
      transfers: [
        { fromAccountId: 'a1', toAccountId: 'a2', amountCents: 15000, status: 'confirmed' },
        { fromAccountId: 'a1', toAccountId: 'a2', amountCents: 99999, status: 'pending' }, // não conta
      ],
    });
    assert.equal(balances.get('a1'), 100000 + 30000 - 20000 - 15000);
    assert.equal(balances.get('a2'), 5000 + 15000);
  });
});

describe('sumAmounts', () => {
  it('soma por status', () => {
    const items = [
      { amountCents: 100, status: 'received' },
      { amountCents: 200, status: 'received' },
      { amountCents: 400, status: 'pending' },
    ];
    assert.equal(sumAmounts(items, 'received'), 300);
    assert.equal(sumAmounts(items), 700);
  });
});

// ---------------------------------------------------------------------------
// Etapa 2 — compatibilidade de categoria por tipo de movimentação
// ---------------------------------------------------------------------------

const validIncome = {
  description: 'Salário',
  categoryId: 'cat-salario',
  amountCents: '3.000,00',
  expectedDate: '2026-12-05',
  accountId: 'acc1',
  status: 'pending',
  recurrence: 'monthly',
};

const validExpense = {
  description: 'Mercado',
  categoryId: 'cat-mercado',
  amountCents: '250,90',
  accountId: 'acc1',
  purchaseDate: '2026-11-10',
  dueDate: '2026-11-20',
  status: 'pending',
  recurrence: 'none',
};

describe('kindCompat — receitas', () => {
  it('aceita categoria income', () => {
    const { ok } = validateEntity('incomes', validIncome, {
      categoryKinds: new Map([['cat-salario', 'income']]),
    });
    assert.equal(ok, true);
  });

  it('aceita categoria both', () => {
    const { ok } = validateEntity('incomes', validIncome, {
      categoryKinds: (id) => (id === 'cat-salario' ? 'both' : null),
    });
    assert.equal(ok, true);
  });

  it('recusa categoria expense', () => {
    const { ok, errors } = validateEntity('incomes', validIncome, {
      categoryKinds: new Map([['cat-salario', 'expense']]),
    });
    assert.equal(ok, false);
    assert.equal(errors.categoryId, CATEGORY_KIND_ERROR);
  });

  it('sem contexto NÃO executa a checagem de kind (retrocompatível)', () => {
    const { ok } = validateEntity('incomes', validIncome);
    assert.equal(ok, true);
  });

  it('lookup que não conhece o id não inventa incompatibilidade', () => {
    const { ok } = validateEntity('incomes', validIncome, {
      categoryKinds: new Map([['outra-categoria', 'expense']]),
    });
    assert.equal(ok, true);
  });

  it('buildEntity repassa o contexto e bloqueia categoria incompatível', () => {
    const { ok, errors } = buildEntity('incomes', validIncome, {
      categoryKinds: { 'cat-salario': 'expense' },
    });
    assert.equal(ok, false);
    assert.equal(errors.categoryId, CATEGORY_KIND_ERROR);
  });
});

describe('kindCompat — despesas', () => {
  it('aceita categoria expense', () => {
    const { ok } = validateEntity('expenses', validExpense, {
      categoryKinds: new Map([['cat-mercado', 'expense']]),
    });
    assert.equal(ok, true);
  });

  it('aceita categoria both', () => {
    const { ok } = validateEntity('expenses', validExpense, {
      categoryKinds: new Map([['cat-mercado', 'both']]),
    });
    assert.equal(ok, true);
  });

  it('recusa categoria income', () => {
    const { ok, errors } = validateEntity('expenses', validExpense, {
      categoryKinds: new Map([['cat-mercado', 'income']]),
    });
    assert.equal(ok, false);
    assert.equal(errors.categoryId, CATEGORY_KIND_ERROR);
  });

  it('sem contexto continua aceitando (retrocompatível)', () => {
    const { ok } = validateEntity('expenses', validExpense);
    assert.equal(ok, true);
  });
});

describe('isKindCompatible / checkCategoryForMovement', () => {
  it('isKindCompatible compara com a lista de tipos aceitos', () => {
    assert.equal(isKindCompatible('both', ['income', 'both']), true);
    assert.equal(isKindCompatible('expense', ['income', 'both']), false);
    assert.equal(isKindCompatible(undefined, ['income']), false);
    assert.equal(isKindCompatible('income', null), false);
  });

  it('checkCategoryForMovement recusa categoria inexistente', () => {
    const result = checkCategoryForMovement(null, ['income', 'both']);
    assert.equal(result.ok, false);
    assert.match(result.errors.categoryId, /não encontrada/i);
  });

  it('checkCategoryForMovement recusa tipo incompatível com a mensagem única', () => {
    const result = checkCategoryForMovement({ kind: 'expense' }, ['income', 'both']);
    assert.equal(result.ok, false);
    assert.equal(result.errors.categoryId, CATEGORY_KIND_ERROR);
  });

  it('checkCategoryForMovement aceita tipo compatível', () => {
    const result = checkCategoryForMovement({ kind: 'both' }, ['expense', 'both']);
    assert.equal(result.ok, true);
  });
});

// ---------------------------------------------------------------------------
// Etapa 2 — filtros de listagem (status + mês + categoria)
// ---------------------------------------------------------------------------

describe('filterMovements', () => {
  const items = [
    { id: '1', status: 'pending', expectedDate: '2026-11-05', categoryId: 'cat-a' },
    { id: '2', status: 'received', expectedDate: '2026-11-20', categoryId: 'cat-b' },
    { id: '3', status: 'pending', expectedDate: '2026-12-01', categoryId: 'cat-a' },
    { id: '4', status: 'received', expectedDate: '2026-12-10', categoryId: 'cat-b' },
  ];
  const options = { dateField: 'expectedDate' };

  it('sem filtros retorna tudo', () => {
    assert.equal(filterMovements(items, {}, options).length, 4);
    assert.equal(filterMovements(items, { status: 'all', month: null, categoryId: null }, options).length, 4);
  });

  it('filtra por status', () => {
    const ids = filterMovements(items, { status: 'received' }, options).map((i) => i.id);
    assert.deepEqual(ids, ['2', '4']);
  });

  it('filtra por mês', () => {
    const ids = filterMovements(items, { month: '2026-12' }, options).map((i) => i.id);
    assert.deepEqual(ids, ['3', '4']);
  });

  it('filtra por categoria', () => {
    const ids = filterMovements(items, { categoryId: 'cat-a' }, options).map((i) => i.id);
    assert.deepEqual(ids, ['1', '3']);
  });

  it('combina status + mês + categoria', () => {
    const ids = filterMovements(
      items,
      { status: 'pending', month: '2026-11', categoryId: 'cat-a' },
      options
    ).map((i) => i.id);
    assert.deepEqual(ids, ['1']);

    const none = filterMovements(
      items,
      { status: 'received', month: '2026-11', categoryId: 'cat-a' },
      options
    );
    assert.equal(none.length, 0);
  });

  it('categoria "Todas" (categoryId null) não restringe', () => {
    const ids = filterMovements(items, { categoryId: null }, options).map((i) => i.id);
    assert.deepEqual(ids, ['1', '2', '3', '4']);
  });

  it('usa o dateField informado (dueDate em despesas)', () => {
    const expenses = [
      { id: 'e1', status: 'pending', dueDate: '2026-11-10', expectedDate: '2027-01-01' },
    ];
    assert.equal(filterMovements(expenses, { month: '2026-11' }, { dateField: 'dueDate' }).length, 1);
    assert.equal(filterMovements(expenses, { month: '2027-01' }, { dateField: 'dueDate' }).length, 0);
  });

  it('tolera lista vazia ou ausente', () => {
    assert.deepEqual(filterMovements([], {}), []);
    assert.deepEqual(filterMovements(undefined, { status: 'all' }), []);
  });
});
