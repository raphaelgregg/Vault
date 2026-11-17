/**
 * Serviço de Transferências — Fase 3: CRUD + validação do modelo + auditoria.
 * Isolamento por usuário via users/{uid}/transfers.
 */
import { COLLECTIONS } from '../utils/constants.js';
import {
  create,
  list,
  getById,
  update,
  remove,
  writeAudit,
  newBatch,
} from './firestore.js';
import {
  validateEntity,
  buildEntity,
  formatCents,
  parseMoneyToCents,
} from '../core/model.js';

const COLLECTION = COLLECTIONS.transfers;

/** Lista transferências com filtros opcionais. */
export async function listTransfers(uid, options = {}) {
  const constraints = { orderBy: ['date', 'desc'] };
  if (options.where) constraints.where = options.where;
  if (options.limit) constraints.limit = options.limit;
  return list(uid, COLLECTION, constraints);
}

/** Busca uma transferência por ID. */
export async function getTransfer(uid, transferId) {
  return getById(uid, COLLECTION, transferId);
}

/**
 * Cria uma nova transferência.
 * Retorna { ok, id, errors }.
 */
export async function createTransfer(uid, rawData) {
  const { ok, data, errors } = buildEntity('transfers', rawData);
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
 * Atualiza uma transferência existente.
 * Retorna { ok, errors }.
 */
export async function updateTransfer(uid, transferId, rawData) {
  const { ok, data, errors } = buildEntity('transfers', rawData);
  if (!ok) return { ok: false, errors };

  await update(uid, COLLECTION, transferId, data);
  await writeAudit(uid, {
    action: 'update',
    collection: COLLECTION,
    docId: transferId,
    after: data,
  });
  return { ok: true };
}

/** Exclui uma transferência. */
export async function deleteTransfer(uid, transferId) {
  const transfer = await getById(uid, COLLECTION, transferId);
  if (!transfer) return { ok: false, errors: { _form: 'Transferência não encontrada.' } };

  await remove(uid, COLLECTION, transferId);
  await writeAudit(uid, {
    action: 'delete',
    collection: COLLECTION,
    docId: transferId,
    before: transfer,
  });
  return { ok: true };
}

/** Marca transferência como confirmada (movimenta saldo). */
export async function confirmTransfer(uid, transferId) {
  await update(uid, COLLECTION, transferId, { status: 'confirmed' });
  await writeAudit(uid, {
    action: 'confirm',
    collection: COLLECTION,
    docId: transferId,
    after: { status: 'confirmed' },
  });
  return { ok: true };
}

/** Marca transferência como cancelada. */
export async function cancelTransfer(uid, transferId) {
  await update(uid, COLLECTION, transferId, { status: 'cancelled' });
  await writeAudit(uid, {
    action: 'cancel',
    collection: COLLECTION,
    docId: transferId,
    after: { status: 'cancelled' },
  });
  return { ok: true };
}

/** Status options for transfer. */
export function getTransferStatusOptions() {
  return [
    { value: 'pending', label: 'Pendente' },
    { value: 'confirmed', label: 'Confirmada' },
    { value: 'cancelled', label: 'Cancelada' },
  ];
}

export { formatCents, parseMoneyToCents };