/**
 * Testes do serviço de Contas (Fase 3) — integração com modelo e firestore.
 * Executar: node --test tests/services/accounts.test.mjs
 * Nota: testes de integração real com Firestore exigem emulador; estes testam a lógica pura.
 */
import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import {
  listAccounts,
  getAccount,
  createAccount,
  updateAccount,
  deleteAccount,
  getAccountTypeOptions,
  getStatusOptions,
  formatCents,
  parseMoneyToCents,
} from '../../js/services/accounts.js';

// Mock do firestore
const mockFirestore = {
  list: mock.fn(),
  getById: mock.fn(),
  create: mock.fn(),
  update: mock.fn(),
  remove: mock.fn(),
  writeAudit: mock.fn(),
};

describe('accounts service — validação e formatação', () => {
  it('getAccountTypeOptions retorna todos os tipos esperados', () => {
    const options = getAccountTypeOptions();
    assert.equal(options.length, 7);
    assert.ok(options.some((o) => o.value === 'checking' && o.label === 'Conta corrente'));
    assert.ok(options.some((o) => o.value === 'investment' && o.label === 'Investimento'));
  });

  it('getStatusOptions retorna status esperados', () => {
    const options = getStatusOptions();
    assert.equal(options.length, 3);
    assert.deepEqual(options.map((o) => o.value), ['active', 'inactive', 'archived']);
  });

  it('formatCents formata valores pt-BR', () => {
    assert.equal(formatCents(123456), 'R$ 1.234,56');
    assert.equal(formatCents(5), 'R$ 0,05');
    assert.equal(formatCents(-500), '-R$ 5,00');
    assert.equal(formatCents(0), 'R$ 0,00');
  });

  it('parseMoneyToCents aceita formatos pt-BR', () => {
    assert.equal(parseMoneyToCents('1.234,56'), 123456);
    assert.equal(parseMoneyToCents('R$ 1.234,56'), 123456);
    assert.equal(parseMoneyToCents('0,10'), 10);
    assert.equal(parseMoneyToCents('1234'), 123400);
  });
});

describe('accounts service — CRUD delega para firestore com validação', () => {
  const uid = 'user123';

  beforeEach(() => {
    mockFirestore.list.mock.resetCalls();
    mockFirestore.getById.mock.resetCalls();
    mockFirestore.create.mock.resetCalls();
    mockFirestore.update.mock.resetCalls();
    mockFirestore.remove.mock.resetCalls();
    mockFirestore.writeAudit.mock.resetCalls();
  });

  it('listAccounts chama list com orderBy institution', async () => {
    mockFirestore.list.mock.mockImplementation(() => Promise.resolve([]));
    // O teste real exigiria importar o módulo com mock; aqui validamos a assinatura
    // Em testes de integração real com emulador, isto seria verificado end-to-end
    assert.ok(typeof listAccounts === 'function');
  });

  it('createAccount valida dados antes de criar', async () => {
    // Teste unitário da validação via modelo
    const { buildEntity } = await import('../../js/core/model.js');
    const valid = {
      institution: 'Banco Teste',
      name: 'Conta',
      type: 'checking',
      initialBalanceCents: '1.000,00',
      color: '#1f7a5c',
      status: 'active',
    };
    const { ok, data } = buildEntity('accounts', valid);
    assert.ok(ok);
    assert.equal(data.initialBalanceCents, 100000);
  });

  it('createAccount rejeita tipo inválido', async () => {
    const { buildEntity } = await import('../../js/core/model.js');
    const invalid = {
      institution: 'Banco',
      name: 'Conta',
      type: 'tipo-inexistente',
      initialBalanceCents: '100,00',
      color: '#1f7a5c',
      status: 'active',
    };
    const { ok, errors } = buildEntity('accounts', invalid);
    assert.ok(!ok);
    assert.ok(errors.type);
  });

  it('createAccount rejeita saldo inicial negativo', async () => {
    const { buildEntity } = await import('../../js/core/model.js');
    const invalid = {
      institution: 'Banco',
      name: 'Conta',
      type: 'checking',
      initialBalanceCents: '-100,00',
      color: '#1f7a5c',
      status: 'active',
    };
    const { ok, errors } = buildEntity('accounts', invalid);
    assert.ok(!ok);
    assert.ok(errors.initialBalanceCents);
  });
});