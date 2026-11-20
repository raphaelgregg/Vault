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
import { loadDebtorStatements } from './debtors.js';
import {
  buildEntity,
  applyPaymentToDebtor,
  debtorObligations,
  pendingInstallmentsOfMonth,
  receivedByInstallment,
  addMonths,
  isValidIsoDate,
  clampDayInMonth,
  splitInstallments,
  centsToMoneyString,
  DEBT_STATUSES,
  formatCents,
  parseMoneyToCents,
} from '../core/model.js';

const DEBTS = COLLECTIONS.debts;
const PAYMENTS = COLLECTIONS.debtPayments;
const DEBTORS = COLLECTIONS.debtors;
const MAX_INSTALLMENT = 360;
const MAX_SETTLE_INSTALLMENTS = 120; // 4 escritas por parcela (recebimento+auditoria, parcela+auditoria) no lote de 500
const MAX_PLAN_INSTALLMENTS = 120; // 2 escritas por parcela (+ devedor) no mesmo lote (limite de 500)

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

/**
 * Cria uma dívida do devedor, à vista (`installments` 1) ou parcelada (N), em UM lote atômico (VF-2-03m).
 * `rawData`: { debtorId, description, totalCents (string pt-BR), installments (padrão 1), firstDueDate }.
 * Parcelas mensais no mesmo dia (com clamp ao fim do mês), valores em centavos inteiros (a 1ª leva o
 * resto da divisão), todas com `installmentsTotal` e o mesmo `debtGroupId`. O total soma ao `lentCents`
 * do devedor (agregado mantido pelo service; o pendente continua `lentCents − receivedCents`).
 * Devedor precisa existir e estar em aberto. `io`: getById, commitAtomic, groupId() injetáveis.
 */
