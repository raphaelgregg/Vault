/**
 * Serviço do Dashboard (VF-2-03f): carrega e agrega, sem gravar nada.
 * Leituras (orçamento de leitura, VF-4-03): contas + movimentos REALIZADOS (receitas received,
 * despesas paid, transferências confirmed, recebimentos de devedores e aportes de metas), cada um
 * limitado a READ_LIMIT; se algum atingir o teto, `truncated` lista as coleções e a UI avisa que o
 * saldo pode estar incompleto. Vencimentos usam os índices (status, data) já declarados.
 * Total por carga ≈ 5 + 3 + 3 + devedores + orçamentos consultas; documentos lidos ≤ ~5×READ_LIMIT + listas curtas.
 */
import { COLLECTIONS } from '../utils/constants.js';
import { list } from './firestore.js';
import { summarizeDebtors, formatCents } from '../core/model.js';
import { loadBalances, READ_LIMIT } from './balances.js';
import {
  monthResult,
  totalBalanceCents,
  upcomingDue,
} from '../core/aggregates.js';
import { getBudgetProgress } from './budgets.js';

export { READ_LIMIT };
const SHORT_LIMIT = 8;

/** Mês "YYYY-MM" e data "YYYY-MM-DD" de hoje em UTC (mesma convenção das datas gravadas). */
export function todayParts(now = new Date()) {
  const iso = now.toISOString().slice(0, 10);
  return { today: iso, month: iso.slice(0, 7) };
}

/** Retorna { totalBalanceCents, month, result, upcoming, budgets, debtors, truncated, accountCount }. */
export async function loadDashboard(uid, io = {}) {
  const fetchList = io.list ?? list;
  const { today, month } = todayParts(io.now ? io.now() : new Date());
  const capped = (collection, extra = {}) => fetchList(uid, collection, { limit: READ_LIMIT, ...extra });

  const accounts = await fetchList(uid, COLLECTIONS.accounts, {});
  const { balances, movements, truncated } = await loadBalances(uid, accounts, { list: fetchList });
  const { incomes, expenses } = movements;
  const [pendingExpenses, subscriptions, invoices, debtors, budgets] = await Promise.all([
    fetchList(uid, COLLECTIONS.expenses, {
      where: [['status', '==', 'pending'], ['dueDate', '>=', today]], orderBy: ['dueDate', 'asc'], limit: SHORT_LIMIT,
    }),
    fetchList(uid, COLLECTIONS.subscriptions, {
      where: [['status', '==', 'active']], orderBy: ['nextChargeDate', 'asc'], limit: SHORT_LIMIT,
    }),
    fetchList(uid, COLLECTIONS.invoices, {
      where: [['status', '==', 'closed']], orderBy: ['dueDate', 'asc'], limit: SHORT_LIMIT,
    }),
    capped(COLLECTIONS.debtors),
    getBudgetProgress(uid, month, { list: fetchList }),
  ]);

  return {
    month,
    accountCount: accounts.filter((a) => a.status === 'active').length,
    totalBalanceCents: totalBalanceCents(accounts, balances),
    result: monthResult(incomes, expenses, month),
    upcoming: upcomingDue({ expenses: pendingExpenses, subscriptions, invoices, today }),
    budgets: budgets.summary,
    debtors: summarizeDebtors(debtors),
    truncated: [...truncated, ...(budgets.truncated ? ['budgetExpenses'] : [])],
  };
}

export { formatCents };
