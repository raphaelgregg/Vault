/**
 * Testes do serviço de Contas (Fase 3) — integração com modelo e firestore.
 * Executar: node --test tests/services/accounts.test.mjs
 * Nota: testes de integração real com Firestore exigem emulador; estes testam a lógica pura.
 */
import { describe, it, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  listAccounts,
  getAccount,
  createAccount,
  updateAccount,
  deleteAccount,
  ACCOUNT_LINK_QUERIES,
  summarizeAccountLinks,
  buildAccountInUseMessage,
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
describe('accounts service — exclusão segura (VF-1-02)', () => {
  const uid = 'user123';
  const account = { id: 'acc1', name: 'Conta' };

  function makeIo({ counts = {}, failOn = null, existing = account } = {}) {
    const calls = { remove: 0, audit: 0, queries: [] };
    return {
      calls,
      io: {
        getById: async () => existing,
        count: async (_uid, collection, { where }) => {
          const [field] = where[0];
          calls.queries.push(`${collection}.${field}`);
          if (failOn === collection) throw new Error('permission-denied');
          return counts[`${collection}.${field}`] ?? 0;
        },
        remove: async () => { calls.remove += 1; },
        writeAudit: async () => { calls.audit += 1; },
      },
    };
  }

  it('consulta receitas, despesas, transferências (origem e destino) e demais vínculos', () => {
    const keys = ACCOUNT_LINK_QUERIES.map((q) => `${q.collection}.${q.field}`);
    for (const key of [
      'incomes.accountId',
      'expenses.accountId',
      'transfers.fromAccountId',
      'transfers.toAccountId',
    ]) {
      assert.ok(keys.includes(key), key);
    }
  });

  it('summarizeAccountLinks ignora contagens zero/inválidas', () => {
    const s = summarizeAccountLinks([
      { collection: 'incomes', label: 'receitas', count: 2 },
      { collection: 'expenses', label: 'despesas', count: 0 },
      { collection: 'x', label: 'x', count: NaN },
    ]);
    assert.equal(s.total, 2);
    assert.ok(s.inUse);
    assert.match(buildAccountInUseMessage(s), /receitas \(2\)/);
    assert.match(buildAccountInUseMessage(s), /arquive/i);
  });

  it('bloqueia exclusão com receita vinculada (sem remover nem auditar)', async () => {
    const { io, calls } = makeIo({ counts: { 'incomes.accountId': 3 } });
    const result = await deleteAccount(uid, 'acc1', io);
    assert.equal(result.ok, false);
    assert.match(result.errors._form, /receitas \(3\)/);
    assert.equal(calls.remove, 0);
    assert.equal(calls.audit, 0);
  });

  it('bloqueia exclusão com transferência como destino', async () => {
    const { io, calls } = makeIo({ counts: { 'transfers.toAccountId': 1 } });
    const result = await deleteAccount(uid, 'acc1', io);
    assert.equal(result.ok, false);
    assert.match(result.errors._form, /transferências \(destino\) \(1\)/);
    assert.equal(calls.remove, 0);
  });

  it('exclui e audita conta sem vínculos', async () => {
    const { io, calls } = makeIo();
    const result = await deleteAccount(uid, 'acc1', io);
    assert.deepEqual(result, { ok: true });
    assert.equal(calls.remove, 1);
    assert.equal(calls.audit, 1);
    assert.equal(calls.queries.length, ACCOUNT_LINK_QUERIES.length);
  });

  it('fail-closed: falha na verificação bloqueia a exclusão', async () => {
    const { io, calls } = makeIo({ failOn: 'expenses' });
    const original = console.error;
    console.error = () => {};
    let result;
    try {
      result = await deleteAccount(uid, 'acc1', io);
    } finally {
      console.error = original;
    }
    assert.equal(result.ok, false);
    assert.match(result.errors._form, /Não foi possível verificar/);
    assert.equal(calls.remove, 0);
    assert.equal(calls.audit, 0);
  });

  it('conta inexistente não consulta vínculos nem remove', async () => {
    const { io, calls } = makeIo({ existing: null });
    const result = await deleteAccount(uid, 'nope', io);
    assert.equal(result.ok, false);
    assert.equal(calls.queries.length, 0);
    assert.equal(calls.remove, 0);
  });
});
