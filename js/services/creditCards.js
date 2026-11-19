/**
 * Serviço de Cartões, Compras e Faturas (VF-2-03d). Contrato = firestore.rules.
 * - Limite usado/disponível e total de fatura aberta são DERIVADOS; `totalCents` é gravado
 *   só no fechamento e `paidCents` só no pagamento.
 * - Compra parcelada = N documentos `cardPurchases` (valor dividido em centavos inteiros, resto
 *   na 1ª), cada um ligado à fatura do seu mês. Faturas ausentes são criadas ANTES (lote próprio,
 *   `commitAtomic`, ID determinístico `${cardId}_${AAAA-MM}`) e as parcelas vão em outro lote
 *   atômico — as Rules usam exists() e não enxergam documentos do mesmo lote.
 * - Ciclo: compra após o dia de fechamento vai para a fatura seguinte; faturas não abertas
 *   são puladas. Fatura: open → closed (soma das parcelas) → paid (pagamento integral).
 * Limitações: leitura prévia + lote sem transação (compras simultâneas podem estourar o limite
 * ou regravar uma fatura recém-criada); pagar a fatura NÃO movimenta conta (o schema `invoices`
 * não tem `accountId`); sem cancelamento de fatura nem pagamento parcial.
 */
import { COLLECTIONS } from '../utils/constants.js';
import {
  list,
  getById,
  count,
  createAudited,
  updateAudited,
  removeAudited,
  commitAtomic,
} from './firestore.js';
import {
  buildEntity,
  checkCategoryForMovement,
  addMonths,
  cardLimitUsage,
  centsToMoneyString,
  invoiceDatesFor,
  clampDayInMonth,
  invoiceMonthForPurchase,
  invoiceTotalCents,
  splitInstallments,
  consolidationDeltaCents,
  parseMoneyToCents,
  formatCents,
  isValidIsoDate,
  SCHEMAS,
  CARD_STATUSES,
  INVOICE_STATUSES,
} from '../core/model.js';

const CARDS = COLLECTIONS.creditCards;
const PURCHASES = COLLECTIONS.cardPurchases;
const INVOICES = COLLECTIONS.invoices;
const PURCHASE_CATEGORY_KINDS = SCHEMAS.cardPurchases.fields.categoryId.kindCompat;

const byCard = (cardId) => ({ where: [['cardId', '==', cardId]] });

export async function listCards(uid, options = {}) {
  const constraints = { orderBy: ['createdAt', 'desc'] };
  if (options.where) constraints.where = options.where;
  return list(uid, CARDS, constraints);
}
export const getCard = (uid, cardId) => getById(uid, CARDS, cardId);
export const listCardPurchases = (uid, cardId) => list(uid, PURCHASES, byCard(cardId));
export const listInvoices = (uid, cardId) => list(uid, INVOICES, byCard(cardId));

async function usageOf(uid, card, io) {
  const fetchList = io.list ?? list;
  const [purchases, invoices] = await Promise.all([
    fetchList(uid, PURCHASES, byCard(card.id)),
    fetchList(uid, INVOICES, byCard(card.id)),
  ]);
  return { purchases, invoices, ...cardLimitUsage(card, purchases, invoices) };
}

async function checkOptionalAccount(uid, data, io) {
  if (!data.accountId) return null;
  const account = await (io.getById ?? getById)(uid, COLLECTIONS.accounts, data.accountId);
  return account ? null : { accountId: 'Conta não encontrada.' };
}

/** Cria cartão (status sempre `active`). Retorna { ok, id, errors }. */
export async function createCard(uid, rawData, io = {}) {
  const { ok, data, errors } = buildEntity('creditCards', { ...rawData, status: 'active' });
  if (!ok) return { ok: false, errors };
  const accountErrors = await checkOptionalAccount(uid, data, io);
  if (accountErrors) return { ok: false, errors: accountErrors };
  const id = await createAudited(uid, CARDS, data, io);
  return { ok: true, id };
}

