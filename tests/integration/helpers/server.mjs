/**
 * Harness da CAMADA CONFIÁVEL (VF-ARQ-02): Admin SDK real contra o Firestore Emulator (FIRESTORE_EMULATOR_HOST é definido
 * por `firebase emulators:exec`). O handler é o MESMO usado pela Vercel (`handleFinance`); só o `verifyIdToken` é injetado
 * nos testes comuns (token "tok-<uid>"); testes de autenticação usam tokens REAIS do Auth Emulator.
 */
import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { handleFinance } from '../../../server/finance/index.mjs';
import { plain } from '../../../server/finance/core.mjs';

export const PROJECT_ID = 'demo-vault-finance';
export const UID = 'alice-uid';
export const OTHER = 'bob-uid';
let db;
export function adminDb() {
  if (!db) {
    if (!getApps().length) initializeApp({ projectId: PROJECT_ID });
    db = getFirestore();
    db.settings({ ignoreUndefinedProperties: true });
  }
  return db;
}

/** Limpa o emulador entre testes (endpoint REST do emulador). */
export async function clearAll() {
  await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT_ID}/databases/(default)/documents`, { method: 'DELETE' });
}

let counter = 0;
export const opId = (prefix = 'op') => `${prefix}-${Date.now().toString(36)}-${(counter += 1)}`;

/** Chama o handler como `uid`. Retorna { status, body }. */
export async function call(uid, op, operationId, params, deps = {}) {
  return handleFinance(
    { method: 'POST', headers: { authorization: `Bearer tok-${uid}` }, body: { op, operationId, params } },
    { db: adminDb(), verifyIdToken: async (t) => ({ uid: String(t).replace(/^tok-/, '') }), log: process.env.SRV_LOG ? (e) => { if (e.event === 'finance_error') console.error(JSON.stringify(e)); } : () => {}, ...deps },
  );
}

/** Variante que exige sucesso (falha o teste com o corpo do erro). */
export async function callOk(uid, op, operationId, params, deps) {
  const r = await call(uid, op, operationId, params, deps);
  if (r.status !== 200) throw new Error(`${op} falhou: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

// ---- fixtures (Admin SDK: contornam as Rules, como o próprio servidor) ---------------------------------------------
const base = () => ({ createdAt: new Date(), updatedAt: new Date() });
export const noon = (iso) => new Date(`${iso}T12:00:00.000Z`);

export async function seed(uid, collection, id, data) {
  const conv = Object.fromEntries(Object.entries(data).map(([k, val]) => [k, typeof val === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(val) && /Date$|^date$|paidAt/.test(k) ? noon(val) : val]));
  await adminDb().doc(`users/${uid}/${collection}/${id}`).set({ ...conv, ...base() });
  return id;
}
export const seedAccount = (id, initialBalanceCents = 100000, uid = UID, extra = {}) => seed(uid, 'accounts', id, { institution: 'Banco', name: id, type: 'checking', initialBalanceCents, color: '#000', status: 'active', ...extra });
export const seedCategory = (id, kind, uid = UID) => seed(uid, 'categories', id, { name: id, kind, color: '#000' });

/** Leitura crua (oráculo) de uma coleção do usuário, com datas convertidas. */
export async function dump(collection, uid = UID) {
  return (await adminDb().collection(`users/${uid}/${collection}`).get()).docs.map(plain);
}
export async function getDoc(collection, id, uid = UID) {
  const s = await adminDb().doc(`users/${uid}/${collection}/${id}`).get();
  return s.exists ? plain(s) : null;
}

/** ORÁCULO de saldo por conta, independente de accountBalances: recalcula do cru (inclui estornos de recebimento/meta). */
export async function oracleBalance(accountId, uid = UID) {
  const [accounts, incomes, expenses, transfers, invoices, payments, goalTx, reversals] = await Promise.all(
    ['accounts', 'incomes', 'expenses', 'transfers', 'invoices', 'debtPayments', 'goalTransactions', 'reversals'].map((c) => dump(c, uid)));
  const reversed = new Set(reversals.map((r) => `${r.targetCollection}/${r.targetId}`));
  const a = accounts.find((x) => x.id === accountId);
  let bal = a.initialBalanceCents;
  for (const i of incomes) if (i.status === 'received' && i.accountId === accountId) bal += i.amountCents;
  for (const e of expenses) if (e.status === 'paid' && e.accountId === accountId) bal -= e.amountCents;
  for (const t of transfers) if (t.status === 'confirmed') { if (t.fromAccountId === accountId) bal -= t.amountCents; if (t.toAccountId === accountId) bal += t.amountCents; }
  for (const f of invoices) if (f.status === 'paid' && f.accountId === accountId) bal -= f.paidCents;
  for (const p of payments) if (p.accountId === accountId && !reversed.has(`debtPayments/${p.id}`)) bal += p.amountCents;
  for (const g of goalTx) if (g.accountId === accountId && !reversed.has(`goalTransactions/${g.id}`)) bal += g.type === 'deposit' ? -g.amountCents : g.amountCents;
  return bal;
}
