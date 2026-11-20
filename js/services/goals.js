/**
 * Serviço de Metas e movimentações (VF-2-03c). Contrato = firestore.rules.
 * O valor guardado é DERIVADO (aportes − resgates), nunca gravado. Aporte/resgate é
 * ATÔMICO (`commitAtomic`): movimentação + status da meta (concluída ao atingir o alvo,
 * reativada ao resgatar abaixo dele) + auditorias no mesmo lote.
 * `completed` só nasce de aportes. Limitações: leitura prévia + lote sem transação
 * (janela de concorrência); movimentações são imutáveis (sem estorno).
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
import { financeResult } from './financeApi.js';
import {
  buildEntity,
  isAccountLinkedGoal,
  allocateLinkedGoalBalances,
  goalSavedCents,
  goalProgressPercent,
  centsToMoneyString,
  GOAL_STATUSES,
  GOAL_TRANSACTION_TYPES,
  formatCents,
  parseMoneyToCents,
} from '../core/model.js';

const GOALS = COLLECTIONS.goals;
const TXS = COLLECTIONS.goalTransactions;

export async function listGoals(uid, options = {}) {
  const constraints = { orderBy: ['createdAt', 'desc'] };
  if (options.where) constraints.where = options.where;
  if (options.limit) constraints.limit = options.limit;
  return list(uid, GOALS, constraints);
}

export async function getGoal(uid, goalId) {
  return getById(uid, GOALS, goalId);
}

/** Movimentações da meta (cruas) e estornos delas (VF-ARQ-02: estorno = lançamento compensatório, o original é preservado). */
async function loadGoalLedger(uid, goalId, io = {}) {
  const listFn = io.list ?? list;
  const where = { where: [['goalId', '==', goalId]] };
  const [transactions, reversals] = await Promise.all([listFn(uid, TXS, where), listFn(uid, COLLECTIONS.reversals, where)]);
  return { transactions: transactions ?? [], reversals: reversals ?? [] };
}

/** Guardado líquido (aportes − resgates, ignorando movimentos estornados). */
async function savedOf(uid, goalId, io = {}) {
  const { transactions, reversals } = await loadGoalLedger(uid, goalId, io);
  return goalSavedCents(transactions, reversals);
}

/** Movimentações da meta; as estornadas voltam com `reversed: true` (preservadas no histórico, fora do guardado). */
export async function listGoalTransactions(uid, goalId, io = {}) {
  const { transactions, reversals } = await loadGoalLedger(uid, goalId, io);
  const reversed = new Set(reversals.filter((r) => r.targetCollection === 'goalTransactions').map((r) => r.targetId));
  return transactions.map((t) => (reversed.has(t.id) ? { ...t, reversed: true } : t));
}

/** Aportes/resgates mais recentes de todas as metas (histórico exibido em Transferências). */
export async function listRecentGoalTransactions(uid, limit = 20, io = {}) {
  return (io.list ?? list)(uid, TXS, { orderBy: ['date', 'desc'], limit });
}

/**
 * Metas que podem receber/devolver dinheiro por transferência: ativas e NÃO vinculadas a conta (as vinculadas
 * seguem o saldo da conta; para alimentá-las transfira para a conta). Puro. `txCounts`: Map(goalId → nº de movimentações).
 */
export function transferableGoals(goals = [], txCounts = new Map()) {
  return goals.filter((g) => g.status === 'active' && !isAccountLinkedGoal(g, txCounts.get(g.id)));
}

/** Valida a conta opcional da meta (precisa existir). */
async function checkOptionalAccount(uid, data, io) {
  if (!data.accountId) return null;
  const account = await (io.getById ?? getById)(uid, COLLECTIONS.accounts, data.accountId);
  return account ? null : { accountId: 'Conta não encontrada.' };
}

/** Cria meta (status sempre `active`). Retorna { ok, id, errors }. */
export async function createGoal(uid, rawData, io = {}) {
  const { ok, data, errors } = buildEntity('goals', { ...rawData, status: 'active' });
  if (!ok) return { ok: false, errors };
  const accountErrors = await checkOptionalAccount(uid, data, io);
  if (accountErrors) return { ok: false, errors: accountErrors };
  const id = await createAudited(uid, GOALS, data, io);
  return { ok: true, id };
}

/**
 * Edita nome, descrição, alvo, prazo e conta de meta ATIVA; preserva o status.
 * Alvo menor ou igual ao guardado é rejeitado (concluir é via aporte).
 */
export async function updateGoal(uid, goalId, rawData, io = {}) {
  const fetch = io.getById ?? getById;
  const current = await fetch(uid, GOALS, goalId);
  if (!current) return { ok: false, errors: { _form: 'Meta não encontrada.' } };
  if (current.status !== 'active') return { ok: false, errors: { _form: 'Só é possível editar metas ativas.' } };
  const { ok, data, errors } = buildEntity('goals', { ...rawData, status: current.status });
  if (!ok) return { ok: false, errors };
  const accountErrors = await checkOptionalAccount(uid, data, io);
  if (accountErrors) return { ok: false, errors: accountErrors };
  const saved = await savedOf(uid, goalId, io);
  if (data.targetCents <= saved) {
    return { ok: false, errors: { targetCents: `O alvo deve ser maior que o já guardado (${formatCents(saved)}).` } };
  }
  await updateAudited(uid, GOALS, goalId, data, io);
  return { ok: true };
}

