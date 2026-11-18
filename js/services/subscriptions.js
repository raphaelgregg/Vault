/**
 * Serviço de Assinaturas (VF-2-03a): CRUD + validação do modelo + auditoria.
 * Isolamento por usuário via users/{uid}/subscriptions. Contrato = firestore.rules.
 */
import { COLLECTIONS } from '../utils/constants.js';
import {
  list,
  getById,
  createAudited,
  updateAudited,
  removeAudited,
} from './firestore.js';
import {
  buildEntity,
  checkCategoryForMovement,
  SCHEMAS,
  SUBSCRIPTION_PERIODICITIES,
  SUBSCRIPTION_STATUSES,
  summarizeSubscriptions,
  formatCents,
  parseMoneyToCents,
} from '../core/model.js';

const COLLECTION = COLLECTIONS.subscriptions;
const CATEGORY_COLLECTION = COLLECTIONS.categories;
const ALLOWED_CATEGORY_KINDS = SCHEMAS.subscriptions.fields.categoryId.kindCompat;

/** Ação de auditoria por status de destino. */
const STATUS_ACTIONS = Object.freeze({ active: 'resume', paused: 'pause', cancelled: 'cancel' });

/** Cancelada é terminal; ativa ⇄ pausada; mesmo status é rejeitado. */
const STATUS_TRANSITIONS = Object.freeze({
  active: ['paused', 'cancelled'],
  paused: ['active', 'cancelled'],
  cancelled: [],
});

async function fetchCategory(uid, categoryId) {
  return getById(uid, CATEGORY_COLLECTION, categoryId);
}

/** Lista assinaturas por próxima cobrança. */
export async function listSubscriptions(uid, options = {}) {
  const constraints = { orderBy: ['nextChargeDate', 'asc'] };
  if (options.where) constraints.where = options.where;
  if (options.limit) constraints.limit = options.limit;
  return list(uid, COLLECTION, constraints);
}

export async function getSubscription(uid, subscriptionId) {
  return getById(uid, COLLECTION, subscriptionId);
}

/** Modelo → categoria real no Firestore → compatibilidade de tipo. */
async function validate(uid, rawData, deps) {
  const { ok, data, errors } = buildEntity('subscriptions', rawData);
  if (!ok) return { ok: false, errors };
  const category = await (deps.lookupCategory ?? fetchCategory)(uid, data.categoryId);
  const categoryCheck = checkCategoryForMovement(category, ALLOWED_CATEGORY_KINDS);
  if (!categoryCheck.ok) return categoryCheck;
  return { ok: true, data };
}

/** Retorna { ok, id, errors }. `deps` (lookupCategory, create, writeAudit) é injetável. */
export async function createSubscription(uid, rawData, deps = {}) {
  const checked = await validate(uid, rawData, deps);
  if (!checked.ok) return checked;
  const id = await createAudited(uid, COLLECTION, checked.data, deps);
  return { ok: true, id };
}

/** Retorna { ok, errors }. */
export async function updateSubscription(uid, subscriptionId, rawData, deps = {}) {
  const checked = await validate(uid, rawData, deps);
  if (!checked.ok) return checked;
  await updateAudited(uid, COLLECTION, subscriptionId, checked.data, deps);
  return { ok: true };
}

export async function deleteSubscription(uid, subscriptionId, io = {}) {
  const subscription = await (io.getById ?? getById)(uid, COLLECTION, subscriptionId);
  if (!subscription) return { ok: false, errors: { _form: 'Assinatura não encontrada.' } };
  await removeAudited(uid, COLLECTION, subscriptionId, subscription, io);
  return { ok: true };
}

/**
 * Pausa, retoma ou cancela. Lê o estado atual e valida a transição (fail-closed:
 * sem update nem auditoria quando rejeitada). Leitura+escrita não atômica.
 */
export async function setSubscriptionStatus(uid, subscriptionId, status, io = {}) {
  if (!STATUS_ACTIONS[status]) return { ok: false, errors: { _form: 'Status inválido.' } };
  const current = await (io.getById ?? getById)(uid, COLLECTION, subscriptionId);
  if (!current) return { ok: false, errors: { _form: 'Assinatura não encontrada.' } };
  if (!(STATUS_TRANSITIONS[current.status] ?? []).includes(status)) {
    return { ok: false, errors: { _form: 'Transição de status não permitida para esta assinatura.' } };
  }
  await updateAudited(uid, COLLECTION, subscriptionId, { status }, io, STATUS_ACTIONS[status]);
  return { ok: true };
}

export const pauseSubscription = (uid, id, io) => setSubscriptionStatus(uid, id, 'paused', io);
export const resumeSubscription = (uid, id, io) => setSubscriptionStatus(uid, id, 'active', io);
export const cancelSubscription = (uid, id, io) => setSubscriptionStatus(uid, id, 'cancelled', io);

export function getPeriodicityOptions() {
  return SUBSCRIPTION_PERIODICITIES.map((p) => ({ value: p.value, label: p.label }));
}

export function getSubscriptionStatusOptions() {
  return SUBSCRIPTION_STATUSES.map((s) => ({ value: s.value, label: s.label }));
}

export { summarizeSubscriptions, formatCents, parseMoneyToCents };