export async function createDebtPlan(uid, rawData, io = {}) {
  const fetch = io.getById ?? getById;
  const debtor = rawData?.debtorId ? await fetch(uid, DEBTORS, String(rawData.debtorId)) : null;
  if (!debtor) return { ok: false, errors: { debtorId: 'Devedor não encontrado.' } };
  if (debtor.status !== 'open') return { ok: false, errors: { _form: 'Só é possível criar dívidas para devedor em aberto.' } };

  const rawN = rawData.installments === undefined || rawData.installments === '' ? 1 : Number(rawData.installments);
  if (!Number.isInteger(rawN) || rawN < 1 || rawN > MAX_PLAN_INSTALLMENTS) {
    return { ok: false, errors: { installments: `Informe de 1 a ${MAX_PLAN_INSTALLMENTS} parcelas.` } };
  }
  const total = parseMoneyToCents(rawData.totalCents);
  if (!Number.isInteger(total) || total <= 0) return { ok: false, errors: { totalCents: 'Informe um valor maior que zero.' } };
  const parts = splitInstallments(total, rawN);
  if (!parts) return { ok: false, errors: { totalCents: 'O valor deve ser de ao menos 1 centavo por parcela.' } };
  const first = /^(\d{4}-\d{2})-(\d{2})$/.exec(rawData.firstDueDate ?? '');
  if (!first || !isValidIsoDate(rawData.firstDueDate)) return { ok: false, errors: { firstDueDate: 'Data inválida (use AAAA-MM-DD).' } };
  const day = Number(first[2]);

  const groupId = io.groupId ? io.groupId() : `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const ops = [];
  for (let n = 1; n <= rawN; n += 1) {
    const month = addMonths(first[1], n - 1);
    const built = buildEntity('debts', {
      debtorId: debtor.id ?? rawData.debtorId, description: rawData.description, principalCents: centsToMoneyString(parts[n - 1]),
      dueDate: clampDayInMonth(month, day), installmentNumber: n, installmentsTotal: rawN, debtGroupId: groupId, status: 'pending',
    });
    if (!built.ok) return { ok: false, errors: built.errors };
    ops.push({ type: 'create', collection: DEBTS, data: built.data });
  }
  ops.push({
    type: 'update', collection: DEBTORS, docId: debtor.id ?? rawData.debtorId, action: 'debt-plan',
    data: { lentCents: (Number(debtor.lentCents) || 0) + total },
  });
  const ids = await (io.commitAtomic ?? commitAtomic)(uid, ops, io);
  return { ok: true, ids, groupId, installments: rawN, totalCents: total };
}

/**
 * Quita (dá baixa no restante de) as parcelas pendentes de um devedor em UM lote atômico (VF-2-03n).
 * `scope.groupId` limita a uma dívida (`debtGroupId`; parcela legada sem grupo usa o próprio id);
 * sem `groupId`, quita todas as dívidas em aberto. Cada parcela recebe um recebimento com o restante
 * (principal − já recebido), vira `paid`, e o devedor soma o total em `receivedCents`
 * (`applyPaymentToDebtor`: nunca acima do pendente; `paid` só quando recebido == emprestado — compras de
 * cartão e valor sem parcela mantêm o devedor em aberto). Parcelas pagas/canceladas e compras de cartão
 * não são tocadas. `rawData`: { date, accountId, notes? }. Retorna { ok, count, totalCents, debtorPaid, errors }.
 */
export async function settleDebts(uid, debtorId, scope = {}, rawData = {}, io = {}) {
  const fetch = io.getById ?? getById;
  const fetchList = io.list ?? list;
  const debtor = await fetch(uid, DEBTORS, debtorId);
  if (!debtor) return { ok: false, errors: { _form: 'Devedor não encontrado.' } };
  if (debtor.status !== 'open') return { ok: false, errors: { _form: 'Só é possível quitar dívidas de devedor em aberto.' } };

  const [debts, payments] = await Promise.all([
    fetchList(uid, DEBTS, { where: [['debtorId', '==', debtorId]] }),
    fetchList(uid, PAYMENTS, { where: [['debtorId', '==', debtorId]] }),
  ]);
  const received = new Map();
  for (const p of payments) received.set(p.debtId, (received.get(p.debtId) ?? 0) + (Number(p.amountCents) || 0));
  const targets = debts
    .filter((d) => ['pending', 'late'].includes(d.status) && (!scope.groupId || (d.debtGroupId ?? d.id) === scope.groupId))
    .map((d) => ({ debt: d, remaining: (Number(d.principalCents) || 0) - (received.get(d.id) ?? 0) }))
    .sort((a, b) => (a.debt.dueDate < b.debt.dueDate ? -1 : 1));
  if (!targets.length) return { ok: false, errors: { _form: 'Não há parcelas pendentes para quitar.' } };
  if (targets.length > MAX_SETTLE_INSTALLMENTS) {
    return { ok: false, errors: { _form: `Quite em partes: máximo de ${MAX_SETTLE_INSTALLMENTS} parcelas por vez.` } };
  }

  const probe = buildEntity('debtPayments', { ...rawData, amountCents: '0,01', debtId: targets[0].debt.id, debtorId });
  if (!probe.ok) return { ok: false, errors: probe.errors }; // valida data/conta/observações uma vez
  const account = await fetch(uid, COLLECTIONS.accounts, rawData.accountId);
  if (!account) return { ok: false, errors: { accountId: 'Conta não encontrada.' } };
  if (account.status !== 'active') return { ok: false, errors: { accountId: 'A conta precisa estar ativa.' } };

  const ops = [];
  let totalCents = 0;
  for (const { debt, remaining } of targets) {
    if (remaining > 0) {
      const built = buildEntity('debtPayments', { ...rawData, amountCents: centsToMoneyString(remaining), debtId: debt.id, debtorId });
      if (!built.ok) return { ok: false, errors: built.errors };
      ops.push({ type: 'create', collection: PAYMENTS, data: built.data, docId: settlementPaymentId(debt.id) });
      totalCents += remaining;
    }
    ops.push({ type: 'update', collection: DEBTS, docId: debt.id, data: { status: 'paid' }, action: 'settle' });
  }
  if (totalCents > 0) {
    const applied = applyPaymentToDebtor(debtor, totalCents);
    if (!applied.ok) return { ok: false, errors: { _form: applied.error } };
    ops.push({
      type: 'update', collection: DEBTORS, docId: debtorId, action: 'receive',
      data: { receivedCents: applied.receivedCents, status: applied.status },
    });
    await (io.commitAtomic ?? commitAtomic)(uid, ops, io);
    return { ok: true, count: targets.length, totalCents, debtorPaid: applied.status === 'paid' };
  }
  await (io.commitAtomic ?? commitAtomic)(uid, ops, io); // só marca como pagas parcelas já integralmente recebidas
  return { ok: true, count: targets.length, totalCents, debtorPaid: false };
}

// ---------------------------------------------------------------------------------------------------------------
// Quitação por parcela e por mês (VF-2-03ak)
// ---------------------------------------------------------------------------------------------------------------

/** ID determinístico do recebimento que QUITA uma parcela (dívida ou compra de cartão): no máximo um por parcela. */
export const settlementPaymentId = (installmentId) => `settle-${installmentId}`;

/**
 * Razão do devedor lido do Firestore: dívidas, compras de cartão vinculadas, faturas e recebimentos (uma leitura
 * por coleção). Retorna { debts, payments, purchases, invoicesById } — insumo de `debtorObligations`.
 * Falha propaga (os chamadores são fail-closed: não quitam sem conhecer os recebimentos existentes).
 */
export async function loadDebtorLedger(uid, debtor, io = {}) {
  const map = await loadDebtorStatements(uid, [debtor], '2000-01', { list: io.list, includeAll: true });
  const st = map.get(debtor.id);
  return { debts: st?.debts ?? [], payments: st?.payments ?? [], purchases: st?.purchases ?? [], invoicesById: st?.invoicesById ?? new Map() };
}

function ledgerInput(debtor, ledger) {
  const { byDebt, byPurchase } = receivedByInstallment(ledger.payments);
  return { debtor, debts: ledger.debts, receivedByDebt: byDebt, receivedByPurchase: byPurchase, purchases: ledger.purchases, invoicesById: ledger.invoicesById };
}

/** Valida conta (existente e ativa) e os campos comuns (data, observações) uma vez. */
async function checkReceiptTarget(uid, rawData, probeFields, fetch) {
  const probe = buildEntity('debtPayments', { ...rawData, amountCents: '0,01', ...probeFields });
  if (!probe.ok) return { ok: false, errors: probe.errors };
  const account = await fetch(uid, COLLECTIONS.accounts, rawData.accountId);
  if (!account) return { ok: false, errors: { accountId: 'Conta não encontrada.' } };
  if (account.status !== 'active') return { ok: false, errors: { accountId: 'A conta precisa estar ativa.' } };
  return { ok: true };
}

/**
 * QUITA UMA parcela do devedor: `target` = { debtId } (parcela de dívida) ou { purchaseId } (parcela de compra no
 * cartão). Grava UM recebimento (`debtPayments`, com `debtId`/`purchaseId`, `date`, `accountId` e o valor
 * efetivamente recebido — padrão: o restante da parcela) e soma ao `receivedCents` do devedor, tudo em UM lote com
 * auditoria. Só a parcela escolhida muda: parcela de dívida vira `paid` quando o restante zera; parcela de cartão é
 * "paga" por derivação (recebido ≥ valor). Valor menor que o restante = recebimento parcial (parcela segue pendente).
 * DUPLICIDADE: (1) parcela já quitada é recusada; (2) o recebimento que quita usa ID determinístico
 * (`settle-<id>`) — um segundo envio concorrente cairia em `update` com `createdAt` diferente e as Rules negam o lote.
 * `rawData`: { date, accountId, amountCents? (pt-BR), notes? }. Retorna { ok, id, settled, remainingCents,
 * amountCents, debtorPaid, anticipated, errors }.
 */
export async function settleInstallment(uid, debtorId, target = {}, rawData = {}, io = {}) {
  const fetch = io.getById ?? getById;
  const installmentId = target.debtId ?? target.purchaseId;
  if (!installmentId || (target.debtId && target.purchaseId)) return { ok: false, errors: { _form: 'Informe a parcela a quitar.' } };
  const debtor = await fetch(uid, DEBTORS, debtorId);
  if (!debtor) return { ok: false, errors: { _form: 'Devedor não encontrado.' } };
  if (debtor.status !== 'open') return { ok: false, errors: { _form: 'Só é possível quitar parcelas de devedor em aberto.' } };

  let ledger;
  try {
    ledger = await loadDebtorLedger(uid, debtor, io);
  } catch (error) {
    console.error('[debtPayments] falha ao ler recebimentos', error);
    return { ok: false, errors: { _form: 'Não foi possível verificar os recebimentos do devedor. A quitação foi cancelada por segurança; tente novamente.' } };
  }
  const source = target.debtId ? 'debt' : 'card';
  const item = debtorObligations(ledgerInput(debtor, ledger)).items.find((i) => i.source === source && i.id === installmentId);
  if (!item) return { ok: false, errors: { _form: 'Parcela não encontrada para este devedor.' } };
  if (item.status === 'paid' || item.remainingCents <= 0) return { ok: false, errors: { _form: 'Esta parcela já foi quitada.' } };
  if (item.status === 'cancelled') return { ok: false, errors: { _form: 'Esta parcela está cancelada.' } };

  const amountCents = rawData.amountCents === undefined || rawData.amountCents === ''
    ? item.remainingCents : parseMoneyToCents(rawData.amountCents);
  if (!Number.isInteger(amountCents) || amountCents <= 0) return { ok: false, errors: { amountCents: 'Informe um valor maior que zero.' } };
  if (amountCents > item.remainingCents) {
    return { ok: false, errors: { amountCents: `O valor excede o restante da parcela (${formatCents(item.remainingCents)}).` } };
  }
  const idField = target.debtId ? { debtId: installmentId } : { purchaseId: installmentId };
  const checked = await checkReceiptTarget(uid, rawData, { ...idField, debtorId }, fetch);
  if (!checked.ok) return checked;
  const built = buildEntity('debtPayments', { date: rawData.date, accountId: rawData.accountId, notes: rawData.notes, amountCents: centsToMoneyString(amountCents), ...idField, debtorId });
  if (!built.ok) return { ok: false, errors: built.errors };
  const applied = applyPaymentToDebtor(debtor, amountCents);
  if (!applied.ok) return { ok: false, errors: { amountCents: applied.error } };

  const settled = amountCents === item.remainingCents;
  const ops = [{ type: 'create', collection: PAYMENTS, data: built.data, ...(settled ? { docId: settlementPaymentId(installmentId) } : {}), action: settled ? 'settle' : 'receive' }];
  if (settled && source === 'debt') ops.push({ type: 'update', collection: DEBTS, docId: installmentId, data: { status: 'paid' }, action: 'pay' });
  ops.push({ type: 'update', collection: DEBTORS, docId: debtorId, data: { receivedCents: applied.receivedCents, status: applied.status }, action: 'receive' });
  const [id] = await (io.commitAtomic ?? commitAtomic)(uid, ops, io);
  const anticipated = typeof item.dueDate === 'string' && built.data.date < item.dueDate;
  return { ok: true, id, settled, amountCents, remainingCents: item.remainingCents - amountCents, debtorPaid: applied.status === 'paid', anticipated };
}

/** Máximo de parcelas por quitação em lote (escritas por parcela cabem no lote de 500 do Firestore). */
export const MAX_MONTH_SETTLE_ITEMS = 100;

/**
 * Parcelas pendentes de um mês de referência (prévia para a confirmação da tela). Puro sobre o razão já lido.
 * Retorna { items, count, totalCents } — o mesmo conjunto que `settleMonthInstallments` efetivaria.
 */
export function previewMonthSettlement({ debtor, ledger, month }) {
  return pendingInstallmentsOfMonth({ month, ...ledgerInput(debtor, ledger) });
}

/**
 * QUITA, em lote, TODAS as parcelas pendentes de um mês de referência ("AAAA-MM") do devedor: dívidas pelo
 * vencimento e compras de cartão pelo mês da fatura. Cada parcela recebe um recebimento com o seu restante e a
 * mesma `date`/`accountId`; parcelas de dívida viram `paid`; o devedor soma o total uma única vez. Parcelas já
 * pagas/canceladas e de outros meses não são tocadas. UM lote atômico (falhou → nada foi gravado). O conjunto é
 * recalculado a partir de uma leitura nova (não confia na prévia da tela), e cada recebimento usa ID determinístico
 * (`settle-<id>`): repetir a operação não duplica (a parcela já está quitada; um envio concorrente é negado pelas Rules).
 * `rawData`: { date, accountId, notes? }. Retorna { ok, count, totalCents, month, debtorPaid, ids, errors }.
 */
export async function settleMonthInstallments(uid, debtorId, month, rawData = {}, io = {}) {
  const fetch = io.getById ?? getById;
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month ?? '')) return { ok: false, errors: { _form: 'Mês de referência inválido (use AAAA-MM).' } };
  const debtor = await fetch(uid, DEBTORS, debtorId);
  if (!debtor) return { ok: false, errors: { _form: 'Devedor não encontrado.' } };
  if (debtor.status !== 'open') return { ok: false, errors: { _form: 'Só é possível quitar parcelas de devedor em aberto.' } };
  let ledger;
  try {
    ledger = await loadDebtorLedger(uid, debtor, io);
  } catch (error) {
    console.error('[debtPayments] falha ao ler recebimentos', error);
    return { ok: false, errors: { _form: 'Não foi possível verificar os recebimentos do devedor. A quitação foi cancelada por segurança; tente novamente.' } };
  }
  const { items, totalCents } = previewMonthSettlement({ debtor, ledger, month });
  if (!items.length) return { ok: false, errors: { _form: 'Não há parcelas pendentes neste mês.' } };
  if (items.length > MAX_MONTH_SETTLE_ITEMS) return { ok: false, errors: { _form: `Quite em partes: máximo de ${MAX_MONTH_SETTLE_ITEMS} parcelas por vez.` } };
  const checked = await checkReceiptTarget(uid, rawData, { debtId: items.find((i) => i.source === 'debt')?.id, purchaseId: items.find((i) => i.source === 'card' && !items.some((x) => x.source === 'debt'))?.id, debtorId }, fetch);
  if (!checked.ok) return checked;
  const applied = applyPaymentToDebtor(debtor, totalCents);
  if (!applied.ok) return { ok: false, errors: { _form: applied.error } };

  const ops = [];
  for (const item of items) {
    const idField = item.source === 'debt' ? { debtId: item.id } : { purchaseId: item.id };
    const built = buildEntity('debtPayments', { date: rawData.date, accountId: rawData.accountId, notes: rawData.notes, amountCents: centsToMoneyString(item.remainingCents), ...idField, debtorId });
    if (!built.ok) return { ok: false, errors: built.errors };
    ops.push({ type: 'create', collection: PAYMENTS, data: built.data, docId: settlementPaymentId(item.id), action: 'settle' });
    if (item.source === 'debt') ops.push({ type: 'update', collection: DEBTS, docId: item.id, data: { status: 'paid' }, action: 'pay' });
  }
  ops.push({ type: 'update', collection: DEBTORS, docId: debtorId, data: { receivedCents: applied.receivedCents, status: applied.status }, action: 'receive' });
  const ids = await (io.commitAtomic ?? commitAtomic)(uid, ops, io);
  return { ok: true, month, count: items.length, totalCents, debtorPaid: applied.status === 'paid', ids };
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

  // O recebimento que QUITA a parcela tem ID determinístico: um segundo envio concorrente é negado pelas Rules.
  const ops = [{ type: 'create', collection: PAYMENTS, data, ...(debtPaid ? { docId: settlementPaymentId(debtId) } : {}) }];
  if (debtPaid) ops.push({ type: 'update', collection: DEBTS, docId: debtId, data: { status: 'paid' }, action: 'pay' });
  ops.push({
    type: 'update',
    collection: DEBTORS,
    docId: debt.debtorId,
    data: { receivedCents: applied.receivedCents, status: applied.status },
    action: 'receive',
  });

  const [id] = await (io.commitAtomic ?? commitAtomic)(uid, ops, io);
  // Antecipação (VF-2-03n): recebimento (total ou parcial) antes do vencimento da parcela.
  const anticipated = typeof debt.dueDate === 'string' && typeof data.date === 'string' && data.date < debt.dueDate;
  return { ok: true, id, debtPaid, debtorPaid: applied.status === 'paid', anticipated };
}

export function getDebtStatusOptions() {
  return DEBT_STATUSES.map((s) => ({ value: s.value, label: s.label }));
}

export { formatCents, parseMoneyToCents };