/** Edita cartão não cancelado preservando status; o limite não pode ficar abaixo do usado. */
export async function updateCard(uid, cardId, rawData, io = {}) {
  const current = await (io.getById ?? getById)(uid, CARDS, cardId);
  if (!current) return { ok: false, errors: { _form: 'Cartão não encontrado.' } };
  if (current.status === 'cancelled') return { ok: false, errors: { _form: 'Cartão cancelado não pode ser editado.' } };
  const { ok, data, errors } = buildEntity('creditCards', { ...rawData, status: current.status });
  if (!ok) return { ok: false, errors };
  const accountErrors = await checkOptionalAccount(uid, data, io);
  if (accountErrors) return { ok: false, errors: accountErrors };
  const { usedCents } = await usageOf(uid, current, io);
  if (data.limitCents < usedCents) {
    return { ok: false, errors: { limitCents: `O limite não pode ser menor que o já utilizado (${formatCents(usedCents)}).` } };
  }
  await updateAudited(uid, CARDS, cardId, data, io);
  return { ok: true };
}

/** Bloqueia exclusão com compras/faturas (fail-closed); cancele para manter o histórico. */
export async function deleteCard(uid, cardId, io = {}) {
  const card = await (io.getById ?? getById)(uid, CARDS, cardId);
  if (!card) return { ok: false, errors: { _form: 'Cartão não encontrado.' } };
  let counts;
  try {
    const countFn = io.count ?? count;
    counts = await Promise.all([
      countFn(uid, PURCHASES, byCard(cardId)).then((n) => ({ n, label: 'compras' })),
      countFn(uid, INVOICES, byCard(cardId)).then((n) => ({ n, label: 'faturas' })),
      countFn(uid, COLLECTIONS.subscriptions, byCard(cardId)).then((n) => ({ n, label: 'assinaturas' })),
    ]);
  } catch (error) {
    console.error('[creditCards] falha ao verificar vínculos', error);
    return { ok: false, errors: { _form: 'Não foi possível verificar os vínculos do cartão. A exclusão foi cancelada por segurança; tente novamente.' } };
  }
  const used = counts.filter((c) => c.n > 0);
  if (used.length) {
    return { ok: false, errors: { _form: `Este cartão não pode ser excluído: possui ${used.map((c) => `${c.n} ${c.label}`).join(', ')}. Cancele-o para manter o histórico.` } };
  }
  await removeAudited(uid, CARDS, cardId, card, io);
  return { ok: true };
}

const CARD_ACTIONS = Object.freeze({ blocked: 'block', active: 'unblock', cancelled: 'cancel' });
const CARD_TRANSITIONS = Object.freeze({ active: ['blocked', 'cancelled'], blocked: ['active', 'cancelled'], cancelled: [] });

/** Bloqueia/desbloqueia/cancela (terminal; só sem limite utilizado). */
export async function setCardStatus(uid, cardId, status, io = {}) {
  if (!CARD_ACTIONS[status]) return { ok: false, errors: { _form: 'Status inválido.' } };
  const current = await (io.getById ?? getById)(uid, CARDS, cardId);
  if (!current) return { ok: false, errors: { _form: 'Cartão não encontrado.' } };
  if (!(CARD_TRANSITIONS[current.status] ?? []).includes(status)) {
    return { ok: false, errors: { _form: 'Transição de status não permitida para este cartão.' } };
  }
  if (status === 'cancelled') {
    const { usedCents } = await usageOf(uid, current, io);
    if (usedCents > 0) {
      return { ok: false, errors: { _form: `O cartão possui ${formatCents(usedCents)} em faturas não pagas; quite-as antes de cancelar.` } };
    }
  }
  await updateAudited(uid, CARDS, cardId, { status }, io, CARD_ACTIONS[status]);
  return { ok: true };
}
export const blockCard = (uid, id, io) => setCardStatus(uid, id, 'blocked', io);
export const unblockCard = (uid, id, io) => setCardStatus(uid, id, 'active', io);
export const cancelCard = (uid, id, io) => setCardStatus(uid, id, 'cancelled', io);

/** Resumo derivado do cartão: { usedCents, availableCents }. */
export async function getCardLimitUsage(uid, cardId, io = {}) {
  const card = await (io.getById ?? getById)(uid, CARDS, cardId);
  if (!card) return null;
  const { usedCents, availableCents } = await usageOf(uid, card, io);
  return { usedCents, availableCents };
}

/**
 * Lança compra (parcelada ou não) em cartão ATIVO. `rawData`: { description, amountCents (TOTAL),
 * purchaseDate, installmentsTotal (padrão 1), categoryId?, notes? }.
 * Retorna { ok, ids, invoiceMonths, errors }. Parcelas em um único lote atômico (faturas novas, em lote anterior).
 */
