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

/**
 * Transições de status permitidas. `cancelled` é terminal; `confirmed` só pode ser
 * cancelada (nunca volta a pendente nem é confirmada de novo).
 */
export const TRANSFER_TRANSITIONS = Object.freeze({
  pending: ['confirmed', 'cancelled'],
  confirmed: ['cancelled'],
  cancelled: [],
});

/** Verifica se a transição de status é permitida. Puro. */
export function canTransitionTransfer(from, to) {
  return (TRANSFER_TRANSITIONS[from] ?? []).includes(to);
}

const STATUS_LABELS = { pending: 'pendente', confirmed: 'confirmada', cancelled: 'cancelada' };

/**
 * Lê o estado atual, valida a transição e (ao confirmar) revalida as contas.
 * `io` permite injetar dependências nos testes (padrão: services/firestore.js).
 * Limitação: leitura+escrita não atômica (janela de concorrência; as Rules não
 * validam transição de status).
 */
async function transitionTransfer(uid, transferId, nextStatus, action, io = {}) {
  const {
    getById: getFn = getById,
    update: updateFn = update,
    writeAudit: auditFn = writeAudit,
  } = io;

  const transfer = await getFn(uid, COLLECTION, transferId);
  if (!transfer) return { ok: false, errors: { _form: 'Transferência não encontrada.' } };

  if (!canTransitionTransfer(transfer.status, nextStatus)) {
    const current = STATUS_LABELS[transfer.status] ?? String(transfer.status);
    return {
      ok: false,
      errors: {
        _form: `Transferência já está ${current}; não é possível ${nextStatus === 'confirmed' ? 'confirmá-la' : 'cancelá-la'}.`,
      },
    };
  }

  if (nextStatus === 'confirmed') {
    try {
      const [from, to] = await Promise.all([
        getFn(uid, COLLECTIONS.accounts, transfer.fromAccountId),
        getFn(uid, COLLECTIONS.accounts, transfer.toAccountId),
      ]);
      if (!from || !to) {
        return {
          ok: false,
          errors: { _form: 'Conta de origem ou destino não existe mais; não é possível confirmar.' },
        };
      }
    } catch (error) {
      console.error('[transfers] falha ao verificar contas', error);
      return {
        ok: false,
        errors: { _form: 'Não foi possível verificar as contas da transferência. Tente novamente.' },
      };
    }
  }

  await updateFn(uid, COLLECTION, transferId, { status: nextStatus });
  await auditFn(uid, {
    action,
    collection: COLLECTION,
    docId: transferId,
    after: { status: nextStatus },
  });
  return { ok: true };
}

/** Marca transferência como confirmada (movimenta saldo). Retorna { ok, errors }. */
export async function confirmTransfer(uid, transferId, io) {
  return transitionTransfer(uid, transferId, 'confirmed', 'confirm', io);
}

/** Marca transferência como cancelada. Retorna { ok, errors }. */
export async function cancelTransfer(uid, transferId, io) {
  return transitionTransfer(uid, transferId, 'cancelled', 'cancel', io);
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