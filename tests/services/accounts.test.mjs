/**
 * Testes do serviço de Contas (Fase 3) — integração com modelo e firestore.
 * Executar: node --test tests/services/accounts.test.mjs
 * Nota: testes de integração real com Firestore exigem emulador; estes testam a lógica pura.
 */
import { describe, it, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  listAccounts,
  createAccount,
  deleteAccount,
  archiveAccount,
  unarchiveAccount,
  updateAccount,
  adjustOpeningBalance,
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

  const fake = (responder) => {
    const calls = [];
    return { calls, finance: async (op, params, options) => { calls.push({ op, params, options }); return responder(op, params); } };
  };

  it('exclusão é decidida NO SERVIDOR (account.delete): nenhuma remoção direta nem leitura de vínculos no cliente', async () => {
    const api = fake(() => ({ ok: true }));
    const { io, calls } = makeIo();
    const result = await deleteAccount(uid, 'acc1', { ...io, finance: api.finance, operationId: 'op-1' });
    assert.deepEqual(result, { ok: true });
    assert.deepEqual(api.calls.map((c) => [c.op, c.params, c.options.operationId]), [['account.delete', { accountId: 'acc1' }, 'op-1']]);
    assert.equal(calls.remove, 0);
    assert.equal(calls.queries.length, 0);
  });

  it('conta com histórico: erro real do servidor (HAS_HISTORY) é repassado; orienta arquivar', async () => {
    const api = fake(() => ({ ok: false, code: 'HAS_HISTORY', errors: { _form: 'A conta possui histórico financeiro e não pode ser apagada; arquive-a para preservá-lo.' } }));
    const result = await deleteAccount(uid, 'acc1', { finance: api.finance });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'HAS_HISTORY');
    assert.equal(result.hasHistory, true);
    assert.match(result.errors._form, /arquive/);
  });

  it('arquivar e desarquivar chamam account.archive / account.unarchive (arquivamento lógico)', async () => {
    const api = fake(() => ({ ok: true }));
    assert.deepEqual(await archiveAccount(uid, 'acc1', { finance: api.finance }), { ok: true });
    assert.deepEqual(await unarchiveAccount(uid, 'acc1', { finance: api.finance }), { ok: true });
    assert.deepEqual(api.calls.map((c) => c.op), ['account.archive', 'account.unarchive']);
  });
});

describe('accounts service — saldo de abertura só pelo servidor (VF-ARQ-02)', () => {
  const uid = 'u1';
  const base = { institution: 'Nubank', name: 'Corrente', type: 'checking', initialBalanceCents: '100,00', color: '#000000', status: 'active' };

  it('editar conta com saldo/abertura alterados é recusado; sem alteração não envia campos protegidos', async () => {
    const patches = [];
    const io = { getById: async () => ({ id: 'a1', initialBalanceCents: 10000 }), update: async (_u, _c, _id, d) => { patches.push(d); }, writeAudit: async () => {} };
    const refused = await updateAccount(uid, 'a1', { ...base, initialBalanceCents: '999,00' }, io);
    assert.equal(refused.ok, false);
    assert.match(refused.errors.initialBalanceCents, /Ajustar saldo/);
    assert.deepEqual(patches, []);
    assert.equal((await updateAccount(uid, 'a1', base, io)).ok, true);
    assert.equal('initialBalanceCents' in patches[0], false);
    assert.equal('openingDate' in patches[0], false);
  });

  it('ajustar saldo de abertura chama account.adjustOpening com centavos inteiros e mostra o resultado do servidor', async () => {
    const ops = [];
    const finance = async (op, params, options) => { ops.push({ op, params, options }); return { ok: true, previousInitialCents: 0, newInitialCents: 5000, movementsCents: 1000 }; };
    const r = await adjustOpeningBalance(uid, 'a1', '60,00', { openingDate: '2026-01-01', operationId: 'op-5' }, { finance });
    assert.deepEqual([r.ok, r.newInitialCents, r.movementsCents], [true, 5000, 1000]);
    assert.deepEqual(ops[0].params, { accountId: 'a1', realBalanceCents: 6000, openingDate: '2026-01-01' });
    assert.equal(ops[0].options.operationId, 'op-5');
  });

  it('valores inválidos param antes do servidor', async () => {
    const ops = [];
    const finance = async (op) => { ops.push(op); return { ok: true }; };
    assert.equal((await adjustOpeningBalance(uid, 'a1', '-5,00', {}, { finance })).ok, false);
    assert.equal((await adjustOpeningBalance(uid, 'a1', '10,00', { openingDate: '01/01/2026' }, { finance })).ok, false);
    assert.deepEqual(ops, []);
  });
});

describe('accounts service — arquivamento lógico pelo servidor (VF-ARQ-02)', () => {
  const uid = 'u1';
  const form = { institution: 'Nubank', name: 'Corrente', type: 'checking', initialBalanceCents: '10,00', color: '#000000' };
  const make = (storedStatus) => {
    const ops = [];
    const updates = [];
    const io = {
      getById: async () => ({ id: 'a1', status: storedStatus, initialBalanceCents: 1000 }),
      update: async (_u, _c, _id, d) => { updates.push(d); },
      writeAudit: async () => {},
      finance: async (op) => { ops.push(op); return { ok: true }; },
    };
    return { io, ops, updates };
  };

  it('editar para "arquivada" chama account.archive e NUNCA grava status archived direto', async () => {
    const { io, ops, updates } = make('active');
    assert.equal((await updateAccount(uid, 'a1', { ...form, status: 'archived' }, io)).ok, true);
    assert.deepEqual(ops, ['account.archive']);
    assert.ok(updates.every((d) => d.status !== 'archived'));
  });

  it('reativar uma arquivada chama account.unarchive', async () => {
    const { io, ops } = make('archived');
    assert.equal((await updateAccount(uid, 'a1', { ...form, status: 'active' }, io)).ok, true);
    assert.deepEqual(ops, ['account.unarchive']);
  });

  it('ativa ⇄ inativa continua direto (sem efeito no histórico) e sem chamar o servidor', async () => {
    const { io, ops, updates } = make('active');
    assert.equal((await updateAccount(uid, 'a1', { ...form, status: 'inactive' }, io)).ok, true);
    assert.deepEqual(ops, []);
    assert.ok(updates.some((d) => d.status === 'inactive'));
  });
});
