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

/**
 * Registro de auditoria imutável (create-only nas Rules).
 * Nunca lança para o fluxo principal: falha de log não deve impedir a operação.
 */
export async function writeAudit(uid, entry) {
  try {
    await addDoc(userCollection(uid, 'auditLog'), {
      ...entry,
      actorUid: uid,
      createdAt: serverTimestamp(),
    });
  } catch (error) {
    console.warn('[audit] falha ao registrar auditoria', error);
  }
}

/** Lote para operações que precisam ser atômicas na Fase 3. */
export function newBatch() {
  return writeBatch(db);
}

export { writeBatch };
