/**
 * Serviço de Categorias — Fase 3: CRUD + validação do modelo + auditoria.
 * Isolamento por usuário via users/{uid}/categories.
 */
import { COLLECTIONS } from '../utils/constants.js';
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
} from '../core/model.js';

const COLLECTION = COLLECTIONS.categories;

/** Lista todas as categorias do usuário ordenadas por nome. */
export async function listCategories(uid) {
  return list(uid, COLLECTION, {
    orderBy: ['name', 'asc'],
  });
}

/** Busca uma categoria por ID. */
export async function getCategory(uid, categoryId) {
  return getById(uid, COLLECTION, categoryId);
}

/**
 * Cria uma nova categoria.
 * Retorna { ok, id, errors }.
 */
export async function createCategory(uid, rawData) {
  const { ok, data, errors } = buildEntity('categories', rawData);
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
 * Atualiza uma categoria existente.
 * Retorna { ok, errors }.
 */
export async function updateCategory(uid, categoryId, rawData) {
  const { ok, data, errors } = buildEntity('categories', rawData);
  if (!ok) return { ok: false, errors };

  await update(uid, COLLECTION, categoryId, data);
  await writeAudit(uid, {
    action: 'update',
    collection: COLLECTION,
    docId: categoryId,
    after: data,
  });
  return { ok: true };
}

/** Exclui uma categoria. */
export async function deleteCategory(uid, categoryId) {
  const category = await getById(uid, COLLECTION, categoryId);
  if (!category) return { ok: false, errors: { _form: 'Categoria não encontrada.' } };

  await remove(uid, COLLECTION, categoryId);
  await writeAudit(uid, {
    action: 'delete',
    collection: COLLECTION,
    docId: categoryId,
    before: category,
  });
  return { ok: true };
}

/** Tipos de categoria para <select>. */
export const CATEGORY_KINDS = Object.freeze([
  { value: 'income', label: 'Receita' },
  { value: 'expense', label: 'Despesa' },
  { value: 'both', label: 'Ambos' },
]);

export function getCategoryKindOptions() {
  return CATEGORY_KINDS;
}