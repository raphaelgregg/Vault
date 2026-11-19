/**
 * Serviço de Orçamentos (VF-2-03e). Contrato = firestore.rules (`budgets`: categoryId, month, limitCents).
 * Gasto, restante e percentual são DERIVADOS (js/core/aggregates.js); só o limite é gravado.
 * Um orçamento por categoria/mês (checado na leitura — janela de concorrência como nos demais).
 * Escopo do gasto: despesas não canceladas pelo mês de vencimento; compras no cartão não entram.
 */
import { COLLECTIONS } from '../utils/constants.js';
import { list, getById, createAudited, updateAudited, removeAudited } from './firestore.js';
import {
  buildEntity,
  checkCategoryForMovement,
  SCHEMAS,
  formatCents,
  parseMoneyToCents,
} from '../core/model.js';
import { budgetRows, summarizeBudgetRows } from '../core/aggregates.js';
import { monthBounds } from '../utils/dates.js';

const COLLECTION = COLLECTIONS.budgets;
const ALLOWED_KINDS = SCHEMAS.budgets.fields.categoryId.kindCompat;
/** Teto de leitura de despesas por carga (VF-4-03); acima disso o resultado é sinalizado. */
export const EXPENSE_READ_LIMIT = 1000;

export async function listBudgets(uid, month) {
  return list(uid, COLLECTION, { where: [['month', '==', month]] });
}

async function findDuplicate(uid, data, io, ignoreId = null) {
  const found = await (io.list ?? list)(uid, COLLECTION, {
    where: [['month', '==', data.month], ['categoryId', '==', data.categoryId]],
  });
  return found.some((b) => b.id !== ignoreId);
}

/** Retorna { ok, id, errors }. `io`: getById, list, create, writeAudit. */
export async function createBudget(uid, rawData, io = {}) {
  const { ok, data, errors } = buildEntity('budgets', rawData);
  if (!ok) return { ok: false, errors };
  const category = await (io.getById ?? getById)(uid, COLLECTIONS.categories, data.categoryId);
  const check = checkCategoryForMovement(category, ALLOWED_KINDS);
  if (!check.ok) return check;
  if (await findDuplicate(uid, data, io)) {
    return { ok: false, errors: { categoryId: 'Já existe orçamento desta categoria neste mês.' } };
  }
  const id = await createAudited(uid, COLLECTION, data, io);
  return { ok: true, id };
}

/** Só o limite é editável (categoria e mês são a identidade do orçamento). */
export async function updateBudgetLimit(uid, budgetId, rawLimit, io = {}) {
  const current = await (io.getById ?? getById)(uid, COLLECTION, budgetId);
  if (!current) return { ok: false, errors: { _form: 'Orçamento não encontrado.' } };
  const { ok, data, errors } = buildEntity('budgets', {
    categoryId: current.categoryId, month: current.month, limitCents: rawLimit,
  });
  if (!ok) return { ok: false, errors };
  await updateAudited(uid, COLLECTION, budgetId, { limitCents: data.limitCents }, io);
  return { ok: true };
}

export async function deleteBudget(uid, budgetId, io = {}) {
  const current = await (io.getById ?? getById)(uid, COLLECTION, budgetId);
  if (!current) return { ok: false, errors: { _form: 'Orçamento não encontrado.' } };
  await removeAudited(uid, COLLECTION, budgetId, current, io);
  return { ok: true };
}

/**
 * Orçamentos do mês com gasto derivado. Lê só as despesas com vencimento no mês (intervalo em
 * `dueDate`, limitado a EXPENSE_READ_LIMIT). Retorna { rows, summary, truncated }.
 */
export async function getBudgetProgress(uid, month, io = {}) {
  const bounds = monthBounds(month);
  if (!bounds) return { rows: [], summary: summarizeBudgetRows([]), truncated: false };
  const fetchList = io.list ?? list;
  const [budgets, expenses] = await Promise.all([
    fetchList(uid, COLLECTION, { where: [['month', '==', month]] }),
    fetchList(uid, COLLECTIONS.expenses, {
      where: [['dueDate', '>=', bounds.start], ['dueDate', '<=', bounds.end]],
      orderBy: ['dueDate', 'asc'],
      limit: EXPENSE_READ_LIMIT,
    }),
  ]);
  const rows = budgetRows(budgets, expenses, month);
  return { rows, summary: summarizeBudgetRows(rows), truncated: expenses.length >= EXPENSE_READ_LIMIT };
}

export { formatCents, parseMoneyToCents };
