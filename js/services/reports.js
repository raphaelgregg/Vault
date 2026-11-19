/**
 * Serviço de Relatórios (VF-2-03g): somente leitura. Período em meses [fromMonth, toMonth]
 * (máx. 24 meses); lê apenas o intervalo (receivedDate/paidDate) com teto READ_LIMIT por coleção.
 * Realizado = receitas `received` e despesas `paid`. Exportação CSV é gerada no cliente (sem libs).
 */
import { COLLECTIONS } from '../utils/constants.js';
import { list } from './firestore.js';
import { monthBounds, monthsBetween } from '../utils/dates.js';
import { totalsByCategory, monthlySeries, sumSeries, toCsv } from '../core/aggregates.js';
import { formatCents, centsToMoneyString } from '../core/model.js';

export const REPORT_READ_LIMIT = 2000;
export const MAX_REPORT_MONTHS = 24;

/** Valida o período; retorna { ok, errors?, months }. */
export function validatePeriod(fromMonth, toMonth) {
  const months = monthsBetween(fromMonth, toMonth);
  if (!months.length) return { ok: false, errors: { _form: 'Período inválido: informe meses válidos, do mais antigo ao mais recente.' }, months };
  if (months.length > MAX_REPORT_MONTHS) {
    return { ok: false, errors: { _form: `O período máximo é de ${MAX_REPORT_MONTHS} meses.` }, months };
  }
  return { ok: true, months };
}

/**
 * Retorna { ok, series, totals, expensesByCategory, incomesByCategory, categories (Map id→nome), truncated }
 * ou { ok:false, errors }. `io.list` injetável.
 */
export async function loadReport(uid, fromMonth, toMonth, io = {}) {
  const period = validatePeriod(fromMonth, toMonth);
  if (!period.ok) return period;
  const fetchList = io.list ?? list;
  const start = monthBounds(fromMonth).start;
  const end = monthBounds(toMonth).end;
  const [incomes, expenses, categories] = await Promise.all([
    fetchList(uid, COLLECTIONS.incomes, {
      where: [['receivedDate', '>=', start], ['receivedDate', '<=', end]],
      orderBy: ['receivedDate', 'asc'], limit: REPORT_READ_LIMIT,
    }),
    fetchList(uid, COLLECTIONS.expenses, {
      where: [['paidDate', '>=', start], ['paidDate', '<=', end]],
      orderBy: ['paidDate', 'asc'], limit: REPORT_READ_LIMIT,
    }),
    fetchList(uid, COLLECTIONS.categories, {}),
  ]);
  const series = monthlySeries(incomes, expenses, fromMonth, toMonth);
  return {
    ok: true,
    series,
    totals: sumSeries(series),
    expensesByCategory: totalsByCategory(expenses, 'expense', fromMonth, toMonth),
    incomesByCategory: totalsByCategory(incomes, 'income', fromMonth, toMonth),
    categories: new Map(categories.map((c) => [c.id, c.name])),
    truncated: incomes.length >= REPORT_READ_LIMIT || expenses.length >= REPORT_READ_LIMIT,
  };
}

/** CSV da série mensal (valores em reais com vírgula, a partir de centavos inteiros). */
export function seriesToCsv(series = []) {
  const money = (c) => `${c < 0 ? '-' : ''}${centsToMoneyString(Math.abs(c))}`;
  const rows = series.map((r) => ({
    month: r.month, income: money(r.incomeCents), expense: money(r.expenseCents), result: money(r.resultCents),
  }));
  return toCsv(rows, [
    { key: 'month', label: 'Mês' }, { key: 'income', label: 'Receitas' },
    { key: 'expense', label: 'Despesas' }, { key: 'result', label: 'Resultado' },
  ]);
}

/** CSV de totais por categoria; `names`: Map id→nome; categoria removida vira "(sem categoria)". */
export function categoriesToCsv(rows = [], names = new Map()) {
  const data = rows.map((r) => ({
    category: names.get(r.categoryId) ?? '(sem categoria)',
    total: centsToMoneyString(r.totalCents), count: r.count, share: `${r.sharePercent}%`,
  }));
  return toCsv(data, [
    { key: 'category', label: 'Categoria' }, { key: 'total', label: 'Total' },
    { key: 'count', label: 'Lançamentos' }, { key: 'share', label: 'Participação' },
  ]);
}

export { formatCents };
