/**
 * Serviço de auditoria de integridade financeira (somente leitura). Lê as coleções do usuário (cada uma limitada a
 * READ_LIMIT; `truncated` lista as que bateram no teto, caso em que a auditoria é parcial) e delega o cálculo a
 * `core/integrity.js`. NÃO grava nem corrige nada: devolve as diferenças encontradas.
 */
import { COLLECTIONS } from '../utils/constants.js';
import { list } from './firestore.js';
import { READ_LIMIT } from './balances.js';
import { auditLedgerData } from '../core/integrity.js';

const SOURCES = {
  accounts: COLLECTIONS.accounts, debtors: COLLECTIONS.debtors, debts: COLLECTIONS.debts, payments: COLLECTIONS.debtPayments,
  purchases: COLLECTIONS.cardPurchases, invoices: COLLECTIONS.invoices, transfers: COLLECTIONS.transfers,
  incomes: COLLECTIONS.incomes, expenses: COLLECTIONS.expenses, goalTransactions: COLLECTIONS.goalTransactions, reversals: COLLECTIONS.reversals,
};

/** Retorna { findings, errors, warnings, totals, truncated }. Falha de leitura propaga (auditoria não pode ser "verde" sem ler). */
export async function auditFinancialIntegrity(uid, io = {}) {
  const fetchList = io.list ?? list;
  const data = {};
  const truncated = [];
  await Promise.all(Object.entries(SOURCES).map(async ([key, collection]) => {
    data[key] = await fetchList(uid, collection, { limit: READ_LIMIT });
    if (data[key].length >= READ_LIMIT) truncated.push(collection);
  }));
  return { ...auditLedgerData(data), truncated };
}
