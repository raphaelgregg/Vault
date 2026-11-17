/**
 * Serviço de Despesas — Fase 3: CRUD + validação do modelo + auditoria.
 * Isolamento por usuário via users/{uid}/expenses.
 */
import { COLLECTIONS, RECURRENCES } from '../utils/constants.js';
import {
  create,
  list,
  getById,
  update,
  remove,
  writeAudit,
} from './firestore.js';
import {
  validateEntity,
  buildEntity,
  formatCents,
  parseMoneyToCents,
} from '../core/model.js';

const COLLECTION = COLLECTIONS.expenses;

/** Lista despesas com filtros opcionais. */
export async function listExpenses(uid, options = {}) {
  const constraints = { orderBy: ['dueDate', 'asc'] };
  if (options.where) constraints.where = options.where;
  if (options.limit) constraints.limit = options.limit;
  return list(uid, COLLECTION, constraints);
}

/** Busca uma despesa por ID. */
export async function getExpense(uid, expenseId) {
  return getById(uid, COLLECTION, expenseId);
}

/**
 * Cria uma nova despesa.
 * Retorna { ok, id, errors }.
 */
export async function createExpense(uid, rawData) {
  const { ok, data, errors } = buildEntity('expenses', rawData);
  if (!ok) return { ok: false, errors };

  const id = await create(uid, COLLECTION, data);
  await writeAudit(uid, {
    action: 'create',
    collection: COLLECTION,
    docId: id,
    after: data,
  });
  return { ok: true, id };
}

/**
 * Atualiza uma despesa existente.
 * Retorna { ok, errors }.
 */
export async function updateExpense(uid, expenseId, rawData) {
  const { ok, data, errors } = buildEntity('expenses', rawData);
  if (!ok) return { ok: false, errors };

  await update(uid, COLLECTION, expenseId, data);
  await writeAudit(uid, {
    action: 'update',
    collection: COLLECTION,
    docId: expenseId,
    after: data,
  });
  return { ok: true };
}

/** Exclui uma despesa. */
export async function deleteExpense(uid, expenseId) {
  const expense = await getById(uid, COLLECTION, expenseId);
  if (!expense) return { ok: false, errors: { _form: 'Despesa não encontrada.' } };

  await remove(uid, COLLECTION, expenseId);
  await writeAudit(uid, {
    action: 'delete',
    collection: COLLECTION,
    docId: expenseId,
    before: expense,
  });
  return { ok: true };
}

/** Marca despesa como paga (status -> paid + paidDate = hoje). */
export async function markExpensePaid(uid, expenseId, paidDate = null) {
  const date = paidDate ?? new Date().toISOString().split('T')[0];
  await update(uid, COLLECTION, expenseId, {
    status: 'paid',
    paidDate: date,
  });
  await writeAudit(uid, {
    action: 'mark_paid',
    collection: COLLECTION,
    docId: expenseId,
    after: { status: 'paid', paidDate: date },
  });
  return { ok: true };
}

/** Marca despesa como cancelada. */
export async function cancelExpense(uid, expenseId) {
  await update(uid, COLLECTION, expenseId, { status: 'cancelled' });
  await writeAudit(uid, {
    action: 'cancel',
    collection: COLLECTION,
    docId: expenseId,
    after: { status: 'cancelled' },
  });
  return { ok: true };
}

/** Opções de recorrência para <select>. */
export function getRecurrenceOptions() {
  return RECURRENCES.map((r) => ({ value: r.value, label: r.label }));
}

/** Status options for expense. */
export function getExpenseStatusOptions() {
  return [
    { value: 'pending', label: 'Pendente' },
    { value: 'paid', label: 'Paga' },
    { value: 'cancelled', label: 'Cancelada' },
  ];
}

export { formatCents, parseMoneyToCents };