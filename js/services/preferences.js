/**
 * Serviço de preferências do usuário — perfil (`profile/main`) e configurações
 * (`settings/main`), documentos únicos com schema fechado nas Rules.
 *
 * Regras espelhadas das Rules (firestore.rules, blocos profile/settings):
 *  - profile: name 1–80, email 1–160, currency 'BRL', locale 'pt-BR'.
 *  - settings: theme ∈ light|dark|system, hideValues bool, firstWeekday int 0–6.
 *  - createdAt só na criação (imutável depois); updatedAt = request.time.
 *
 * `io` permite injetar dependências nos testes (padrão: services/firestore.js).
 * Leitura+escrita não é atômica; como cada documento pertence a um único usuário,
 * a janela de concorrência é aceitável.
 */
import { COLLECTIONS, PROFILE_DOC_ID, SETTINGS_DOC_ID } from '../utils/constants.js';
import { getSingleton, saveSingleton, writeAudit, serverTimestamp } from './firestore.js';

export const THEMES = Object.freeze(['light', 'dark', 'system']);
export const PROFILE_NAME_MAX = 80;
export const PROFILE_EMAIL_MAX = 160;

const DEFAULT_THEME = 'system';

/**
 * Valida um patch de configurações. Só campos presentes são validados/retornados;
 * campos desconhecidos são ignorados (schema fechado nas Rules). Puro.
 */
export function validateSettings(raw = {}) {
  const data = {};
  const errors = {};

  if (raw.theme !== undefined) {
    if (THEMES.includes(raw.theme)) data.theme = raw.theme;
    else errors.theme = 'Tema inválido.';
  }
  if (raw.hideValues !== undefined) {
    if (typeof raw.hideValues === 'boolean') data.hideValues = raw.hideValues;
    else errors.hideValues = 'Valor inválido.';
  }
  if (raw.firstWeekday !== undefined) {
    const day = raw.firstWeekday;
    if (Number.isInteger(day) && day >= 0 && day <= 6) data.firstWeekday = day;
    else errors.firstWeekday = 'Dia da semana deve estar entre 0 e 6.';
  }
  return { ok: Object.keys(errors).length === 0, data, errors };
}

/** Valida um patch de perfil (currency/locale são fixos nas Rules). Puro. */
export function validateProfile(raw = {}) {
  const data = {};
  const errors = {};

  if (raw.name !== undefined) {
    const name = typeof raw.name === 'string' ? raw.name.trim() : '';
    if (!name) errors.name = 'Informe o nome.';
    else if (name.length > PROFILE_NAME_MAX) errors.name = `Máximo de ${PROFILE_NAME_MAX} caracteres.`;
    else data.name = name;
  }
  if (raw.email !== undefined) {
    const email = typeof raw.email === 'string' ? raw.email.trim() : '';
    if (!email) errors.email = 'E-mail ausente.';
    else if (email.length > PROFILE_EMAIL_MAX) errors.email = `Máximo de ${PROFILE_EMAIL_MAX} caracteres.`;
    else data.email = email;
  }
  return { ok: Object.keys(errors).length === 0, data, errors };
}

/** Nome padrão derivado do e-mail ("ana@x.com" → "ana"). Puro. */
export function defaultProfileName(email) {
  const local = String(email ?? '').split('@')[0].trim();
  return (local || 'Usuário').slice(0, PROFILE_NAME_MAX);
}

/** Lê as configurações (null se ainda não existem). */
export async function getSettings(uid, io = {}) {
  const { getSingleton: getFn = getSingleton } = io;
  return getFn(uid, COLLECTIONS.settings, SETTINGS_DOC_ID);
}

/** Lê o perfil (null se ainda não existe). */
export async function getProfile(uid, io = {}) {
  const { getSingleton: getFn = getSingleton } = io;
  return getFn(uid, COLLECTIONS.profile, PROFILE_DOC_ID);
}

/**
 * Salva (cria ou atualiza) as configurações. Retorna { ok, data?, errors? }.
 * Na criação, `theme` assume 'system' se não informado e `createdAt` é gravado.
 */
export async function saveSettings(uid, patch, io = {}) {
  const {
    getSingleton: getFn = getSingleton,
    saveSingleton: saveFn = saveSingleton,
    writeAudit: auditFn = writeAudit,
    now = serverTimestamp,
  } = io;

  const { ok, data, errors } = validateSettings(patch);
  if (!ok) return { ok: false, errors };
  if (Object.keys(data).length === 0) {
    return { ok: false, errors: { _form: 'Nenhuma configuração para salvar.' } };
  }

  const existing = await getFn(uid, COLLECTIONS.settings, SETTINGS_DOC_ID);
  const isCreate = !existing;
  const payload = isCreate
    ? { theme: DEFAULT_THEME, ...data, createdAt: now() }
    : data;

  await saveFn(uid, COLLECTIONS.settings, payload, SETTINGS_DOC_ID);
  await auditFn(uid, {
    action: isCreate ? 'create' : 'update',
    collection: COLLECTIONS.settings,
    docId: SETTINGS_DOC_ID,
    after: isCreate ? { theme: DEFAULT_THEME, ...data } : data,
  });
  return { ok: true, data };
}

/**
 * Salva (cria ou atualiza) o perfil. `email` é obrigatório na criação (vem do Auth)
 * e não é editável pelo usuário depois. Retorna { ok, data?, errors? }.
 */
export async function saveProfile(uid, patch, io = {}) {
  const {
    getSingleton: getFn = getSingleton,
    saveSingleton: saveFn = saveSingleton,
    writeAudit: auditFn = writeAudit,
    now = serverTimestamp,
  } = io;

  const { email: authEmail, ...editable } = patch ?? {};
  const existing = await getFn(uid, COLLECTIONS.profile, PROFILE_DOC_ID);
  const isCreate = !existing;

  const candidate = { ...editable };
  if (isCreate) {
    candidate.email = authEmail ?? ''; // obrigatório na criação (Rules)
    if (candidate.name === undefined) candidate.name = defaultProfileName(authEmail);
  }

  const { ok, data, errors } = validateProfile(candidate);
  if (!ok) return { ok: false, errors };
  if (Object.keys(data).length === 0) {
    return { ok: false, errors: { _form: 'Nenhum dado de perfil para salvar.' } };
  }

  const payload = isCreate
    ? { ...data, currency: 'BRL', locale: 'pt-BR', createdAt: now() }
    : data;

  await saveFn(uid, COLLECTIONS.profile, payload, PROFILE_DOC_ID);
  await auditFn(uid, {
    action: isCreate ? 'create' : 'update',
    collection: COLLECTIONS.profile,
    docId: PROFILE_DOC_ID,
    after: isCreate ? { ...data, currency: 'BRL', locale: 'pt-BR' } : data,
  });
  return { ok: true, data };
}
