/**
 * Serviço de Receitas — Fase 3: CRUD + validação do modelo + auditoria.
 * Isolamento por usuário via users/{uid}/incomes.
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
  checkCategoryForMovement,
  SCHEMAS,
  formatCents,
  parseMoneyToCents,
} from '../core/model.js';

const COLLECTION = COLLECTIONS.incomes;
const CATEGORY_COLLECTION = COLLECTIONS.categories;
// Tipos aceitos vêm do schema (fonte única: kindCompat).
const ALLOWED_CATEGORY_KINDS = SCHEMAS.incomes.fields.categoryId.kindCompat;

/** Leitura autoritativa da categoria no Firestore do próprio usuário. */
async function fetchCategory(uid, categoryId) {
  return getById(uid, CATEGORY_COLLECTION, categoryId);
}

/** Lista receitas com filtros opcionais. */
export async function listIncomes(uid, options = {}) {
  const constraints = { orderBy: ['expectedDate', 'desc'] };
  if (options.where) constraints.where = options.where;
  if (options.limit) constraints.limit = options.limit;
  return list(uid, COLLECTION, constraints);
}

/** Busca uma receita por ID. */
export async function getIncome(uid, incomeId) {
  return getById(uid, COLLECTION, incomeId);
}

/**
 * Cria uma nova receita.
 * Ordem: modelo → existência da categoria no Firestore → compatibilidade de tipo.
 * O terceiro parâmetro (deps) existe apenas como ponto de injeção em testes;
 * em produção o lookup padrão lê users/{uid}/categories direto no Firestore.
 * Retorna { ok, id, errors }.
 */
export async function createIncome(uid, rawData, deps = {}) {
  const { ok, data, errors } = buildEntity('incomes', rawData);
  if (!ok) return { ok: false, errors };

  const lookupCategory = deps.lookupCategory ?? fetchCategory;
  const category = await lookupCategory(uid, data.categoryId);
  const categoryCheck = checkCategoryForMovement(category, ALLOWED_CATEGORY_KINDS);
  if (!categoryCheck.ok) return categoryCheck;

  const createDoc = deps.create ?? create;
  const audit = deps.writeAudit ?? writeAudit;
  const id = await createDoc(uid, COLLECTION, data);
  await audit(uid, {
    action: 'create',
    collection: COLLECTION,
    docId: id,
    after: data,
  });
  return { ok: true, id };
}

/**
 * Atualiza uma receita existente.
 * Mesma ordem de validação de createIncome.
 * Retorna { ok, errors }.
 */
export async function updateIncome(uid, incomeId, rawData, deps = {}) {
  const { ok, data, errors } = buildEntity('incomes', rawData);
  if (!ok) return { ok: false, errors };

  const lookupCategory = deps.lookupCategory ?? fetchCategory;
  const category = await lookupCategory(uid, data.categoryId);
  const categoryCheck = checkCategoryForMovement(category, ALLOWED_CATEGORY_KINDS);
  if (!categoryCheck.ok) return categoryCheck;

  const updateDoc = deps.update ?? update;
  const audit = deps.writeAudit ?? writeAudit;
  await updateDoc(uid, COLLECTION, incomeId, data);
  await audit(uid, {
    action: 'update',
    collection: COLLECTION,
    docId: incomeId,
    after: data,
  });
  return { ok: true };
}

/** Exclui uma receita. */
export async function deleteIncome(uid, incomeId) {
  const income = await getById(uid, COLLECTION, incomeId);
  if (!income) return { ok: false, errors: { _form: 'Receita não encontrada.' } };

  await remove(uid, COLLECTION, incomeId);
  await writeAudit(uid, {
    action: 'delete',
    collection: COLLECTION,
    docId: incomeId,
    before: income,
  });
  return { ok: true };
}

/** Marca receita como recebida (status -> received + receivedDate = hoje). */
export async function markIncomeReceived(uid, incomeId, receivedDate = null) {
  const date = receivedDate ?? new Date().toISOString().split('T')[0];
  await update(uid, COLLECTION, incomeId, {
    status: 'received',
    receivedDate: date,
  });
  await writeAudit(uid, {
    action: 'mark_received',
    collection: COLLECTION,
    docId: incomeId,
    after: { status: 'received', receivedDate: date },
  });
  return { ok: true };
}

/** Marca receita como cancelada. */
export async function cancelIncome(uid, incomeId) {
  await update(uid, COLLECTION, incomeId, { status: 'cancelled' });
  await writeAudit(uid, {
    action: 'cancel',
    collection: COLLECTION,
    docId: incomeId,
    after: { status: 'cancelled' },
  });
  return { ok: true };
}

/** Opções de recorrência para <select>. */
export function getRecurrenceOptions() {
  return RECURRENCES.map((r) => ({ value: r.value, label: r.label }));
}

/** Status options for income. */
export function getIncomeStatusOptions() {
  return [
    { value: 'pending', label: 'Prevista' },
    { value: 'received', label: 'Recebida' },
    { value: 'cancelled', label: 'Cancelada' },
  ];
}

export { formatCents, parseMoneyToCents };