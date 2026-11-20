/**
 * Saldo derivado das contas (VF-4-03): lê só movimentos REALIZADOS, cada coleção limitada a
 * READ_LIMIT; `truncated` lista as coleções que atingiram o teto (saldo possivelmente incompleto).
 * Usado pelo dashboard (a cada carga) e por Bancos (sob demanda, para poupar a cota de leituras).
 */
import { COLLECTIONS } from '../utils/constants.js';
import { list } from './firestore.js';
import { accountBalances, orphanMovements } from '../core/model.js';

export const READ_LIMIT = 1000;

/**
 * Retorna { balances: Map(accountId → centavos), movements, truncated: string[], orphans: { count, byCollection } }.
 * `accounts` já carregadas pelo chamador; `io.list` injetável. `movements` expõe as listas lidas
 * (o dashboard reaproveita receitas/despesas para o resultado do mês, sem reler).
 */
export async function loadBalances(uid, accounts, io = {}) {
  const fetchList = io.list ?? list;
  const capped = (collection, extra = {}) => fetchList(uid, collection, { limit: READ_LIMIT, ...extra });
  const [incomes, expenses, transfers, debtPayments, goalTransactions, invoices] = await Promise.all([
    capped(COLLECTIONS.incomes, { where: [['status', '==', 'received']] }),
    capped(COLLECTIONS.expenses, { where: [['status', '==', 'paid']] }),
    capped(COLLECTIONS.transfers, { where: [['status', '==', 'confirmed']] }),
    capped(COLLECTIONS.debtPayments),
    capped(COLLECTIONS.goalTransactions),
    capped(COLLECTIONS.invoices, { where: [['status', '==', 'paid']] }), // faturas pagas debitam a conta (VF-2-03p)
  ]);
  const movements = { incomes, expenses, transfers, debtPayments, goalTransactions, invoices };
  const truncated = Object.entries(movements).filter(([, rows]) => rows.length >= READ_LIMIT).map(([name]) => name);
  return { balances: accountBalances(accounts, movements), movements, truncated, orphans: orphanMovements(accounts, movements) };
}
