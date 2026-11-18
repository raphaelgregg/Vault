/**
 * CRUD genérico por usuário. Não contém regra financeira (Fase 3).
 * Todo caminho é users/{uid}/{colleção}/{docId} — o isolamento por usuário
 * é garantido pelas Security Rules, não por este módulo.
 */
import {
  collection,
  doc,
  getDoc,
  getDocs,
  addDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  query,
  where,
  orderBy,
  limit as limitTo,
  getCountFromServer,
  serverTimestamp,
  Timestamp,
  writeBatch,
} from 'firebase/firestore';
import { db } from '../firebase/client.js';

export { Timestamp, serverTimestamp };

// Regras publicadas exigem timestamp nativo nos campos de data; o modelo trabalha
// com strings ISO. Conversão na camada de serviço, nos dois sentidos.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function toFirestoreData(data) {
  return Object.fromEntries(
    Object.entries(data).map(([key, value]) =>
      typeof value === 'string' && ISO_DATE.test(value)
        ? [key, Timestamp.fromDate(new Date(`${value}T12:00:00`))]
        : [key, value]
    )
  );
}

function fromFirestoreDoc(id, data) {
  const out = { id };
  for (const [key, value] of Object.entries(data)) {
    // Campos de data (não createdAt/updatedAt) voltam como string ISO
    if (value && typeof value.toDate === 'function' && (/Date$/.test(key) || key === 'date')) {
      out[key] = value.toDate().toISOString().slice(0, 10);
    } else {
      out[key] = value;
    }
  }
  return out;
}

export function userCollection(uid, collectionName) {
  if (!uid) throw new Error('Usuário não autenticado.');
  return collection(db, 'users', uid, collectionName);
}

export function userDoc(uid, collectionName, docId) {
  if (!uid) throw new Error('Usuário não autenticado.');
  return doc(db, 'users', uid, collectionName, docId);
}

export async function getById(uid, collectionName, docId) {
  const snapshot = await getDoc(userDoc(uid, collectionName, docId));
  return snapshot.exists() ? fromFirestoreDoc(snapshot.id, snapshot.data()) : null;
}

/**
 * Lista documentos com filtros simples.
 * @param {object} options { where: [[campo, op, valor]], orderBy: [campo, 'asc'|'desc'], limit: number }
 */
export async function list(uid, collectionName, options = {}) {
  const constraints = [];
  for (const [field, op, value] of options.where ?? []) {
    constraints.push(where(field, op, value));
  }
  if (options.orderBy) {
    const [field, direction = 'asc'] = options.orderBy;
    constraints.push(orderBy(field, direction));
  }
  if (options.limit) constraints.push(limitTo(options.limit));
  const snapshot = await getDocs(query(userCollection(uid, collectionName), ...constraints));
  return snapshot.docs.map((item) => fromFirestoreDoc(item.id, item.data()));
}

export async function create(uid, collectionName, data, docId = null) {
  const payload = { ...toFirestoreData(data), createdAt: serverTimestamp(), updatedAt: serverTimestamp() };
  if (docId) {
    await setDoc(userDoc(uid, collectionName, docId), payload);
    return docId;
  }
  const created = await addDoc(userCollection(uid, collectionName), payload);
  return created.id;
}

export async function update(uid, collectionName, docId, data) {
  await updateDoc(userDoc(uid, collectionName, docId), {
    ...toFirestoreData(data),
    updatedAt: serverTimestamp(),
  });
}

export async function remove(uid, collectionName, docId) {
  await deleteDoc(userDoc(uid, collectionName, docId));
}

/**
 * Conta documentos que atendem aos filtros, sem baixar os documentos.
 * Usa agregação no servidor (getCountFromServer).
 * @param {object} options { where: [[campo, op, valor]] }
 */
export async function count(uid, collectionName, options = {}) {
  const constraints = [];
  for (const [field, op, value] of options.where ?? []) {
    constraints.push(where(field, op, value));
  }
  const snapshot = await getCountFromServer(
    query(userCollection(uid, collectionName), ...constraints)
  );
  return snapshot.data().count;
}

/** Documento único (profile, settings). */
export async function getSingleton(uid, collectionName, docId = 'main') {
  return getById(uid, collectionName, docId);
}

export async function saveSingleton(uid, collectionName, data, docId = 'main') {
  await setDoc(
    userDoc(uid, collectionName, docId),
    { ...data, updatedAt: serverTimestamp() },
    { merge: true }
  );
}

/** Remove `undefined` (o Firestore rejeita) de forma rasa e recursiva em objetos simples. */
function stripUndefined(value) {
  if (Array.isArray(value)) return value.map(stripUndefined);
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, stripUndefined(v)])
    );
  }
  return value;
}

/**
 * Registro de auditoria imutável (create-only nas Rules).
 * Entrada: { action, collection, docId, before?, after? } — gravada como
 * { action, entity, entityId, before?, after?, actorUid, createdAt }, o schema
 * fechado de auditLog em firestore.rules.
 *
 * Não lança: a operação principal já foi gravada e não deve parecer falha ao usuário.
 * A falha NÃO é silenciosa: é registrada com console.error e devolvida em
 * { ok: false, error } para quem quiser tratá-la.
 */
export async function writeAudit(uid, entry) {
  const { action, collection: entity, docId: entityId, before, after } = entry ?? {};
  const payload = stripUndefined({
    action,
    entity,
    entityId,
    before,
    after,
    actorUid: uid,
    createdAt: serverTimestamp(),
  });
  try {
    await addDoc(userCollection(uid, 'auditLog'), payload);
    return { ok: true };
  } catch (error) {
    console.error('[audit] falha ao registrar auditoria — a operação principal foi concluída', error);
    return { ok: false, error };
  }
}

/** Lote para operações que precisam ser atômicas na Fase 3. */
export function newBatch() {
  return writeBatch(db);
}

export { writeBatch };
