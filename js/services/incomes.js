/**
 * Serviço de Receitas — Fase 3: CRUD + validação do modelo + auditoria.
 * Isolamento por usuário via users/{uid}/incomes.
 */
import { COLLECTIONS, RECURRENCES } from '../utils/constants.js';
import {
  list,
  getById,
  createAudited,
  updateAudited,
  removeAudited,
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

  const id = await createAudited(uid, COLLECTION, data, deps);
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

  await updateAudited(uid, COLLECTION, incomeId, data, deps);
  return { ok: true };
}

/** Exclui uma receita. */
export async function deleteIncome(uid, incomeId, io = {}) {
  const income = await (io.getById ?? getById)(uid, COLLECTION, incomeId);
  if (!income) return { ok: false, errors: { _form: 'Receita não encontrada.' } };

  await removeAudited(uid, COLLECTION, incomeId, income, io);
  return { ok: true };
}

/** Marca receita como recebida (status -> received + receivedDate = hoje). */
export async function markIncomeReceived(uid, incomeId, receivedDate = null, io = {}) {
  const date = receivedDate ?? new Date().toISOString().split('T')[0];
  await updateAudited(uid, COLLECTION, incomeId, { status: 'received', receivedDate: date }, io, 'mark_received');
  return { ok: true };
}

/** Marca receita como cancelada. */
export async function cancelIncome(uid, incomeId, io = {}) {
  await updateAudited(uid, COLLECTION, incomeId, { status: 'cancelled' }, io, 'cancel');
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