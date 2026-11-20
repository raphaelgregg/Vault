/**
 * Testes de Metas e movimentações (VF-2-03c): modelo, saldo derivado, fluxo atômico, transições.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { transferableGoals, listRecentGoalTransactions, listGoalTransactions } from '../../js/services/goals.js';
import {
  createGoal, updateGoal, deleteGoal, setGoalStatus, cancelGoal, reopenGoal,
  registerGoalTransaction, depositToGoal, withdrawFromGoal, getGoalStatusOptions,
} from '../../js/services/goals.js';
import {
  SCHEMAS, validateEntity, goalSavedCents, goalProgressPercent, applyGoalTransaction, accountBalances,
} from '../../js/core/model.js';

const uid = 'u1';
const goal = (o = {}) => ({ id: 'g1', status: 'active', targetCents: 100000, ...o });
const account = (o = {}) => ({ id: 'acc1', institution: 'Nubank', name: 'Corrente', status: 'active', initialBalanceCents: 1000000, ...o });
const raw = (o = {}) => ({ amountCents: '300,00', date: '2026-11-18', accountId: 'acc1', ...o });

function makeIo({ goals = [goal()], accounts = [account()], txs = [], linked = 0 } = {}) {
  const calls = { atomic: [], create: [], update: [], remove: [], audit: [] };
  const io = {
    getById: async (u, c, id) => ({ goals, accounts }[c] ?? []).find((x) => x.id === id) ?? null,
    list: async () => txs,
    count: async () => linked,
    commitAtomic: async (u, ops) => { calls.atomic.push(ops); return ['tx1']; },
    create: async (u, c, data) => { calls.create.push({ c, data }); return 'new1'; },
    update: async (u, c, id, data) => { calls.update.push({ c, id, data }); },
    remove: async (u, c, id) => { calls.remove.push({ c, id }); },
    writeAudit: async (u, e) => { calls.audit.push(e); return { ok: true }; },
  };
  return { io, calls };
}

describe('goals — schema e puros', () => {
  it('chaves espelham as Rules', () => {
    assert.deepEqual(Object.keys(SCHEMAS.goals.fields).sort(), ['accountId', 'deadline', 'description', 'name', 'status', 'targetCents']);
    assert.deepEqual(Object.keys(SCHEMAS.goalTransactions.fields).sort(), ['accountId', 'amountCents', 'date', 'goalId', 'notes', 'type']);
    assert.deepEqual(SCHEMAS.goals.dateFields, ['deadline']);
    assert.deepEqual(getGoalStatusOptions().map((o) => o.value), ['active', 'completed', 'cancelled']);
  });
  it('rejeita alvo <= 0, tipo inválido, notes > 300', () => {
    const g = { name: 'Viagem', targetCents: 0, status: 'active' };
    assert.ok(validateEntity('goals', g).errors.targetCents);
    const t = { goalId: 'g', type: 'x', amountCents: 1, date: '2026-11-18', accountId: 'a' };
    assert.ok(validateEntity('goalTransactions', t).errors.type);
    assert.ok(validateEntity('goalTransactions', { ...t, type: 'deposit', notes: 'x'.repeat(301) }).errors.notes);
  });
  it('goalSavedCents, progresso e accountBalances', () => {
    const txs = [{ type: 'deposit', amountCents: 500 }, { type: 'withdraw', amountCents: 200 }];
    assert.equal(goalSavedCents(txs), 300);
    assert.equal(goalProgressPercent(300, 1000), 30);
    assert.equal(goalProgressPercent(5000, 1000), 100);
    assert.equal(goalProgressPercent(5, 0), 0);
    const b = accountBalances([{ id: 'a', initialBalanceCents: 1000 }], {
      goalTransactions: [{ accountId: 'a', type: 'deposit', amountCents: 400 }, { accountId: 'a', type: 'withdraw', amountCents: 100 }],
    });
    assert.equal(b.get('a'), 700);
  });
  it('applyGoalTransaction: conclui, reativa e rejeita', () => {
    assert.deepEqual(applyGoalTransaction(goal(), 0, 'deposit', 30000), { ok: true, savedCents: 30000, status: 'active' });
    assert.equal(applyGoalTransaction(goal(), 70000, 'deposit', 30000).status, 'completed');
    assert.equal(applyGoalTransaction(goal({ status: 'completed' }), 100000, 'withdraw', 1).status, 'active');
    assert.equal(applyGoalTransaction(goal({ status: 'completed' }), 150000, 'withdraw', 1).status, 'completed');
    assert.equal(applyGoalTransaction(goal({ status: 'completed' }), 100000, 'deposit', 1).ok, false);
    assert.equal(applyGoalTransaction(goal({ status: 'cancelled' }), 100, 'withdraw', 1).ok, false);
    assert.equal(applyGoalTransaction(goal(), 100, 'withdraw', 101).ok, false);
    assert.equal(applyGoalTransaction(goal(), 100, 'deposit', 0).ok, false);
    assert.equal(applyGoalTransaction(goal(), 100, 'x', 1).ok, false);
  });
});

describe('createGoal / updateGoal', () => {
  it('cria ativa, ignora status enviado, normaliza prazo e audita', async () => {
    const { io, calls } = makeIo();
    const r = await createGoal(uid, { name: ' Viagem ', targetCents: '1.000,00', deadline: '2027-01-10', accountId: 'acc1', status: 'completed' }, io);
    assert.equal(r.ok, true);
    assert.deepEqual(calls.create[0].data, { name: 'Viagem', targetCents: 100000, deadline: '2027-01-10', accountId: 'acc1', status: 'active' });
    assert.equal(calls.audit[0].action, 'create');
  });
  it('rejeita conta inexistente e dados inválidos', async () => {
    const { io, calls } = makeIo({ accounts: [] });
    assert.ok((await createGoal(uid, { name: 'A', targetCents: '10', accountId: 'zz' }, io)).errors.accountId);
    assert.ok((await createGoal(uid, { name: '', targetCents: '10' }, io)).errors.name);
    assert.equal(calls.create.length, 0);
  });
  it('edita meta ativa preservando status; rejeita alvo <= guardado e meta não ativa', async () => {
    const { io, calls } = makeIo({ txs: [{ type: 'deposit', amountCents: 50000 }] });
    assert.equal((await updateGoal(uid, 'g1', { name: 'N', targetCents: '600,00' }, io)).ok, true);
    assert.equal(calls.update[0].data.status, 'active');
    assert.ok((await updateGoal(uid, 'g1', { name: 'N', targetCents: '500,00' }, io)).errors.targetCents);
    assert.equal((await updateGoal(uid, 'g1', { name: 'N', targetCents: '900' }, makeIo({ goals: [goal({ status: 'completed' })] }).io)).ok, false);
    assert.equal(calls.update.length, 1);
  });
});

describe('registerGoalTransaction — camada confiável (VF-ARQ-02)', () => {
  const api = (response = { ok: true, transactionId: 'tx1', goalStatus: 'active', savedCents: 30000 }) => {
    const calls = [];
    return { calls, finance: async (op, params, options) => { calls.push({ op, params, options }); return response; } };
  };

  it('aporte chama goal.deposit com centavos inteiros e operationId; nenhuma gravação direta', async () => {
    const { io, calls } = makeIo();
    const a = api();
    const r = await depositToGoal(uid, 'g1', { ...raw(), operationId: 'op-1' }, { ...io, finance: a.finance });
    assert.deepEqual([r.ok, r.id, r.status, r.savedCents], [true, 'tx1', 'active', 30000]);
    assert.deepEqual(a.calls.map((c) => [c.op, c.params, c.options.operationId]), [['goal.deposit', { goalId: 'g1', amountCents: 30000, date: '2026-11-18', accountId: 'acc1' }, 'op-1']]);
    assert.equal(calls.create.length + calls.update.length + calls.atomic.length, 0);
  });

  it('resgate chama goal.withdraw; a meta concluída/reaberta vem do servidor', async () => {
    const a = api({ ok: true, transactionId: 'tx2', goalStatus: 'active', savedCents: 70000 });
    const r = await withdrawFromGoal(uid, 'g1', raw(), { ...makeIo().io, finance: a.finance });
    assert.deepEqual([r.ok, r.status, r.savedCents], [true, 'active', 70000]);
    assert.equal(a.calls[0].op, 'goal.withdraw');
  });

  it('erros do servidor (saldo insuficiente, resgate acima do guardado, meta vinculada/cancelada) chegam à tela sem escrita', async () => {
    const m = makeIo();
    for (const [code, msg] of [['INSUFFICIENT_BALANCE', 'Saldo insuficiente em Nubank.'], ['INVALID_STATE', 'Resgate acima do guardado.'], ['NOT_FOUND', 'Meta não encontrada.']]) {
      const a = api({ ok: false, code, errors: { _form: msg } });
      const r = await depositToGoal(uid, 'g1', raw(), { ...m.io, finance: a.finance });
      assert.deepEqual([r.ok, r.code, r.errors._form], [false, code, msg]);
    }
    assert.equal(m.calls.atomic.length + m.calls.create.length, 0);
  });

  it('dados inválidos (valor zero, data inválida) param no formulário, antes do servidor', async () => {
    const a = api();
    const io = { ...makeIo().io, finance: a.finance };
    assert.ok((await depositToGoal(uid, 'g1', raw({ amountCents: '0' }), io)).errors.amountCents);
    assert.ok((await depositToGoal(uid, 'g1', raw({ date: 'hoje' }), io)).errors.date);
    assert.deepEqual(a.calls, []);
  });

  it('movimentos ESTORNADOS não contam no guardado (listGoalTransactions marca; goalSavedCents ignora)', async () => {
    const lists = { goalTransactions: [{ id: 't1', type: 'deposit', amountCents: 5000 }, { id: 't2', type: 'deposit', amountCents: 3000 }], reversals: [{ id: 'goalTransactions_t2', targetCollection: 'goalTransactions', targetId: 't2' }] };
    const rows = await listGoalTransactions(uid, 'g1', { list: async (_u, c) => lists[c] });
    assert.deepEqual(rows.map((r) => [r.id, Boolean(r.reversed)]), [['t1', false], ['t2', true]]);
    assert.equal(goalSavedCents(rows), 5000);
  });
});

describe('status e exclusão', () => {
  it('cancela e reabre com auditoria; completed é terminal para set manual', async () => {
    const a = makeIo();
    assert.equal((await cancelGoal(uid, 'g1', a.io)).ok, true);
    assert.equal(a.calls.audit[0].action, 'cancel');
    const b = makeIo({ goals: [goal({ status: 'cancelled' })] });
    assert.equal((await reopenGoal(uid, 'g1', b.io)).ok, true);
    assert.equal(b.calls.audit[0].action, 'reopen');
    assert.equal((await setGoalStatus(uid, 'g1', 'completed', a.io)).ok, false);
    assert.equal((await cancelGoal(uid, 'g1', makeIo({ goals: [goal({ status: 'completed' })] }).io)).ok, false);
  });
  it('não reabre se o guardado já atinge o alvo', async () => {
    const m = makeIo({ goals: [goal({ status: 'cancelled' })], txs: [{ type: 'deposit', amountCents: 100000 }] });
    assert.equal((await reopenGoal(uid, 'g1', m.io)).ok, false);
    assert.equal(m.calls.update.length, 0);
  });
  it('exclui sem movimentações; bloqueia com movimentações e em falha (fail-closed)', async () => {
    const ok = makeIo();
    assert.equal((await deleteGoal(uid, 'g1', ok.io)).ok, true);
    assert.equal(ok.calls.audit[0].action, 'delete');
    assert.equal((await deleteGoal(uid, 'g1', makeIo({ linked: 2 }).io)).ok, false);
    const fail = makeIo();
    fail.io.count = async () => { throw new Error('x'); };
    const orig = console.error; console.error = () => {};
    const r = await deleteGoal(uid, 'g1', fail.io);
    console.error = orig;
    assert.equal(r.ok, false);
    assert.equal(fail.calls.remove.length, 0);
  });
});

describe('transferência para metas (conta → meta → conta)', () => {
  it('transferableGoals: só ativas e sem vínculo de conta (vinculadas seguem o saldo da conta)', () => {
    const goals = [goal({ id: 'a' }), goal({ id: 'b', accountId: 'acc1' }), goal({ id: 'c', accountId: 'acc1' }), goal({ id: 'd', status: 'cancelled' }), goal({ id: 'e', status: 'completed' })];
    assert.deepEqual(transferableGoals(goals, new Map([['c', 2]])).map((g) => g.id), ['a', 'c']); // c: vínculo legado com movimentações
  });

  it('histórico recente pede as últimas movimentações por data', async () => {
    let seen;
    await listRecentGoalTransactions(uid, 20, { list: async (_u, c, o) => { seen = [c, o]; return []; } });
    assert.deepEqual(seen, ['goalTransactions', { orderBy: ['date', 'desc'], limit: 20 }]);
  });
});
