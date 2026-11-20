/**
 * Harness de INTEGRAÇÃO com o Firebase Emulator Suite (sem mocks): executa as funções REAIS dos services
 * (js/services/*.js, incluindo `commitAtomic`, `increment`, `serverTimestamp` e os lotes) contra o Firestore do emulador
 * com as Security Rules REAIS (firestore.rules). O acesso ao banco é injetado (`io`) — nenhuma função usa o `db` de
 * js/firebase/client.js, então NADA aqui pode tocar o projeto de produção (todas as chamadas vão ao emulador
 * 127.0.0.1:8080, projeto demo-vault-finance).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { initializeTestEnvironment } from '@firebase/rules-unit-testing';
import {
  doc, collection, getDoc, getDocs, query, where, orderBy, limit as limitTo, writeBatch, setDoc, addDoc, updateDoc, deleteDoc,
  serverTimestamp, getCountFromServer,
} from 'firebase/firestore';
import {
  commitAtomic, toFirestoreData, fromFirestoreDoc, toWhereValue, withFieldDeletes, auditPayload,
} from '../../../js/services/firestore.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const PROJECT_ID = 'demo-vault-finance';
export const ALICE = 'alice-uid';

export async function startEnv() {
  return initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: { rules: readFileSync(join(root, 'firestore.rules'), 'utf8'), host: '127.0.0.1', port: 8080 },
  });
}

/**
 * io completo (leitura, escrita, lote atômico, auditoria) sobre o Firestore do emulador autenticado como `uid`.
 * `hooks.beforeCommit(ops)` (opcional, assíncrono) roda ANTES de cada lote — usado para forçar leituras antigas
 * (barreira) e para injetar falhas.
 */
export function makeRealIo(testEnv, uid = ALICE, hooks = {}) {
  const db = testEnv.authenticatedContext(uid).firestore();
  const userDoc = (u, c, id) => doc(db, 'users', u, c, id);
  const userCollection = (u, c) => collection(db, 'users', u, c);
  const newDocRef = (u, c) => doc(userCollection(u, c));
  const batchIo = { newBatch: () => writeBatch(db), userDoc, newDocRef };
  const io = {
    db,
    getById: async (u, c, id) => {
      const snap = await getDoc(userDoc(u, c, id));
      return snap.exists() ? fromFirestoreDoc(snap.id, snap.data()) : null;
    },
    list: async (u, c, options = {}) => {
      const constraints = [];
      for (const [field, op, value] of options.where ?? []) constraints.push(where(field, op, toWhereValue(field, value)));
      if (options.orderBy) constraints.push(orderBy(options.orderBy[0], options.orderBy[1] ?? 'asc'));
      if (options.limit) constraints.push(limitTo(options.limit));
      const snap = await getDocs(query(userCollection(u, c), ...constraints));
      return snap.docs.map((d) => fromFirestoreDoc(d.id, d.data()));
    },
    count: async (u, c, options = {}) => {
      const constraints = (options.where ?? []).map(([f, op, v]) => where(f, op, toWhereValue(f, v)));
      return (await getCountFromServer(query(userCollection(u, c), ...constraints))).data().count;
    },
    create: async (u, c, data, docId = null) => {
      await hooks.beforeWrite?.('create', c, data);
      const payload = { ...toFirestoreData(data), createdAt: serverTimestamp(), updatedAt: serverTimestamp() };
      if (docId) { await setDoc(userDoc(u, c, docId), payload); return docId; }
      return (await addDoc(userCollection(u, c), payload)).id;
    },
    update: async (u, c, id, data) => {
      await hooks.beforeWrite?.('update', c, data);
      return updateDoc(userDoc(u, c, id), { ...withFieldDeletes(toFirestoreData(data)), updatedAt: serverTimestamp() });
    },
    remove: async (u, c, id) => deleteDoc(userDoc(u, c, id)),
    writeAudit: async (u, entry) => { await addDoc(userCollection(u, 'auditLog'), auditPayload(u, entry)); return { ok: true }; },
    lookupCategory: async (u, id) => {
      const snap = await getDoc(userDoc(u, 'categories', id));
      return snap.exists() ? fromFirestoreDoc(snap.id, snap.data()) : null;
    },
    commitAtomic: async (u, ops) => {
      await hooks.beforeCommit?.(ops);
      const ids = await commitAtomic(u, ops, batchIo);
      await hooks.afterCommit?.(ops, ids);
      return ids;
    },
  };
  return io;
}

/** Barreira: só libera os `n` lotes quando os `n` chegaram — garante que TODOS leram o estado antigo (pior caso). */
export function makeBarrier(n) {
  let arrived = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  return async () => { arrived += 1; if (arrived >= n) release(); await gate; };
}

/** Leitura crua de todos os documentos de uma coleção do usuário (sem passar pelos services). */
export async function dump(testEnv, collectionName, uid = ALICE) {
  let out = [];
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const snap = await getDocs(collection(ctx.firestore(), 'users', uid, collectionName));
    out = snap.docs.map((d) => fromFirestoreDoc(d.id, d.data()));
  });
  return out;
}

/** Resultado de uma tentativa: { ok, code? } sem engolir o erro — o código (ex.: permission-denied) fica identificável. */
export const attempt = (fn) => Promise.resolve().then(fn).then(
  (r) => ({ ok: r?.ok !== false, result: r }),
  (e) => ({ ok: false, code: e?.code ?? 'error', message: e?.message }),
);
