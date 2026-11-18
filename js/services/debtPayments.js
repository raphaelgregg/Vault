/**
 * Serviço de Parcelas (debts) e Recebimentos (debtPayments) de devedores (VF-2-03b2).
 * Contrato = firestore.rules. Registrar recebimento é ATÔMICO (um lote): grava o
 * recebimento, atualiza a parcela (paga ao completar o principal) e o devedor
 * (receivedCents/status paid) com as auditorias no mesmo lote.
 *
 * Recebimentos entram em accountBalances (saldo da conta aumenta); o saldo continua derivado.
 * Limitações: leitura prévia + lote sem transação (janela de concorrência; as Rules
 * não validam a soma); recebimento é imutável (sem estorno) — registrar errado exige novo VF.
 */
import { COLLECTIONS } from '../utils/constants.js';
import {
  list,
  getById,
  createAudited,
  updateAudited,
  commitAtomic,
} from './firestore.js';
import {
  buildEntity,
  applyPaymentToDebtor,
  DEBT_STATUSES,
  formatCents,
  parseMoneyToCents,
} from '../core/model.js';

const DEBTS = COLLECTIONS.debts;
const PAYMENTS = COLLECTIONS.debtPayments;
const DEBTORS = COLLECTIONS.debtors;
const MAX_INSTALLMENT = 360;

export async function listDebts(uid, debtorId) {
  return list(uid, DEBTS, { where: [['debtorId', '==', debtorId]] });
}

export async function listDebtPayments(uid, options = {}) {
  const constraints = {};
  if (options.where) constraints.where = options.where;
  return list(uid, PAYMENTS, constraints);
}

/** Cria parcela (status sempre `pending`). Devedor precisa existir e estar em aberto. */
export async function createDebt(uid, rawData, deps = {}) {
  const fetch = deps.getById ?? getById;
  const debtor = rawData?.debtorId ? await fetch(uid, DEBTORS, String(rawData.debtorId)) : null;
  if (!debtor) return { ok: false, errors: { debtorId: 'Devedor não encontrado.' } };
  if (debtor.status !== 'open') {
    return { ok: false, errors: { _form: 'Só é possível criar parcelas para devedor em aberto.' } };
  }
  let installmentNumber = rawData.installmentNumber;
  if (installmentNumber === undefined || installmentNumber === null || installmentNumber === '') {
    const existing = await (deps.list ?? list)(uid, DEBTS, { where: [['debtorId', '==', debtor.id ?? rawData.debtorId]] });
    installmentNumber = existing.reduce((max, d) => Math.max(max, Number(d.installmentNumber) || 0), 0) + 1;
    if (installmentNumber > MAX_INSTALLMENT) {
      return { ok: false, errors: { installmentNumber: `Máximo de ${MAX_INSTALLMENT} parcelas.` } };
    }
  }
  const { ok, data, errors } = buildEntity('debts', { ...rawData, installmentNumber, status: 'pending' });
  if (!ok) return { ok: false, errors };
  const id = await createAudited(uid, DEBTS, data, deps);
  return { ok: true, id };
}

/** Cancela parcela pendente/atrasada sem recebimentos. `paid` só nasce de recebimentos. */
export async function cancelDebt(uid, debtId, io = {}) {
  const debt = await (io.getById ?? getById)(uid, DEBTS, debtId);
  if (!debt) return { ok: false, errors: { _form: 'Parcela não encontrada.' } };
  if (!['pending', 'late'].includes(debt.status)) {
    return { ok: false, errors: { _form: 'Só é possível cancelar parcelas pendentes ou atrasadas.' } };
  }
  const received = await sumPayments(uid, debtId, io);
  if (received > 0) {
    return { ok: false, errors: { _form: 'A parcela já possui recebimentos e não pode ser cancelada.' } };
  }
  await updateAudited(uid, DEBTS, debtId, { status: 'cancelled' }, io, 'cancel');
  return { ok: true };
}

async function sumPayments(uid, debtId, io) {
  const payments = await (io.list ?? list)(uid, PAYMENTS, { where: [['debtId', '==', debtId]] });
  return payments.reduce((total, p) => total + (Number(p.amountCents) || 0), 0);
}

/**
 * Registra um recebimento de uma parcela. Retorna { ok, id, debtPaid, debtorPaid, errors }.
 * `rawData`: { amountCents, date, accountId, notes? } (dinheiro como string pt-BR).
 * `io`: getById, list, commitAtomic injetáveis.
 */
export async function registerDebtPayment(uid, debtId, rawData, io = {}) {
  const fetch = io.getById ?? getById;
  const debt = await fetch(uid, DEBTS, debtId);
  if (!debt) return { ok: false, errors: { _form: 'Parcela não encontrada.' } };
  if (!['pending', 'late'].includes(debt.status)) {
    return { ok: false, errors: { _form: 'Esta parcela não aceita recebimentos.' } };
  }
  const debtor = await fetch(uid, DEBTORS, debt.debtorId);
  if (!debtor) return { ok: false, errors: { _form: 'Devedor não encontrado.' } };

  const { ok, data, errors } = buildEntity('debtPayments', { ...rawData, debtId, debtorId: debt.debtorId });
  if (!ok) return { ok: false, errors };

  const account = await fetch(uid, COLLECTIONS.accounts, data.accountId);
  if (!account) return { ok: false, errors: { accountId: 'Conta não encontrada.' } };
  if (account.status !== 'active') return { ok: false, errors: { accountId: 'A conta precisa estar ativa.' } };

  const applied = applyPaymentToDebtor(debtor, data.amountCents);
  if (!applied.ok) return { ok: false, errors: { amountCents: applied.error } };

  const alreadyReceived = await sumPayments(uid, debtId, io);
  const debtPending = debt.principalCents - alreadyReceived;
  if (data.amountCents > debtPending) {
    return { ok: false, errors: { amountCents: `O valor excede o saldo pendente da parcela (${formatCents(Math.max(0, debtPending))}).` } };
  }
  const debtPaid = data.amountCents === debtPending;

  const ops = [{ type: 'create', collection: PAYMENTS, data }];
  if (debtPaid) ops.push({ type: 'update', collection: DEBTS, docId: debtId, data: { status: 'paid' }, action: 'pay' });
  ops.push({
    type: 'update',
    collection: DEBTORS,
    docId: debt.debtorId,
    data: { receivedCents: applied.receivedCents, status: applied.status },
    action: 'receive',
  });

  const [id] = await (io.commitAtomic ?? commitAtomic)(uid, ops, io);
  return { ok: true, id, debtPaid, debtorPaid: applied.status === 'paid' };
}

export function getDebtStatusOptions() {
  return DEBT_STATUSES.map((s) => ({ value: s.value, label: s.label }));
}

export { formatCents, parseMoneyToCents };
