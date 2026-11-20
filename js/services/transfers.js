/**
 * Serviço de Transferências — Fase 3: CRUD + validação do modelo + auditoria.
 * Isolamento por usuário via users/{uid}/transfers.
 */
import { COLLECTIONS } from '../utils/constants.js';
import {
  list,
  getById,
  createAudited,
  updateAudited,
  removeAudited,
} from './firestore.js';
import { buildEntity, formatCents, parseMoneyToCents, accountLabel } from '../core/model.js';
import { loadBalances } from './balances.js';

const COLLECTION = COLLECTIONS.transfers;

/** Lista transferências com filtros opcionais. */
export async function listTransfers(uid, options = {}) {
  const constraints = { orderBy: ['date', 'desc'] };
  if (options.where) constraints.where = options.where;
  if (options.orderBy) constraints.orderBy = options.orderBy;
  if (options.startAfterId) constraints.startAfterId = options.startAfterId;
  if (options.limit) constraints.limit = options.limit;
  return list(uid, COLLECTION, constraints);
}

/** Busca uma transferência por ID. */
export async function getTransfer(uid, transferId) {
  return getById(uid, COLLECTION, transferId);
}

/**
 * Saldo suficiente na conta de origem? A transferência só move dinheiro ao ser CONFIRMADA (saldo derivado:
 * `accountBalances`), então a checagem vale para status `confirmed` (criar, editar ou confirmar). Retorna
 * `null` se ok, ou { ok:false, errors:{ [field]: msg } }. `creditCents` = valor desta mesma transferência já
 * debitado no saldo (edição de uma confirmada), devolvido antes de comparar. Fail-closed se não der para
 * ler conta/movimentos. `io.getById`/`io.list` injetáveis.
 * LIMITAÇÃO: checagem client-side (janela de concorrência entre leitura e gravação, como nas demais
 * verificações); o saldo lê até READ_LIMIT movimentos por coleção (ver services/balances.js).
 */
export async function checkSufficientBalance(uid, fromAccountId, amountCents, { creditCents = 0, field = 'fromAccountId', what = 'transferência' } = {}, io = {}) {
  try {
    const account = await (io.getById ?? getById)(uid, COLLECTIONS.accounts, fromAccountId);
    if (!account) return { ok: false, errors: { [field]: 'Conta de origem não encontrada.' } };
    const { balances } = await loadBalances(uid, [account], io.list ? { list: io.list } : {});
    const available = (balances.get(account.id) ?? 0) + creditCents;
    if (available < amountCents) {
      return {
        ok: false,
        errors: { [field]: `Saldo insuficiente em ${accountLabel(account)}: disponível ${formatCents(available)}, ${what} de ${formatCents(amountCents)}.` },
      };
    }
    return null;
  } catch (error) {
    console.error('[transfers] falha ao verificar saldo', error);
    return { ok: false, errors: { [field]: 'Não foi possível verificar o saldo da conta de origem. A operação não foi registrada; tente novamente.' } };
  }
}

/**
 * Cria uma nova transferência.
 * Transferência já `confirmed` exige saldo suficiente na origem; `pending` não move dinheiro (a checagem
 * acontece ao confirmar). Retorna { ok, id, errors }.
 */
export async function createTransfer(uid, rawData, io = {}) {
  const { ok, data, errors } = buildEntity('transfers', rawData);
  if (!ok) return { ok: false, errors };

  if (data.status === 'confirmed') {
    const blocked = await checkSufficientBalance(uid, data.fromAccountId, data.amountCents, {}, io);
    if (blocked) return blocked;
  }

  const id = await createAudited(uid, COLLECTION, data, io);
  return { ok: true, id };
}

/**
 * Atualiza uma transferência existente.
 * Retorna { ok, errors }.
 */
export async function updateTransfer(uid, transferId, rawData, io = {}) {
  const { ok, data, errors } = buildEntity('transfers', rawData);
  if (!ok) return { ok: false, errors };

  if (data.status === 'confirmed') {
    // Se já estava confirmada na mesma origem, o valor antigo já está debitado: devolve-o antes de comparar.
    const before = await (io.getById ?? getById)(uid, COLLECTION, transferId);
    const creditCents = before?.status === 'confirmed' && before.fromAccountId === data.fromAccountId ? Number(before.amountCents) || 0 : 0;
    const blocked = await checkSufficientBalance(uid, data.fromAccountId, data.amountCents, { creditCents }, io);
    if (blocked) return blocked;
  }

  await updateAudited(uid, COLLECTION, transferId, data, io);
  return { ok: true };
}

/**
 * Exclui uma transferência de qualquer status. O saldo é DERIVADO (só transferências `confirmed` movem dinheiro),
 * então excluir uma confirmada devolve o valor à origem e o retira do destino sem gravar nada nas contas:
 * `reversed`/`amountCents` informam o estorno à interface.
 */
export async function deleteTransfer(uid, transferId, io = {}) {
  const transfer = await (io.getById ?? getById)(uid, COLLECTION, transferId);
  if (!transfer) return { ok: false, errors: { _form: 'Transferência não encontrada.' } };

  await removeAudited(uid, COLLECTION, transferId, transfer, io);
  return { ok: true, reversed: transfer.status === 'confirmed', amountCents: Number(transfer.amountCents) || 0 };
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
  const { getById: getFn = getById } = io;

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
      const blocked = await checkSufficientBalance(uid, transfer.fromAccountId, Number(transfer.amountCents) || 0, {}, io);
      if (blocked) return { ok: false, errors: { _form: blocked.errors.fromAccountId } };
    } catch (error) {
      console.error('[transfers] falha ao verificar contas', error);
      return {
        ok: false,
        errors: { _form: 'Não foi possível verificar as contas da transferência. Tente novamente.' },
      };
    }
  }

  await updateAudited(uid, COLLECTION, transferId, { status: nextStatus }, io, action);
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
