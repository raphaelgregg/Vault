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
