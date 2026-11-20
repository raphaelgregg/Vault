/**
 * VF-COR-01 — leitura de `reversals` negada (Rules antigas) é DESCONHECIDA, nunca "nenhum estorno":
 * estrito por padrão (erro), modo limitado só por opt-in (lista marcada), e qualquer outro erro sempre propaga.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readReversals, isPermissionDenied, reversalsUnavailable, unknownReversals, ReversalsUnavailableError, loadErrorMessage } from '../../js/utils/reversalsAccess.js';
import { listGoalTransactions } from '../../js/services/goals.js';
import { loadDebtorStatements } from '../../js/services/debtors.js';

const denied = () => Object.assign(new Error('Missing or insufficient permissions.'), { code: 'permission-denied' });
const offline = () => Object.assign(new Error('offline'), { code: 'unavailable' });
const quiet = async (fn) => { const w = console.warn; console.warn = () => {}; try { return await fn(); } finally { console.warn = w; } };

describe('readReversals', () => {
  it('estrito (padrão): permission-denied → ReversalsUnavailableError (código reversals-unavailable); sucesso passa', async () => {
    await assert.rejects(() => readReversals(Promise.reject(denied())), (e) => e instanceof ReversalsUnavailableError && e.code === 'reversals-unavailable' && /estornos/.test(e.message));
    assert.deepEqual(await readReversals(Promise.resolve([{ id: 'r' }])), [{ id: 'r' }]);
  });
  it('limitado (tolerate): devolve lista MARCADA como desconhecida — distinguível de "vazia"', async () => {
    const unknown = await quiet(() => readReversals(Promise.reject(denied()), { tolerate: true }));
    assert.deepEqual([unknown.length, reversalsUnavailable(unknown)], [0, true]);
    const empty = await readReversals(Promise.resolve([]), { tolerate: true });
    assert.deepEqual([empty.length, reversalsUnavailable(empty)], [0, false]); // vazia REAL ≠ desconhecida
    assert.equal(reversalsUnavailable(unknownReversals()), true);
  });
  it('qualquer outro erro PROPAGA em ambos os modos (rede, indisponibilidade, pré-condição…)', async () => {
    for (const tolerate of [false, true]) for (const code of ['unavailable', 'deadline-exceeded', 'failed-precondition', 'internal', undefined]) {
      await assert.rejects(() => readReversals(Promise.reject(Object.assign(new Error('x'), { code })), { tolerate }), /x/, `${tolerate}/${code}`);
    }
    assert.equal(isPermissionDenied({ code: 'firestore/permission-denied' }), true);
    assert.equal(isPermissionDenied(new Error('x')), false);
  });
  it('mensagem de carga: a do estorno ilegível; senão a genérica do chamador', () => {
    assert.match(loadErrorMessage(new ReversalsUnavailableError(), () => 'genérica'), /estornos/);
    assert.equal(loadErrorMessage(offline(), () => 'genérica'), 'genérica');
  });
});

describe('serviços', () => {
  const rowsOf = [{ id: 't1', type: 'deposit', amountCents: 6000 }];
  it('listGoalTransactions: estrito lança; limitado devolve linhas MARCADAS como estornos desconhecidos; com estornos legíveis marca `reversed`', async () => {
    const list = async (_u, c) => { if (c === 'reversals') throw denied(); return rowsOf; };
    await assert.rejects(() => listGoalTransactions('u', 'g1', { list }), ReversalsUnavailableError);
    const limited = await quiet(() => listGoalTransactions('u', 'g1', { list, tolerateReversalsDenied: true }));
    assert.deepEqual([limited.length, reversalsUnavailable(limited), limited[0].reversed], [1, true, undefined]);
    const readable = async (_u, c) => (c === 'reversals' ? [{ id: 'goalTransactions_t1', targetCollection: 'goalTransactions', targetId: 't1' }] : rowsOf);
    const rows = await listGoalTransactions('u', 'g1', { list: readable });
    assert.deepEqual([rows[0].reversed, reversalsUnavailable(rows)], [true, false]);
    const down = async (_u, c) => { if (c === 'reversals') throw offline(); return rowsOf; };
    for (const io of [{ list: down }, { list: down, tolerateReversalsDenied: true }]) await assert.rejects(() => listGoalTransactions('u', 'g1', io), /offline/);
  });

  it('loadDebtorStatements: estrito lança; limitado marca o extrato (`reversalsUnavailable`); legível desconta o estorno; rede propaga', async () => {
    const debtor = { id: 'd1', name: 'J', status: 'open', lentCents: 20000, receivedCents: 0 };
    const tables = { debts: [{ id: 'x', debtorId: 'd1', principalCents: 10000, dueDate: '2026-12-10', installmentNumber: 1, status: 'pending' }],
      debtPayments: [{ id: 'p1', debtId: 'x', debtorId: 'd1', amountCents: 10000 }], cardPurchases: [], invoices: [] };
    const denyList = async (_u, c) => { if (c === 'reversals') throw denied(); return tables[c] ?? []; };
    await assert.rejects(() => loadDebtorStatements('u', [debtor], '2026-12', { list: denyList, includeAll: true }), ReversalsUnavailableError);
    const limited = await quiet(() => loadDebtorStatements('u', [debtor], '2026-12', { list: denyList, includeAll: true, tolerateReversalsDenied: true }));
    assert.equal(limited.get('d1').reversalsUnavailable, true);
    const readable = async (_u, c) => (c === 'reversals' ? [{ id: 'debtPayments_p1', targetCollection: 'debtPayments', targetId: 'p1', debtorId: 'd1' }] : tables[c] ?? []);
    const ok = await loadDebtorStatements('u', [debtor], '2026-12', { list: readable, includeAll: true });
    assert.equal(ok.get('d1').reversalsUnavailable, undefined);
    assert.equal(ok.get('d1').reversals.length, 1);
    const empty = await loadDebtorStatements('u', [debtor], '2026-12', { list: async (_u, c) => tables[c] ?? [], includeAll: true });
    assert.equal(empty.get('d1').reversalsUnavailable, undefined);
    const down = async (_u, c) => { if (c === 'reversals') throw offline(); return tables[c] ?? []; };
    for (const extra of [{}, { tolerateReversalsDenied: true }]) await assert.rejects(() => loadDebtorStatements('u', [debtor], '2026-12', { list: down, includeAll: true, ...extra }), /offline/);
  });
});