export async function registerCardPurchase(uid, cardId, rawData, io = {}) {
  const fetch = io.getById ?? getById;
  const card = await fetch(uid, CARDS, cardId);
  if (!card) return { ok: false, errors: { _form: 'Cartão não encontrado.' } };
  if (card.status !== 'active') return { ok: false, errors: { _form: 'Só é possível lançar compras em cartões ativos.' } };

  const total = rawData?.installmentsTotal === undefined || rawData.installmentsTotal === '' ? 1 : rawData.installmentsTotal;
  const probe = buildEntity('cardPurchases', { ...rawData, cardId, installmentsTotal: total, installmentNumber: 1 });
  if (!probe.ok) return { ok: false, errors: probe.errors };
  const n = probe.data.installmentsTotal;
  const parts = splitInstallments(probe.data.amountCents, n);
  if (!parts) return { ok: false, errors: { amountCents: 'O valor deve ser de ao menos 1 centavo por parcela.' } };

  if (probe.data.categoryId) {
    const category = await fetch(uid, COLLECTIONS.categories, probe.data.categoryId);
    const check = checkCategoryForMovement(category, PURCHASE_CATEGORY_KINDS);
    if (!check.ok) return check;
  }

  // Compra feita para um devedor (VF-2-03i): devedor em aberto; o valor soma ao emprestado dele.
  let debtor = null;
  if (probe.data.debtorId) {
    debtor = await fetch(uid, COLLECTIONS.debtors, probe.data.debtorId);
    if (!debtor) return { ok: false, errors: { debtorId: 'Devedor não encontrado.' } };
    if (debtor.status !== 'open') return { ok: false, errors: { debtorId: 'Só é possível vincular a devedor em aberto.' } };
  }

  const { invoices, availableCents } = await usageOf(uid, card, io);
  if (probe.data.amountCents > availableCents) {
    return { ok: false, errors: { amountCents: `O valor excede o limite disponível (${formatCents(availableCents)}).` } };
  }

  const byMonth = new Map(invoices.map((i) => [i.referenceMonth, i]));
  const planned = new Map();
  const invoiceOps = [];
  const purchaseOps = [];
  const base = invoiceMonthForPurchase(card, probe.data.purchaseDate);
  let previous = null;
  for (let number = 1; number <= n; number += 1) {
    let month = addMonths(base, number - 1);
    if (previous && month <= previous) month = addMonths(previous, 1);
    while (byMonth.has(month) && byMonth.get(month).status !== 'open') month = addMonths(month, 1);
    previous = month;
    const invoiceId = byMonth.get(month)?.id ?? `${cardId}_${month}`;
    if (!byMonth.has(month) && !planned.has(month)) {
      planned.set(month, invoiceId);
      invoiceOps.push({
        type: 'create', collection: INVOICES, docId: invoiceId,
        data: { cardId, referenceMonth: month, ...invoiceDatesFor(card, month), status: 'open' },
      });
    }
    const part = buildEntity('cardPurchases', {
      ...rawData, cardId, installmentsTotal: n, installmentNumber: number, invoiceId,
      amountCents: centsToMoneyString(parts[number - 1]),
    });
    if (!part.ok) return { ok: false, errors: part.errors };
    purchaseOps.push({ type: 'create', collection: PURCHASES, data: part.data });
  }

  // As Rules validam `invoiceId` com exists() (estado ANTERIOR ao lote): uma parcela não pode
  // referenciar fatura criada no mesmo lote. Por isso são dois lotes: 1) faturas novas, 2) parcelas
  // (todas atômicas entre si). Falha no 2º deixa faturas abertas vazias, reaproveitadas depois.
  const commit = io.commitAtomic ?? commitAtomic;
  if (invoiceOps.length) await commit(uid, invoiceOps, io);
  // `io.extraOps` (ex.: avançar a próxima cobrança da assinatura) entra no MESMO lote das parcelas.
  if (io.extraOps?.length) purchaseOps.push(...io.extraOps);
  // O devedor é atualizado no MESMO lote das parcelas (atômico): lentCents += total da compra.
  if (debtor) {
    purchaseOps.push({
      type: 'update', collection: COLLECTIONS.debtors, docId: probe.data.debtorId, action: 'card-purchase',
      data: { lentCents: (Number(debtor.lentCents) || 0) + probe.data.amountCents },
    });
  }
  const ids = await commit(uid, purchaseOps, io);
  return { ok: true, ids, invoiceMonths: [...new Set(purchaseOps.filter((o) => o.collection === PURCHASES).map((o) => o.data.invoiceId))] };
}

