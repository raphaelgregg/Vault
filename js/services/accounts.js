/**
 * Serviço de Contas — Fase 3: CRUD + validação do modelo + auditoria.
 * Isolamento por usuário via users/{uid}/accounts.
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
import { buildEntity, formatCents, parseMoneyToCents, accountBalances, ACCOUNT_TYPES } from '../core/model.js';
import { loadBalances } from './balances.js';

const COLLECTION = COLLECTIONS.accounts;

/** Lista todas as contas do usuário ordenadas por instituição e nome. */
export async function listAccounts(uid, options = {}) {
  return list(uid, COLLECTION, {
    orderBy: ['institution', 'asc'],
    ...(options.limit ? { limit: options.limit } : {}),
  });
}

/** Busca uma conta por ID. */
export async function getAccount(uid, accountId) {
  return getById(uid, COLLECTION, accountId);
}

/**
 * Cria uma nova conta.
 * Retorna { ok, id, errors }.
 */
export async function createAccount(uid, rawData, io = {}) {
  const { ok, data, errors } = buildEntity('accounts', rawData);
  if (!ok) return { ok: false, errors };

  const id = await createAudited(uid, COLLECTION, data, io);
  return { ok: true, id };
}

/**
 * Atualiza uma conta existente.
 * Retorna { ok, errors }.
 */
export async function updateAccount(uid, accountId, rawData, io = {}) {
  const { ok, data, errors } = buildEntity('accounts', rawData);
  if (!ok) return { ok: false, errors };

  // Conta sem nome: remove `name` se existia (null → deleteField em `update`; update é merge).
  // `openingDate` ausente também é removida (null → deleteField): voltar a contar todos os movimentos.
  await updateAudited(uid, COLLECTION, accountId, { ...data, name: data.name ?? null, openingDate: data.openingDate ?? null }, io);
  return { ok: true };
}

/**
 * Cálculo PURO do ajuste de saldo de abertura. `account` (com ou sem `openingDate` novo), `movements` = movimentos
 * realizados lidos; `realCents` = quanto a conta tem de fato agora. Fórmula:
 *   movimentos = saldo_atual_derivado − abertura_atual      (o que os lançamentos acrescentam)
 *   nova_abertura = saldo_real − movimentos
 * Só o saldo de abertura muda; nenhum movimento é tocado. Retorna { currentCents, movementsCents, newInitialCents }.
 */
export function computeOpeningAdjustment(account, movements, realCents) {
  const initial = Number(account.initialBalanceCents) || 0;
  const current = accountBalances([account], movements).get(account.id) ?? initial;
  const movementsCents = current - initial;
  return { currentCents: current, movementsCents, newInitialCents: realCents - movementsCents };
}

/**
 * Ajusta o saldo de abertura de UMA conta para que o saldo atual derivado seja `realCents` (ação explícita do
 * usuário; nada é automático). Opcionalmente define `openingDate` (movimentos anteriores deixam de contar).
 * Fail-closed: não ajusta se a leitura dos movimentos foi truncada (saldo incompleto) ou falhou, e rejeita
 * abertura negativa (o saldo informado é menor que o dos lançamentos — informe uma data de abertura).
 * Retorna { ok, previousInitialCents, newInitialCents, movementsCents, errors }.
 */
export async function adjustOpeningBalance(uid, accountId, realInput, { openingDate = null } = {}, io = {}) {
  const realCents = typeof realInput === 'number' ? realInput : parseMoneyToCents(realInput);
  if (!Number.isInteger(realCents) || realCents < 0) return { ok: false, errors: { realBalance: 'Informe o saldo atual da conta (valor monetário válido, sem negativo).' } };
  if (openingDate && !/^\d{4}-\d{2}-\d{2}$/.test(openingDate)) return { ok: false, errors: { openingDate: 'Data inválida (use AAAA-MM-DD).' } };
  const account = await (io.getById ?? getById)(uid, COLLECTION, accountId);
  if (!account) return { ok: false, errors: { _form: 'Conta não encontrada.' } };
  let loaded;
  try {
    loaded = await loadBalances(uid, [{ ...account, openingDate: openingDate || undefined }], io.list ? { list: io.list } : {});
  } catch (error) {
    console.error('[accounts] falha ao ler movimentos', error);
    return { ok: false, errors: { _form: 'Não foi possível ler as movimentações da conta; o ajuste foi cancelado por segurança.' } };
  }
  if (loaded.truncated.length) {
    return { ok: false, errors: { _form: `Leitura limitada (${loaded.truncated.join(', ')}): o saldo calculado pode estar incompleto; o ajuste foi cancelado.` } };
  }
  const { movementsCents, newInitialCents } = computeOpeningAdjustment({ ...account, openingDate: openingDate || undefined }, loaded.movements, realCents);
  if (newInitialCents < 0) {
    return { ok: false, errors: { realBalance: `Os lançamentos já somam ${formatCents(movementsCents)}, mais que o saldo informado. Defina uma data de abertura para ignorar movimentos anteriores.` } };
  }
  const patch = { initialBalanceCents: newInitialCents, ...(openingDate ? { openingDate } : {}) };
  await updateAudited(uid, COLLECTION, accountId, patch, io, 'adjust_opening_balance');
  return { ok: true, previousInitialCents: Number(account.initialBalanceCents) || 0, newInitialCents, movementsCents };
}

