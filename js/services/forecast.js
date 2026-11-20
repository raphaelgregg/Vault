/**
 * Serviço da previsão mensal (leitura): busca o que o dashboard ainda não lê e delega o cálculo a
 * `core/forecast.js` (puro). Não grava nada. Leituras (≤ READ_LIMIT cada; índices já declarados):
 *   - despesas com vencimento no mês (qualquer status) — faixa em `dueDate`;
 *   - despesas pendentes anteriores ao mês (vencidas) — índice status+dueDate;
 *   - receitas pendentes até o fim do mês — índice status+expectedDate;
 *   - assinaturas ativas.
 * Saldo, cartões/faturas/compras e a receber de devedores vêm do chamador (dashboard), que já os leu.
 * `truncated` lista as leituras que bateram no teto (a previsão pode estar incompleta).
 */
import { COLLECTIONS } from '../utils/constants.js';
import { list } from './firestore.js';
import { monthBounds } from '../utils/dates.js';
import { monthlyForecast } from '../core/forecast.js';
import { READ_LIMIT } from './balances.js';

export async function loadMonthlyForecast(uid, input, io = {}) {
  const fetchList = io.list ?? list;
  const { month, today } = input;
  const bounds = monthBounds(month);
  if (!bounds) throw new RangeError('Mês inválido (use AAAA-MM).');
  const capped = (collection, extra) => fetchList(uid, collection, { limit: READ_LIMIT, ...extra });
  const [inMonth, overdueBefore, pendingIncomes, subscriptions] = await Promise.all([
    capped(COLLECTIONS.expenses, { where: [['dueDate', '>=', bounds.start], ['dueDate', '<=', bounds.end]], orderBy: ['dueDate', 'asc'] }),
    capped(COLLECTIONS.expenses, { where: [['status', '==', 'pending'], ['dueDate', '<', bounds.start]], orderBy: ['dueDate', 'asc'] }),
    capped(COLLECTIONS.incomes, { where: [['status', '==', 'pending'], ['expectedDate', '<=', bounds.end]], orderBy: ['expectedDate', 'asc'] }),
    capped(COLLECTIONS.subscriptions, { where: [['status', '==', 'active']] }),
  ]);
  const truncated = Object.entries({ expensesInMonth: inMonth, expensesOverdue: overdueBefore, incomesPending: pendingIncomes, subscriptions })
    .filter(([, rows]) => rows.length >= READ_LIMIT).map(([name]) => name);
  const forecast = monthlyForecast({
    ...input,
    today,
    expenses: [...inMonth, ...overdueBefore],
    pendingIncomes,
    subscriptions,
  });
  return { ...forecast, truncated };
}
