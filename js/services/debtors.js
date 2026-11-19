/**
 * Serviço de Devedores (VF-2-03b): CRUD + validação do modelo + auditoria.
 * Isolamento por usuário via users/{uid}/debtors. Contrato = firestore.rules.
 *
 * `receivedCents` e `status: paid` são reservados aos recebimentos (debtPayments,
 * VF-2-03b2): aqui o valor nasce 0 e é preservado em toda edição.
 */
import { COLLECTIONS } from '../utils/constants.js';
import {
  list,
  getById,
  count,
  createAudited,
  updateAudited,
  removeAudited,
} from './firestore.js';
import {
  buildEntity,
  centsToMoneyString,
  DEBTOR_STATUSES,
  debtorPendingCents,
  debtorOverview,
  debtorMonthStatement,
  summarizeDebtors,
  formatCents,
  parseMoneyToCents,
} from '../core/model.js';

const COLLECTION = COLLECTIONS.debtors;

/** Coleções que referenciam debtors/{id} pelo campo debtorId (espelha as Rules). */
export const DEBTOR_LINK_QUERIES = Object.freeze([
  { collection: COLLECTIONS.debts, field: 'debtorId', label: 'dívidas (parcelas)' },
  { collection: COLLECTIONS.debtPayments, field: 'debtorId', label: 'recebimentos' },
  { collection: COLLECTIONS.cardPurchases, field: 'debtorId', label: 'compras no cartão' },
]);

/** Cancelar e reabrir apenas; `paid` só nasce de recebimentos. */
const STATUS_ACTIONS = Object.freeze({ cancelled: 'cancel', open: 'reopen' });
const STATUS_TRANSITIONS = Object.freeze({
  open: ['cancelled'],
  cancelled: ['open'],
  paid: [],
});

export async function listDebtors(uid, options = {}) {
  const constraints = { orderBy: ['loanDate', 'desc'] };
  if (options.where) constraints.where = options.where;
  if (options.limit) constraints.limit = options.limit;
  return list(uid, COLLECTION, constraints);
}

export async function getDebtor(uid, debtorId) {
  return getById(uid, COLLECTION, debtorId);
}

/** Visão consolidada por origem (empréstimo × cartão) com as compras vinculadas (VF-2-03i). */
export async function getDebtorOverview(uid, debtor, io = {}) {
  const purchases = await (io.list ?? list)(uid, COLLECTIONS.cardPurchases, { where: [['debtorId', '==', debtor.id]] });
  purchases.sort((a, b) => (a.purchaseDate < b.purchaseDate ? 1 : -1));
  return { ...debtorOverview(debtor, purchases), cardPurchases: purchases };
}

/** Retorna { ok, id, errors }. `deps` (create, writeAudit) é injetável. */
export async function createDebtor(uid, rawData, deps = {}) {
  // Valor emprestado vazio = 0: o devedor existe sem empréstimo inicial (VF-2-03l).
  const blank = rawData?.lentCents === undefined || rawData.lentCents === null || String(rawData.lentCents).trim() === '';
  const { ok, data, errors } = buildEntity('debtors', {
    ...rawData,
    lentCents: blank ? '0' : rawData.lentCents,
    receivedCents: 0,
    status: 'open',
  });
  if (!ok) return { ok: false, errors };
  const id = await createAudited(uid, COLLECTION, data, deps);
  return { ok: true, id };
}

/**
 * Edita nome, data, valor emprestado e observações. Lê o estado atual: preserva
 * receivedCents/status e rejeita lentCents < receivedCents (Rule) e devedor cancelado/quitado.
 */
export async function updateDebtor(uid, debtorId, rawData, deps = {}) {
  const current = await (deps.getById ?? getById)(uid, COLLECTION, debtorId);
  if (!current) return { ok: false, errors: { _form: 'Devedor não encontrado.' } };
  if (current.status !== 'open') {
    return { ok: false, errors: { _form: 'Só é possível editar devedores em aberto.' } };
  }
  const blankLent = rawData?.lentCents === undefined || rawData.lentCents === null || String(rawData.lentCents).trim() === '';
  const { ok, data, errors } = buildEntity('debtors', {
    ...rawData,
    lentCents: blankLent ? '0' : rawData.lentCents,
    // parseMoneyToCents lê número como reais: reenviar o valor em string.
    receivedCents: centsToMoneyString(current.receivedCents ?? 0),
    status: current.status,
  });
  if (!ok) {
    if (errors.receivedCents) {
      errors.lentCents = 'O valor emprestado não pode ser menor que o já recebido.';
      delete errors.receivedCents;
    }
    return { ok: false, errors };
  }
  await updateAudited(uid, COLLECTION, debtorId, data, deps);
  return { ok: true };
}

/**
 * Bloqueia exclusão com dívidas/recebimentos vinculados (fail-closed; sem backend
 * a checagem é client-side, com janela de concorrência — mesmo padrão de deleteAccount).
 */
