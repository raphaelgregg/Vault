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

/** Fontes de dados do dashboard; `failed` lista as que falharam (isoladas: uma falha não derruba as demais). */
export const DASHBOARD_SOURCES = Object.freeze(['accounts', 'movements', 'pendingExpenses', 'subscriptions', 'invoices', 'debtors', 'budgets']);

/**
 * Retorna { totalBalanceCents, month, result, upcoming, budgets, debtors, truncated, accountCount, failed }.
 * Fonte que falha → campo `null` (saldo/resultado/orçamentos/devedores) ou ausente de `upcoming`, e a
 * fonte entra em `failed` (a UI mostra aviso explícito). Coleção vazia não é falha (zeros).
 */
export async function loadDashboard(uid, io = {}) {
  const fetchList = io.list ?? list;
  const { today, month } = todayParts(io.now ? io.now() : new Date());
  const capped = (collection, extra = {}) => fetchList(uid, collection, { limit: READ_LIMIT, ...extra });
  const failed = [];
  const attempt = async (source, fn, fallback) => {
    try {
      return await fn();
    } catch (error) {
      console.error(`[dashboard] falha na fonte "${source}"`, error);
      failed.push(source);
      return fallback;
    }
  };

  const [accounts, pendingExpenses, subscriptions, invoices, debtors, budgets] = await Promise.all([
    attempt('accounts', () => fetchList(uid, COLLECTIONS.accounts, {}), null),
    attempt('pendingExpenses', () => fetchList(uid, COLLECTIONS.expenses, {
      where: [['status', '==', 'pending'], ['dueDate', '>=', today]], orderBy: ['dueDate', 'asc'], limit: SHORT_LIMIT,
    }), []),
    attempt('subscriptions', () => fetchList(uid, COLLECTIONS.subscriptions, {
      where: [['status', '==', 'active']], orderBy: ['nextChargeDate', 'asc'], limit: SHORT_LIMIT,
    }), []),
    attempt('invoices', () => fetchList(uid, COLLECTIONS.invoices, {
      where: [['status', '==', 'closed']], orderBy: ['dueDate', 'asc'], limit: SHORT_LIMIT,
    }), []),
    attempt('debtors', () => capped(COLLECTIONS.debtors), null),
    attempt('budgets', () => getBudgetProgress(uid, month, { list: fetchList }), null),
  ]);

  // Saldo/resultado dependem das contas E dos movimentos realizados; sem um deles ficam indisponíveis (null).
  const loaded = accounts
    ? await attempt('movements', () => loadBalances(uid, accounts, { list: fetchList }), null)
    : null;

  return {
    month,
    accountCount: accounts ? accounts.filter((a) => a.status === 'active').length : null,
    totalBalanceCents: loaded ? totalBalanceCents(accounts, loaded.balances) : null,
    result: loaded ? monthResult(loaded.movements.incomes, loaded.movements.expenses, month) : null,
    upcoming: upcomingDue({ expenses: pendingExpenses, subscriptions, invoices, today }),
    budgets: budgets ? budgets.summary : null,
    debtors: debtors ? summarizeDebtors(debtors) : null,
    truncated: [...(loaded?.truncated ?? []), ...(budgets?.truncated ? ['budgetExpenses'] : [])],
    failed,
  };
}

export { formatCents };
