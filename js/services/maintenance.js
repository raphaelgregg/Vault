/**
 * Manutenção de dados (VF-2-03u/03w): limpeza em lotes (≤ 500 operações) em três ESCOPOS:
 *  - `own`        — o uid autenticado (qualquer usuário autorizado na interface);
 *  - `target_uid` — um uid específico, SÓ para administrador (claim `admin == true`), sem entrar na conta dele;
 *  - `all_users`  — todos os usuários via consulta de grupo, SÓ para administrador.
 *
 * SEGURANÇA (Firestore Rules — a única barreira real; as checagens daqui só evitam chamadas inúteis):
 *  - usuário comum só acessa `users/{próprio uid}`; outros uids dão `permission-denied`;
 *  - administrador = custom claim de token `admin == true` (definida pelo Admin SDK/Console), com poderes
 *    MÍNIMOS: ler e apagar documentos das coleções de DOMÍNIO de qualquer uid (não cria, não edita, não vê
 *    perfil/configurações);
 *  - `auditLog` é create-only para TODOS (inclusive admin): a limpeza do próprio usuário o tenta e destaca o
 *    `permission-denied`; os escopos administrativos nem o tentam (o admin não lê o log alheio).
 * Cada operação grava UMA entrada de auditoria-resumo no auditLog do EXECUTOR (`adminUid`, escopo, `targetUid`,
 * totais, falhas). `io` (list, newBatch, userDoc, listGroup, docAtPath, writeAudit) é injetável nos testes.
 */
import { COLLECTIONS } from '../utils/constants.js';
import { list, newBatch, userDoc, writeAudit, listCollectionGroup, docAtPath } from './firestore.js';

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

export const SCOPES = Object.freeze({ OWN: 'own', TARGET: 'target_uid', ALL: 'all_users' });

/** `true` só se o token do usuário traz a claim booleana `admin === true` (força renovar o token). */
export async function isAdminUser(user, { refresh = true } = {}) {
  try {
    const result = await user?.getIdTokenResult?.(refresh);
    return result?.claims?.admin === true;
  } catch (error) {
    console.error('[maintenance] falha ao ler claims', error);
    return false;
  }
}

/**
 * Limpeza global por consulta de grupo (admin): para cada coleção de domínio, lê as primeiras `BATCH_LIMIT`
 * entradas de TODOS os usuários e apaga em lote, repetindo até esvaziar. `onLog(result)` por coleção, com
 * `byUid` (contagem por uid). Para na 1ª falha da coleção (ex.: permission-denied).
 */
export async function clearAllUsersData({ onLog, io = {} } = {}) {
  const group = io.listGroup ?? listCollectionGroup;
  const makeBatch = io.newBatch ?? newBatch;
  const refOf = io.docAtPath ?? docAtPath;
  const results = [];
  for (const collection of DOMAIN_COLLECTIONS) {
    const r = { collection, deleted: 0, batches: 0, error: null, permissionDenied: false, byUid: {} };
    try {
      for (;;) {
        const docs = await group(collection, BATCH_LIMIT);
        if (!docs.length) break;
        const batch = makeBatch();
        for (const d of docs) batch.delete(refOf(d.path));
        await batch.commit();
        for (const d of docs) r.byUid[d.uid] = (r.byUid[d.uid] ?? 0) + 1;
        r.deleted += docs.length;
        r.batches += 1;
        if (docs.length < BATCH_LIMIT) break;
      }
    } catch (error) {
      r.error = `${error?.code ? `${error.code}: ` : ''}${error?.message ?? error}`.trim();
      r.permissionDenied = isPermissionDenied(error);
    }
    results.push(r);
    onLog?.(r);
  }
  const byUid = {};
  for (const r of results) for (const [u, n] of Object.entries(r.byUid)) byUid[u] = (byUid[u] ?? 0) + n;
  return { ...summarize('*', results), byUid };
}

/**
 * Usuários detectados (admin): amostra de até `max` documentos por coleção de domínio via consulta de grupo.
 * Retorna [{ uid, docs, collections }] ordenado por volume. É amostra (`sampled`): não há lista oficial de usuários.
 */
export async function discoverUsers({ max = BATCH_LIMIT, io = {} } = {}) {
  const group = io.listGroup ?? listCollectionGroup;
  const byUid = new Map();
  const errors = [];
  for (const collection of DOMAIN_COLLECTIONS) {
    try {
      for (const d of await group(collection, max)) {
        const e = byUid.get(d.uid) ?? { uid: d.uid, docs: 0, collections: new Set() };
        e.docs += 1;
        e.collections.add(collection);
        byUid.set(d.uid, e);
      }
    } catch (error) {
      errors.push({ collection, error: `${error?.code ? `${error.code}: ` : ''}${error?.message ?? error}` });
    }
  }
  return {
    users: [...byUid.values()].map((e) => ({ uid: e.uid, docs: e.docs, collections: [...e.collections].sort() })).sort((a, b) => b.docs - a.docs),
    errors,
    sampled: true,
  };
}

/**
 * Executa a limpeza no ESCOPO pedido e registra auditoria-resumo no log do executor.
 * `admin` = o executor tem a claim (o chamador usa `isAdminUser`); escopos administrativos sem ela são RECUSADOS
 * aqui (nada é enviado ao Firestore) e, ainda assim, as Rules negariam.
 * Retorna { ok, scope, adminUid, targetUid, deleted, failures, permissionDenied, results, error? }.
 */
export async function clearScope({ scope, adminUid, targetUid = null, admin = false, onLog, io = {} } = {}) {
  const target = String(targetUid ?? '').trim();
  const base = { scope, adminUid, targetUid: scope === SCOPES.TARGET ? target : null };
  if (!Object.values(SCOPES).includes(scope)) return { ok: false, ...base, error: 'Escopo inválido.' };
  if (!adminUid) return { ok: false, ...base, error: 'Executor não identificado.' };
  if (scope !== SCOPES.OWN && !admin) return { ok: false, ...base, error: 'Escopo administrativo exige a claim de administrador (admin == true).' };
  if (scope === SCOPES.TARGET && !target) return { ok: false, ...base, error: 'Informe ou selecione o uid alvo.' };

  let summary;
  if (scope === SCOPES.OWN) {
    summary = await clearUserData(adminUid, { onLog, io });
  } else if (scope === SCOPES.TARGET) {
    // auditLog alheio é imutável e ilegível ao admin: não é tentado (o log do próprio usuário é tratado em `own`).
    summary = await clearUserData(target, { onLog, io, includeAudit: false });
  } else {
    summary = await clearAllUsersData({ onLog, io });
  }
  const outcome = { ok: summary.failures === 0, ...base, deleted: summary.deleted, failures: summary.failures, permissionDenied: summary.permissionDenied, results: summary.results, byUid: summary.byUid };
  try {
    const audit = await (io.writeAudit ?? writeAudit)(adminUid, {
      action: `maintenance_clear_${scope}`, collection: 'maintenance', docId: scope === SCOPES.TARGET ? target : scope === SCOPES.ALL ? 'all_users' : adminUid,
      after: {
        scope, adminUid, targetUid: base.targetUid, deleted: outcome.deleted, failures: outcome.failures, permissionDenied: outcome.permissionDenied,
        byCollection: Object.fromEntries(summary.results.map((r) => [r.collection, r.deleted])),
      },
    });
    if (audit?.ok === false) outcome.auditError = String(audit.error?.message ?? audit.error ?? 'falha ao gravar');
  } catch (error) {
    console.error('[maintenance] auditoria-resumo não gravada', error);
    outcome.auditError = String(error?.message ?? error);
  }
  return outcome;
}