/** Exclui parcela de compra só se a fatura estiver aberta (ou sem fatura). */
export async function deleteCardPurchase(uid, purchaseId, io = {}) {
  const fetch = io.getById ?? getById;
  const purchase = await fetch(uid, PURCHASES, purchaseId);
  if (!purchase) return { ok: false, errors: { _form: 'Compra não encontrada.' } };
  if (purchase.debtorId) {
    // Excluir exigiria estornar o emprestado do devedor (possivelmente já recebido): bloqueado.
    return { ok: false, errors: { _form: 'Esta compra está vinculada a um devedor e não pode ser excluída.' } };
  }
  if (purchase.invoiceId) {
    const invoice = await fetch(uid, INVOICES, purchase.invoiceId);
    if (invoice && invoice.status !== 'open') {
      return { ok: false, errors: { _form: 'A fatura desta compra já está fechada ou paga.' } };
    }
  }
  await removeAudited(uid, PURCHASES, purchaseId, purchase, io);
  return { ok: true };
}

const todayIso = (io) => (io.now ? io.now() : new Date()).toISOString().slice(0, 10);

/**
 * Fecha a fatura: só a partir do dia de fechamento; grava `totalCents` (soma das parcelas
 * vinculadas) e status `closed`; auditoria `close`. Retorna { ok, totalCents, errors }.
 */
export async function closeInvoice(uid, invoiceId, io = {}) {
  const invoice = await (io.getById ?? getById)(uid, INVOICES, invoiceId);
  if (!invoice) return { ok: false, errors: { _form: 'Fatura não encontrada.' } };
  if (invoice.status !== 'open') return { ok: false, errors: { _form: 'Só é possível fechar faturas abertas.' } };
  if (invoice.closingDate && todayIso(io) < invoice.closingDate) {
    return { ok: false, errors: { _form: 'A fatura só pode ser fechada a partir da data de fechamento.' } };
  }
  const purchases = await (io.list ?? list)(uid, PURCHASES, { where: [['invoiceId', '==', invoiceId]] });
  const totalCents = invoiceTotalCents(purchases);
  await updateAudited(uid, INVOICES, invoiceId, { status: 'closed', totalCents }, io, 'close');
  return { ok: true, totalCents };
}

/**
 * Lançamento CONSOLIDADO de fatura (VF-2-03r): uma única parcela (1x) que representa gastos do mês sem cadastrar
 * compra a compra. `rawData`: { referenceMonth "YYYY-MM", amountCents (string pt-BR), description? }.
 * Cai na fatura de `referenceMonth` (data = dia de fechamento daquele mês). A fatura precisa estar ABERTA ou ainda
 * não existir: fechada/paga/cancelada NÃO é alterada (o valor liquidado fica intacto). Respeita o limite do cartão.
 * Compras de devedores e assinaturas continuam lançadas à parte (rastreáveis); o consolidado cobre só o restante
 * (ver `consolidationDeltaCents`). Retorna o mesmo formato de `registerCardPurchase`.
 */
export async function registerInvoiceConsolidation(uid, cardId, rawData = {}, io = {}) {
  const fetch = io.getById ?? getById;
  const card = await fetch(uid, CARDS, cardId);
  if (!card) return { ok: false, errors: { _form: 'Cartão não encontrado.' } };
  const month = String(rawData.referenceMonth ?? '');
  const purchaseDate = clampDayInMonth(month, Number(card.closingDay));
  if (!purchaseDate) return { ok: false, errors: { referenceMonth: 'Mês inválido (use AAAA-MM).' } };
  const invoices = await (io.list ?? list)(uid, INVOICES, byCard(cardId));
  const existing = invoices.find((i) => i.referenceMonth === month);
  if (existing && existing.status !== 'open') {
    return { ok: false, errors: { referenceMonth: `A fatura de ${month.slice(5)}/${month.slice(0, 4)} já está ${existing.status === 'paid' ? 'paga' : existing.status === 'closed' ? 'fechada' : 'cancelada'} e não é alterada.` } };
  }
  const description = String(rawData.description ?? '').trim() || `Consolidado da fatura ${month.slice(5)}/${month.slice(0, 4)}`;
  return registerCardPurchase(uid, cardId, {
    description, amountCents: rawData.amountCents, purchaseDate, installmentsTotal: 1, notes: 'Lançamento consolidado da fatura',
  }, io);
}