/** Bloqueia exclusão com movimentações (fail-closed); cancele para manter o histórico. */
export async function deleteGoal(uid, goalId, io = {}) {
  const goal = await (io.getById ?? getById)(uid, GOALS, goalId);
  if (!goal) return { ok: false, errors: { _form: 'Meta não encontrada.' } };
  let linked;
  try {
    linked = await (io.count ?? count)(uid, TXS, { where: [['goalId', '==', goalId]] });
  } catch (error) {
    console.error('[goals] falha ao verificar movimentações', error);
    return { ok: false, errors: { _form: 'Não foi possível verificar as movimentações da meta. A exclusão foi cancelada por segurança; tente novamente.' } };
  }
  if (linked > 0) {
    return { ok: false, errors: { _form: `Esta meta não pode ser excluída: possui ${linked} movimentações. Cancele-a para manter o histórico.` } };
  }
  await removeAudited(uid, GOALS, goalId, goal, io);
  return { ok: true };
}

const STATUS_ACTIONS = Object.freeze({ cancelled: 'cancel', active: 'reopen' });
// `completed` é reservado a aportes; cancelar só meta ativa; reabrir só cancelada.
const STATUS_TRANSITIONS = Object.freeze({ active: ['cancelled'], cancelled: ['active'], completed: [] });

/** Cancela (active→cancelled) ou reabre (cancelled→active), com leitura prévia, fail-closed. */
export async function setGoalStatus(uid, goalId, status, io = {}) {
  if (!STATUS_ACTIONS[status]) return { ok: false, errors: { _form: 'Status inválido.' } };
  const current = await (io.getById ?? getById)(uid, GOALS, goalId);
  if (!current) return { ok: false, errors: { _form: 'Meta não encontrada.' } };
  if (!(STATUS_TRANSITIONS[current.status] ?? []).includes(status)) {
    return { ok: false, errors: { _form: 'Transição de status não permitida para esta meta.' } };
  }
  if (status === 'active') {
    // Reabrir com alvo já coberto deixaria a meta ativa e "cheia" até o próximo aporte.
    const saved = await savedOf(uid, goalId, io);
    if (saved >= current.targetCents) {
      return { ok: false, errors: { _form: 'O valor guardado já atinge o alvo; resgate ou aumente o alvo antes de reabrir.' } };
    }
  }
  await updateAudited(uid, GOALS, goalId, { status }, io, STATUS_ACTIONS[status]);
  return { ok: true };
}
export const cancelGoal = (uid, id, io) => setGoalStatus(uid, id, 'cancelled', io);
export const reopenGoal = (uid, id, io) => setGoalStatus(uid, id, 'active', io);

/**
 * Registra aporte (`deposit`) ou resgate (`withdraw`). `rawData`: { amountCents, date, accountId, notes? }.
 * Retorna { ok, id, status, savedCents, errors }. `io`: getById, list, commitAtomic injetáveis.
 */
export async function registerGoalTransaction(uid, goalId, type, rawInput, io = {}) {
  const { operationId, ...rawData } = rawInput ?? {};
  const { ok, data, errors } = buildEntity('goalTransactions', { ...rawData, goalId, type });
  if (!ok) return { ok: false, errors };
  // VF-ARQ-02: aporte/resgate NASCEM no servidor (meta, conta ativa, saldo, vínculo e idempotência dentro da transação).
  const r = await (io.finance ?? financeResult)(`goal.${type}`, {
    goalId, amountCents: data.amountCents, date: data.date, accountId: data.accountId, ...(data.notes ? { notes: data.notes } : {}),
  }, { operationId, ...(io.apiOptions ?? {}) });
  if (r.ok) return { ok: true, id: r.transactionId, status: r.goalStatus, savedCents: r.savedCents, result: r };
  // erros da conta (saldo, inativa, inexistente) aparecem junto do campo de conta
  return ['INSUFFICIENT_BALANCE', 'ACCOUNT_NOT_ACTIVE', 'ACCOUNT_NOT_FOUND'].includes(r.code) && r.errors?._form ? { ...r, errors: { ...r.errors, accountId: r.errors._form } } : r;
}

export const depositToGoal = (uid, goalId, raw, io) => registerGoalTransaction(uid, goalId, 'deposit', raw, io);
export const withdrawFromGoal = (uid, goalId, raw, io) => registerGoalTransaction(uid, goalId, 'withdraw', raw, io);

export function getGoalStatusOptions() {
  return GOAL_STATUSES.map((s) => ({ value: s.value, label: s.label }));
}
export function getGoalTransactionTypeOptions() {
  return GOAL_TRANSACTION_TYPES.map((t) => ({ value: t.value, label: t.label }));
}

export { allocateLinkedGoalBalances, isAccountLinkedGoal, goalSavedCents, goalProgressPercent, centsToMoneyString, formatCents, parseMoneyToCents };
