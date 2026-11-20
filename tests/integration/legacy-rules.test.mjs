/**
 * VF-COR-01 — compatibilidade com as Security Rules AINDA PUBLICADAS (antigas, sem a coleção `reversals`).
 * Com elas, a leitura de `reversals` dá permission-denied; as telas de Transferências (metas) e de Devedores (modal de
 * parcelas / nova dívida) dependem de `listGoalTransactions` e `loadDebtorStatements`, que NÃO podem falhar por isso.
 * Fixture: `tests/fixtures/firestore.rules.legacy` (cópia das Rules anteriores à VF-ARQ-02).
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startEnv, makeRealIo, attempt, ALICE } from './helpers/real-io.mjs';
import { seedAccount, seedDebtor, seedPlan } from './helpers/world.mjs';
import { createGoal } from '../../js/services/goals.js';
import { listGoalTransactions } from '../../js/services/goals.js';
import { getDebtorStatement, loadDebtorStatements } from '../../js/services/debtors.js';
import { loadDebtorLedger } from '../../js/services/debtPayments.js';

let env;
before(async () => { env = await startEnv('tests/fixtures/firestore.rules.legacy'); });
after(async () => { await env?.cleanup(); });
beforeEach(async () => { await env.clearFirestore(); });

describe('Rules antigas (sem `reversals`)', () => {
  it('CONTROLE: a leitura direta de `reversals` é mesmo negada (permission-denied) — o cenário real da produção', async () => {
    const io = makeRealIo(env);
    const r = await attempt(() => io.list(ALICE, 'reversals', {}));
    assert.deepEqual([r.ok, r.code], [false, 'permission-denied']);
  });

  it('Transferências/metas: listGoalTransactions devolve as movimentações (sem estornos) em vez de lançar', async () => {
    const io = makeRealIo(env);
    const goal = await createGoal(ALICE, { name: 'Viagem', targetCents: '500,00' }, io);
    assert.equal(goal.ok, true);
    const rows = await listGoalTransactions(ALICE, goal.id, { list: io.list });
    assert.deepEqual(rows, []);
  });

  it('Devedores: o extrato (modal de parcelas e "Nova dívida") carrega com dívidas, sem estornos', async () => {
    const io = makeRealIo(env);
    await seedAccount(io, '100,00');
    const debtorId = await seedDebtor(io);
    await seedPlan(io, debtorId, '300,00', 3);
    const debtor = (await io.list(ALICE, 'debtors', {}))[0];
    const statement = await getDebtorStatement(ALICE, debtor, '2026-12', { list: io.list });
    assert.equal(statement.debts.length, 3);
    assert.deepEqual(statement.reversals, []);
    const map = await loadDebtorStatements(ALICE, [debtor], '2026-12', { list: io.list, includeAll: true });
    assert.equal(map.get(debtor.id).debts.length, 3);
    const ledger = await loadDebtorLedger(ALICE, debtor, { list: io.list });
    assert.equal(ledger.debts.length, 3);
  });
});
