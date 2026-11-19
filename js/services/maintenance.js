/**
 * Manutenção de dados (VF-2-03u): limpeza em lotes (≤ 500 operações) por usuário ou "banco inteiro".
 *
 * LIMITES REAIS (Firestore Rules, não contornáveis pelo cliente):
 *  - o cliente só acessa `users/{uid}` do PRÓPRIO uid (`isOwner`); outros usuários dão `permission-denied`
 *    e nem podem ser enumerados — "Banco inteiro" limpa o uid autenticado e tenta os uids informados,
 *    registrando o bloqueio; limpar outros usuários exige Admin SDK/Console (fora do frontend, por regra do projeto);
 *  - `auditLog` é create-only (`allow update, delete: if false`): a limpeza o lê e tenta apagar, o Firestore nega
 *    e o log destaca isso. Não alteramos as Rules para quebrar a imutabilidade da auditoria.
 * `io` (list, newBatch, userDoc, writeAudit) é injetável nos testes.
 */
import { COLLECTIONS } from '../utils/constants.js';
import { list, newBatch, userDoc, writeAudit } from './firestore.js';

export const BATCH_LIMIT = 500;

/** Coleções de domínio apagadas (perfil e configurações do usuário ficam). `auditLog` por último e à parte. */
export const DOMAIN_COLLECTIONS = Object.freeze([
  COLLECTIONS.goalTransactions, COLLECTIONS.goals, COLLECTIONS.debtPayments, COLLECTIONS.debts, COLLECTIONS.debtors,
  COLLECTIONS.cardPurchases, COLLECTIONS.invoices, COLLECTIONS.creditCards, COLLECTIONS.subscriptions, COLLECTIONS.budgets,
  COLLECTIONS.transfers, COLLECTIONS.expenses, COLLECTIONS.incomes, COLLECTIONS.categories, COLLECTIONS.accounts,
]);
export const AUDIT_COLLECTION = 'auditLog';

const isPermissionDenied = (error) => String(error?.code ?? '').includes('permission-denied');

/**
 * Apaga uma coleção do usuário em páginas de até BATCH_LIMIT documentos por `writeBatch`.
 * Retorna { collection, deleted, batches, error, permissionDenied }. Para na primeira falha (não repete em loop).
 */
export async function clearCollection(uid, collection, io = {}) {
  const fetchList = io.list ?? list;
  const makeBatch = io.newBatch ?? newBatch;
  const docRef = io.userDoc ?? userDoc;
  const result = { collection, deleted: 0, batches: 0, error: null, permissionDenied: false };
  try {
    // Sempre relê a 1ª página: o que foi apagado some, e uma coleção grande termina em N lotes.
    for (;;) {
      const docs = await fetchList(uid, collection, { limit: BATCH_LIMIT });
      if (!docs.length) break;
      const batch = makeBatch();
      for (const d of docs) batch.delete(docRef(uid, collection, d.id));
      await batch.commit();
      result.deleted += docs.length;
      result.batches += 1;
      if (docs.length < BATCH_LIMIT) break;
    }
  } catch (error) {
    result.error = `${error?.code ? `${error.code}: ` : ''}${error?.message ?? error}`.trim();
    result.permissionDenied = isPermissionDenied(error);
  }
  return result;
}

/**
 * Limpa TODAS as coleções de domínio (e tenta `auditLog`) de UM uid. `onLog(result)` a cada coleção.
 * Retorna { uid, results, deleted, failures, permissionDenied }.
 */
export async function clearUserData(uid, { onLog, io = {}, includeAudit = true } = {}) {
  const results = [];
  for (const collection of [...DOMAIN_COLLECTIONS, ...(includeAudit ? [AUDIT_COLLECTION] : [])]) {
    const r = await clearCollection(uid, collection, io);
    results.push(r);
    onLog?.(r);
  }
  return summarize(uid, results);
}

const summarize = (uid, results) => ({
  uid,
  results,
  deleted: results.reduce((t, r) => t + r.deleted, 0),
  failures: results.filter((r) => r.error).length,
  permissionDenied: results.filter((r) => r.permissionDenied).length,
});

/**
 * "Banco inteiro": limpa o uid autenticado e TENTA cada uid extra informado — as Rules negam os de outros
 * usuários e isso fica destacado no log. Grava UMA entrada de auditoria-resumo (create-only) do uid autenticado.
 */
export async function clearWholeDatabase(uid, { extraUids = [], onLog, io = {} } = {}) {
  const runs = [];
  runs.push(await clearUserData(uid, { onLog: (r) => onLog?.({ ...r, uid }), io }));
  for (const other of [...new Set(extraUids.map((u) => String(u).trim()).filter((u) => u && u !== uid))]) {
    // Só 1 consulta de prova por uid alheio: a leitura já é negada pelas Rules (sem tentar apagar nada).
    const probe = await clearCollection(other, DOMAIN_COLLECTIONS[0], io);
    onLog?.({ ...probe, uid: other, collection: `users/${other}/*` });
    runs.push({ uid: other, results: [probe], deleted: probe.deleted, failures: probe.error ? 1 : 0, permissionDenied: probe.permissionDenied ? 1 : 0 });
  }
  await (io.writeAudit ?? writeAudit)(uid, {
    action: 'maintenance_clear_all', collection: 'maintenance', docId: uid,
    after: { deleted: runs[0].deleted, failures: runs[0].failures, otherUidsTried: runs.length - 1 },
  });
  return { runs, deleted: runs.reduce((t, r) => t + r.deleted, 0) };
}

/** Auditoria-resumo da limpeza do próprio usuário (a limpeza em si não audita documento a documento). */
export async function auditUserClear(uid, summary, io = {}) {
  return (io.writeAudit ?? writeAudit)(uid, {
    action: 'maintenance_clear_user', collection: 'maintenance', docId: uid,
    after: { deleted: summary.deleted, failures: summary.failures },
  });
}
