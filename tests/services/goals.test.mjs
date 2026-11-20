/**
 * Testes de Metas e movimentações (VF-2-03c): modelo, saldo derivado, fluxo atômico, transições.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { transferableGoals, listRecentGoalTransactions } from '../../js/services/goals.js';
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

describe('registerGoalTransaction — fluxo atômico', () => {
  it('aporte parcial: só a movimentação no lote', async () => {
    const { io, calls } = makeIo();
    const r = await depositToGoal(uid, 'g1', raw(), io);
    assert.deepEqual([r.ok, r.id, r.status, r.savedCents], [true, 'tx1', 'active', 30000]);
    assert.equal(calls.atomic[0].length, 1);
    assert.deepEqual(calls.atomic[0][0].data, { goalId: 'g1', type: 'deposit', amountCents: 30000, date: '2026-11-18', accountId: 'acc1' });
    assert.equal(calls.create.length + calls.update.length, 0);
  });
  it('aporte que atinge o alvo conclui a meta no mesmo lote', async () => {
    const { io, calls } = makeIo({ txs: [{ type: 'deposit', amountCents: 70000 }] });
    const r = await depositToGoal(uid, 'g1', raw(), io);
    assert.equal(r.status, 'completed');
    assert.deepEqual(calls.atomic[0][1], { type: 'update', collection: 'goals', docId: 'g1', data: { status: 'completed' }, action: 'complete' });
  });
  it('resgate de meta concluída abaixo do alvo reativa; excesso é rejeitado', async () => {
    const { io, calls } = makeIo({ goals: [goal({ status: 'completed' })], txs: [{ type: 'deposit', amountCents: 100000 }] });
    const r = await withdrawFromGoal(uid, 'g1', raw(), io);
    assert.equal(r.status, 'active');
    assert.equal(calls.atomic[0][1].action, 'reopen');
    const over = await withdrawFromGoal(uid, 'g1', raw({ amountCents: '1.000,01' }), io);
    assert.ok(over.errors._form);
    assert.equal(calls.atomic.length, 1);
  });
  it('rejeita meta inexistente/cancelada/concluída (aporte), conta inválida e dados inválidos', async () => {
    const run = (setup, r = raw(), id = 'g1') => { const m = makeIo(setup); return registerGoalTransaction(uid, id, 'deposit', r, m.io).then((x) => ({ x, calls: m.calls })); };
    assert.equal((await run({}, raw(), 'zz')).x.ok, false);
    assert.equal((await run({ goals: [goal({ status: 'cancelled' })] })).x.ok, false);
    assert.equal((await run({ goals: [goal({ status: 'completed' })] })).x.ok, false);
    assert.ok((await run({ accounts: [] })).x.errors.accountId);
    assert.ok((await run({ accounts: [account({ status: 'inactive' })] })).x.errors.accountId);
    assert.ok((await run({}, raw({ amountCents: '0' }))).x.errors.amountCents);
    assert.ok((await run({}, raw({ date: 'hoje' }))).x.errors.date);
    const { calls } = await run({ goals: [goal({ status: 'cancelled' })] });
    assert.equal(calls.atomic.length, 0);
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
  it('aporte sem saldo na conta é bloqueado e nada é gravado; com saldo grava', async () => {
    const poor = makeIo({ accounts: [account({ initialBalanceCents: 10000 })] });
    const r = await depositToGoal(uid, 'g1', raw({ amountCents: '300,00' }), poor.io);
    assert.equal(r.ok, false);
    assert.match(r.errors.accountId, /Saldo insuficiente em Nubank — Corrente: disponível R\$ 100,00, aporte de R\$ 300,00/);
    assert.equal(poor.calls.atomic.length, 0);
    const ok = makeIo({ accounts: [account({ initialBalanceCents: 30000 })] });
    assert.equal((await depositToGoal(uid, 'g1', raw({ amountCents: '300,00' }), ok.io)).ok, true);
  });

  it('resgate não exige saldo da conta, mas não passa do guardado', async () => {
    const empty = makeIo({ accounts: [account({ initialBalanceCents: 0 })], txs: [{ type: 'deposit', amountCents: 50000, accountId: 'acc1' }] });
    assert.equal((await withdrawFromGoal(uid, 'g1', raw({ amountCents: '500,00' }), empty.io)).ok, true);
    const over = makeIo({ txs: [{ type: 'deposit', amountCents: 50000, accountId: 'acc1' }] });
    assert.equal((await withdrawFromGoal(uid, 'g1', raw({ amountCents: '500,01' }), over.io)).ok, false);
  });

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