export async function deleteDebtor(uid, debtorId, io = {}) {
  const { getById: getFn = getById, count: countFn = count } = io;
  const debtor = await getFn(uid, COLLECTION, debtorId);
  if (!debtor) return { ok: false, errors: { _form: 'Devedor não encontrado.' } };

  let linked;
  try {
    linked = await Promise.all(
      DEBTOR_LINK_QUERIES.map(async (q) => ({
        label: q.label,
        count: await countFn(uid, q.collection, { where: [[q.field, '==', debtorId]] }),
      }))
    );
  } catch (error) {
    console.error('[debtors] falha ao verificar vínculos', error);
    return {
      ok: false,
      errors: { _form: 'Não foi possível verificar os vínculos do devedor. A exclusão foi cancelada por segurança; tente novamente.' },
    };
  }
  const used = linked.filter((l) => l.count > 0);
  if (used.length) {
    const detail = used.map((l) => `${l.count} ${l.label}`).join(', ');
    return { ok: false, errors: { _form: `Este devedor não pode ser excluído: possui ${detail}. Cancele-o para manter o histórico.` } };
  }
  await removeAudited(uid, COLLECTION, debtorId, debtor, io);
  return { ok: true };
}

/** Cancela (open→cancelled) ou reabre (cancelled→open) com leitura prévia, fail-closed. */
export async function setDebtorStatus(uid, debtorId, status, io = {}) {
  if (!STATUS_ACTIONS[status]) return { ok: false, errors: { _form: 'Status inválido.' } };
  const current = await (io.getById ?? getById)(uid, COLLECTION, debtorId);
  if (!current) return { ok: false, errors: { _form: 'Devedor não encontrado.' } };
  if (!(STATUS_TRANSITIONS[current.status] ?? []).includes(status)) {
    return { ok: false, errors: { _form: 'Transição de status não permitida para este devedor.' } };
  }
  await updateAudited(uid, COLLECTION, debtorId, { status }, io, STATUS_ACTIONS[status]);
  return { ok: true };
}

export const cancelDebtor = (uid, id, io) => setDebtorStatus(uid, id, 'cancelled', io);
export const reopenDebtor = (uid, id, io) => setDebtorStatus(uid, id, 'open', io);

export function getDebtorStatusOptions() {
  return DEBTOR_STATUSES.map((s) => ({ value: s.value, label: s.label }));
}

export { summarizeDebtors, debtorPendingCents, formatCents, parseMoneyToCents };

// ---------------------------------------------------------------------------
// Fechamento do mês por devedor (VF-2-03j)
// ---------------------------------------------------------------------------

const IN_CHUNK = 30; // limite do operador `in` do Firestore

const chunk = (items) => {
  const out = [];
  for (let i = 0; i < items.length; i += IN_CHUNK) out.push(items.slice(i, i + IN_CHUNK));
  return out;
};

/**
 * Carrega e calcula o fechamento de `month` para os devedores em aberto. Leituras: por lote de 30 devedores,
 * 3 consultas (`cardPurchases`, `debts`, `debtPayments` por `debtorId in`) + faturas dos cartões envolvidos.
 * Retorna Map(debtorId → { ...debtorMonthStatement, purchases, invoicesById }). `io.list` é injetável;
 * `io.includeAll` inclui devedores não abertos (detalhamento; o total do mês deles é 0). Falha propaga (a UI isola e mostra aviso).
 */
export async function loadDebtorStatements(uid, debtors, month, io = {}) {
  const fetchList = io.list ?? list;
  const targets = io.includeAll ? debtors : debtors.filter((d) => d.status === 'open');
  const result = new Map();
  if (!targets.length) return result;
  const ids = targets.map((d) => d.id);
  const byIn = (collection, field, values) => Promise.all(
    chunk(values).map((part) => fetchList(uid, collection, { where: [[field, 'in', part]] })),
  ).then((pages) => pages.flat());

  const [purchases, debts, payments] = await Promise.all([
    byIn(COLLECTIONS.cardPurchases, 'debtorId', ids),
    byIn(COLLECTIONS.debts, 'debtorId', ids),
    byIn(COLLECTIONS.debtPayments, 'debtorId', ids),
  ]);
  const cardIds = [...new Set(purchases.map((p) => p.cardId).filter(Boolean))];
  const invoices = cardIds.length ? await byIn(COLLECTIONS.invoices, 'cardId', cardIds) : [];
  const invoicesById = new Map(invoices.map((i) => [i.id, i]));
  const receivedByDebt = new Map();
  for (const p of payments) receivedByDebt.set(p.debtId, (receivedByDebt.get(p.debtId) ?? 0) + (Number(p.amountCents) || 0));

  for (const debtor of targets) {
    const own = purchases.filter((p) => p.debtorId === debtor.id);
    const statement = debtorMonthStatement({
      debtor, month, purchases: own, invoicesById, debts: debts.filter((d) => d.debtorId === debtor.id), receivedByDebt,
    });
    result.set(debtor.id, { ...statement, purchases: own, invoicesById });
  }
  return result;
}

/** Fechamento de um único devedor (usado no detalhamento). */
export async function getDebtorStatement(uid, debtor, month, io = {}) {
  const map = await loadDebtorStatements(uid, [debtor], month, { ...io, includeAll: true });
  return map.get(debtor.id) ?? debtorMonthStatement({ debtor, month });
}