/**
 * Paga a fatura (`closed` ou `open` → `paid`) debitando uma conta bancária (VF-2-03p). `rawData`: { accountId, date? }.
 * Grava `paidCents = totalCents`, `accountId` e `paidAt`; se estava aberta, fecha junto (`totalCents` = soma das
 * parcelas). O saldo da conta continua DERIVADO (`accountBalances` subtrai faturas pagas) e o limite do cartão
 * é liberado (`cardLimitUsage` ignora faturas pagas). Fatura zerada não é paga: cancele-a.
 * Retorna { ok, paidCents, errors }.
 */
export async function payInvoice(uid, invoiceId, rawData = {}, io = {}) {
  const fetch = io.getById ?? getById;
  const invoice = await fetch(uid, INVOICES, invoiceId);
  if (!invoice) return { ok: false, errors: { _form: 'Fatura não encontrada.' } };
  if (!['open', 'closed'].includes(invoice.status)) return { ok: false, errors: { _form: 'Só é possível pagar faturas abertas ou fechadas.' } };
  const date = rawData.date ? String(rawData.date) : todayIso(io);
  if (!isValidIsoDate(date)) return { ok: false, errors: { date: 'Data inválida (use AAAA-MM-DD).' } };
  if (!rawData.accountId) return { ok: false, errors: { accountId: 'Selecione a conta que pagou a fatura.' } };
  const account = await fetch(uid, COLLECTIONS.accounts, String(rawData.accountId));
  if (!account) return { ok: false, errors: { accountId: 'Conta não encontrada.' } };
  if (account.status !== 'active') return { ok: false, errors: { accountId: 'A conta precisa estar ativa.' } };

  let totalCents = Number(invoice.totalCents) || 0;
  if (invoice.status === 'open') {
    const purchases = await (io.list ?? list)(uid, PURCHASES, { where: [['invoiceId', '==', invoiceId]] });
    totalCents = invoiceTotalCents(purchases);
  }
  if (totalCents <= 0) return { ok: false, errors: { _form: 'Fatura zerada: não há o que pagar. Cancele a fatura.' } };
  await updateAudited(uid, INVOICES, invoiceId, {
    status: 'paid', totalCents, paidCents: totalCents, accountId: account.id ?? rawData.accountId, paidAt: date,
  }, io, 'pay');
  return { ok: true, paidCents: totalCents };
}

/**
 * Cancela fatura ABERTA sem compras vinculadas (ex.: fatura R$ 0,00 remanescente de compra que falhou).
 * Com compras, bloqueia (exclua as compras ou pague). Leitura fail-closed. Retorna { ok, errors }.
 */
export async function cancelInvoice(uid, invoiceId, io = {}) {
  const invoice = await (io.getById ?? getById)(uid, INVOICES, invoiceId);
  if (!invoice) return { ok: false, errors: { _form: 'Fatura não encontrada.' } };
  if (invoice.status !== 'open') return { ok: false, errors: { _form: 'Só é possível cancelar faturas abertas.' } };
  let linked;
  try {
    linked = await (io.count ?? count)(uid, PURCHASES, { where: [['invoiceId', '==', invoiceId]] });
  } catch (error) {
    console.error('[creditCards] falha ao verificar compras da fatura', error);
    return { ok: false, errors: { _form: 'Não foi possível verificar as compras da fatura. O cancelamento foi interrompido por segurança.' } };
  }
  if (linked > 0) return { ok: false, errors: { _form: `A fatura possui ${linked} parcela(s) de compras e não pode ser cancelada.` } };
  await updateAudited(uid, INVOICES, invoiceId, { status: 'cancelled' }, io, 'cancel');
  return { ok: true };
}

export const getCardStatusOptions = () => CARD_STATUSES.map((s) => ({ value: s.value, label: s.label }));
export const getInvoiceStatusOptions = () => INVOICE_STATUSES.map((s) => ({ value: s.value, label: s.label }));

export { consolidationDeltaCents, cardLimitUsage, invoiceTotalCents, formatCents, parseMoneyToCents };
