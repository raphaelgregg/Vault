/** Firestore em memória para testes de devedores (lote atômico; `create` em ID existente = negado pelas Rules). */
export const UID = 'u1';
export const DEBTOR = 'd1';

/** Base em memória com o contrato do Firestore que importa aqui: lote atômico e `create` com ID existente negado (Rules). */
export function makeStore(seed = {}) {
  const tables = structuredClone({
    accounts: [{ id: 'acc', status: 'active', institution: 'Banco', name: 'Conta', initialBalanceCents: 100000 }, { id: 'off', status: 'inactive', institution: 'Banco', name: 'Off', initialBalanceCents: 0 }],
    debtors: [{ id: DEBTOR, name: 'Renan', status: 'open', lentCents: 23100, receivedCents: 0 }],
    cards: [{ id: 'k1', name: 'Nubank' }],
    invoices: [{ id: 'inv12', cardId: 'k1', referenceMonth: '2026-12', dueDate: '2026-12-06', status: 'open' }],
    cardPurchases: [
      { id: 'pAgua', cardId: 'k1', debtorId: DEBTOR, description: 'Água', amountCents: 2500, invoiceId: 'inv12', installmentNumber: 1, installmentsTotal: 1, purchaseDate: '2026-11-20' },
      { id: 'pMercado', cardId: 'k1', debtorId: DEBTOR, description: 'Mercado', amountCents: 7800, invoiceId: 'inv12', installmentNumber: 1, installmentsTotal: 1, purchaseDate: '2026-11-21' },
      { id: 'pSuper', cardId: 'k1', debtorId: DEBTOR, description: 'Supermercado', amountCents: 2800, invoiceId: 'inv12', installmentNumber: 1, installmentsTotal: 1, purchaseDate: '2026-11-22' },
    ],
    debts: [
      { id: 'dNov', debtorId: DEBTOR, description: 'Parcela', principalCents: 5000, dueDate: '2026-11-30', installmentNumber: 1, installmentsTotal: 2, debtGroupId: 'g1', status: 'pending' },
      { id: 'dDez', debtorId: DEBTOR, description: 'Parcela', principalCents: 5000, dueDate: '2026-12-30', installmentNumber: 2, installmentsTotal: 2, debtGroupId: 'g1', status: 'pending' },
    ],
    debtPayments: [],
    ...seed,
  });
  const calls = { commits: [] };
  const where = (rows, clauses = []) => rows.filter((r) => clauses.every(([f, op, v]) => (op === '==' ? r[f] === v : op === 'in' ? v.includes(r[f]) : true)));
  const io = {
    getById: async (_u, c, id) => structuredClone((tables[c] ?? []).find((r) => r.id === id) ?? null),
    list: async (_u, c, o = {}) => structuredClone(where(tables[c] ?? [], o.where)),
    commitAtomic: async (_u, ops) => {
      calls.commits.push(structuredClone(ops));
      if (ops.length > 250) throw new Error('lote acima do limite');
      const draft = structuredClone(tables);
      let n = 0;
      const ids = [];
      for (const op of ops) {
        draft[op.collection] ??= [];
        if (op.type === 'create') {
          const id = op.docId ?? `auto${(n += 1)}${draft[op.collection].length}`;
          // Rules: criar em ID que já existe vira update e exige createdAt imutável (serverTimestamp muda) → negado.
          if (draft[op.collection].some((r) => r.id === id)) throw Object.assign(new Error('permission-denied'), { code: 'permission-denied' });
          draft[op.collection].push({ id, ...op.data });
          ids.push(id);
        } else {
          const row = draft[op.collection].find((r) => r.id === op.docId);
          if (!row) throw new Error('not-found');
          Object.assign(row, op.data);
          for (const [field, delta] of Object.entries(op.increments ?? {})) row[field] = (Number(row[field]) || 0) + delta; // increment() atômico do servidor
          ids.push(op.docId);
        }
      }
      for (const k of Object.keys(draft)) tables[k] = draft[k]; // tudo ou nada
      return ids;
    },
  };
  // loadDebtorStatements lê 'cardPurchases'/'debts'/'debtPayments'/'invoices' pelo nome da coleção
  return { tables, io, calls };
}
