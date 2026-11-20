/** VF-COR-01 — tolerância à leitura negada de `reversals` (Rules antigas) sem esconder falhas reais. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { reversalsOrNone, isPermissionDenied } from '../../js/utils/reversalsAccess.js';
import { listGoalTransactions } from '../../js/services/goals.js';
import { loadDebtorStatements } from '../../js/services/debtors.js';

const denied = () => Object.assign(new Error('Missing or insufficient permissions.'), { code: 'permission-denied' });
const quiet = async (fn) => { const w = console.warn; console.warn = () => {}; try { return await fn(); } finally { console.warn = w; } };

describe('reversalsOrNone', () => {
  it('permission-denied vira lista vazia; sucesso passa; qualquer outro erro PROPAGA', async () => {
    assert.deepEqual(await quiet(() => reversalsOrNone(Promise.reject(denied()))), []);
    assert.deepEqual(await reversalsOrNone(Promise.resolve([{ id: 'r' }])), [{ id: 'r' }]);
    for (const code of ['unavailable', 'deadline-exceeded', 'failed-precondition', undefined]) {
      await assert.rejects(() => reversalsOrNone(Promise.reject(Object.assign(new Error('x'), { code }))), /x/, String(code));
    }
    assert.equal(isPermissionDenied({ code: 'permission-denied' }), true);
    assert.equal(isPermissionDenied({ code: 'firestore/permission-denied' }), true);
    assert.equal(isPermissionDenied(new Error('x')), false);
  });
});

describe('serviços sob Rules antigas', () => {
  it('listGoalTransactions: movimentações voltam mesmo com `reversals` negada; outros erros continuam falhando', async () => {
    const list = async (_u, c) => { if (c === 'reversals') throw denied(); return [{ id: 't1', type: 'deposit', amountCents: 100 }]; };
    const rows = await quiet(() => listGoalTransactions('u', 'g1', { list }));
    assert.deepEqual(rows.map((r) => [r.id, Boolean(r.reversed)]), [['t1', false]]);
    const down = async (_u, c) => { if (c === 'reversals') throw Object.assign(new Error('offline'), { code: 'unavailable' }); return []; };
    await assert.rejects(() => listGoalTransactions('u', 'g1', { list: down }), /offline/);
  });

  it('loadDebtorStatements: extrato monta com dívidas/recebimentos quando só `reversals` é negada; erro de rede propaga', async () => {
    const debtor = { id: 'd1', name: 'J', status: 'open', lentCents: 1000, receivedCents: 0 };
    const tables = { debts: [{ id: 'x', debtorId: 'd1', principalCents: 1000, dueDate: '2026-12-10', installmentNumber: 1, status: 'pending' }], debtPayments: [], cardPurchases: [], invoices: [] };
    const list = async (_u, c) => { if (c === 'reversals') throw denied(); return tables[c] ?? []; };
    const map = await quiet(() => loadDebtorStatements('u', [debtor], '2026-12', { list, includeAll: true }));
    assert.equal(map.get('d1').debts.length, 1);
    assert.deepEqual(map.get('d1').reversals, []);
    const down = async (_u, c) => { if (c === 'reversals') throw Object.assign(new Error('offline'), { code: 'unavailable' }); return tables[c] ?? []; };
    await assert.rejects(() => loadDebtorStatements('u', [debtor], '2026-12', { list: down, includeAll: true }), /offline/);
  });
});