/**
 * Referências a accounts/{id}, uma entrada por campo (transferências têm origem
 * e destino). Espelha os `ref(userId, 'accounts', ...)` de firestore.rules.
 */
export const ACCOUNT_LINK_QUERIES = Object.freeze([
  { collection: COLLECTIONS.incomes, field: 'accountId', label: 'receitas' },
  { collection: COLLECTIONS.expenses, field: 'accountId', label: 'despesas' },
  { collection: COLLECTIONS.transfers, field: 'fromAccountId', label: 'transferências (origem)' },
  { collection: COLLECTIONS.transfers, field: 'toAccountId', label: 'transferências (destino)' },
  { collection: COLLECTIONS.subscriptions, field: 'accountId', label: 'assinaturas' },
  { collection: COLLECTIONS.debtPayments, field: 'accountId', label: 'pagamentos de dívidas' },
  { collection: COLLECTIONS.creditCards, field: 'accountId', label: 'cartões' },
  { collection: COLLECTIONS.goals, field: 'accountId', label: 'metas' },
  { collection: COLLECTIONS.goalTransactions, field: 'accountId', label: 'movimentações de metas' },
  { collection: COLLECTIONS.invoices, field: 'accountId', label: 'faturas pagas' },
]);

/** Resume contagens de vínculos. Puro — sem Firebase. */
export function summarizeAccountLinks(counts = []) {
  const links = counts
    .map(({ collection, label, count: value }) => ({
      collection,
      label,
      count: Number.isInteger(value) && value > 0 ? value : 0,
    }))
    .filter((link) => link.count > 0);
  const total = links.reduce((sum, link) => sum + link.count, 0);
  return { links, total, inUse: total > 0 };
}

/** Mensagem de bloqueio da exclusão. Puro. */
export function buildAccountInUseMessage(summary) {
  const links = summary?.links ?? [];
  if (!links.length) return 'Esta conta não pode ser excluída porque está em uso.';
  const parts = links.map((link) => `${link.label} (${link.count})`);
  return `Esta conta não pode ser excluída: possui movimentações vinculadas — ${parts.join(', ')}. `
    + 'Altere ou remova esses registros, ou arquive a conta (status "Arquivada") para preservá-los.';
}

/**
 * Conta os vínculos de uma conta. Lança se qualquer contagem falhar —
 * o chamador decide (fail-closed).
 */
export async function countAccountUsage(uid, accountId, countFn = count) {
  const counts = await Promise.all(
    ACCOUNT_LINK_QUERIES.map(async ({ collection, field, label }) => ({
      collection,
      label,
      count: await countFn(uid, collection, { where: [[field, '==', accountId]] }),
    }))
  );
  return summarizeAccountLinks(counts);
}

/**
 * Exclui uma conta somente se não houver movimentações vinculadas.
 * `io` permite injetar dependências nos testes (padrão: services/firestore.js).
 */
export async function deleteAccount(uid, accountId, io = {}) {
  const { getById: getFn = getById, count: countFn = count } = io;

  const account = await getFn(uid, COLLECTION, accountId);
  if (!account) return { ok: false, errors: { _form: 'Conta não encontrada.' } };

  // As Rules não conseguem consultar coleções na exclusão (sem count/query), então
  // a integridade referencial é garantida aqui, fail-closed (padrão de deleteCategory).
  let usage;
  try {
    usage = await countAccountUsage(uid, accountId, countFn);
  } catch (error) {
    console.error('[accounts] falha ao verificar vínculos', error);
    return {
      ok: false,
      errors: {
        _form:
          'Não foi possível verificar se a conta possui movimentações. A exclusão foi cancelada por segurança; tente novamente.',
      },
    };
  }

  // LIMITAÇÃO CONHECIDA: checagem client-side; há janela de concorrência entre a
  // contagem e o delete. Mitigação definitiva exige backend (fora do plano Spark).
  if (usage.inUse) {
    return { ok: false, errors: { _form: buildAccountInUseMessage(usage) } };
  }

  await removeAudited(uid, COLLECTION, accountId, account, io);
  return { ok: true };
}

/** Formata opções de tipo de conta para <select>. */
export function getAccountTypeOptions() {
  return ACCOUNT_TYPES.map((t) => ({ value: t.value, label: t.label }));
}

/** Status options for select. */
export function getStatusOptions() {
  return [
    { value: 'active', label: 'Ativa' },
    { value: 'inactive', label: 'Inativa' },
    { value: 'archived', label: 'Arquivada' },
  ];
}

/** Formata centavos para exibição (R$ 1.234,56). */
export { formatCents, parseMoneyToCents };
