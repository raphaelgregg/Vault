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
import { isDateFieldName, parseIsoDate, dateToIsoDate } from '../utils/dates.js';

export { Timestamp, serverTimestamp };

// Regras publicadas exigem timestamp nativo nos campos de data; o modelo trabalha
// com strings ISO. Conversão na camada de serviço, nos dois sentidos, SOMENTE nos
// campos de data (`date`/`*Date`) e sempre em meio-dia UTC (sem deslocar o dia por fuso).
export function toFirestoreData(data) {
  return Object.fromEntries(
    Object.entries(data).map(([key, value]) => {
      if (typeof value !== 'string' || !isDateFieldName(key)) return [key, value];
      const parsed = parseIsoDate(value);
      if (!parsed) throw new RangeError(`Data inválida em "${key}" (use AAAA-MM-DD).`);
      return [key, Timestamp.fromDate(parsed)];
    })
  );
}

export function fromFirestoreDoc(id, data) {
  const out = { id };
  for (const [key, value] of Object.entries(data)) {
    // Campos de data (não createdAt/updatedAt) voltam como string ISO
    if (value && typeof value.toDate === 'function' && isDateFieldName(key)) {
      out[key] = dateToIsoDate(value);
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
export function auditPayload(uid, entry) {
  const { action, collection: entity, docId: entityId, before, after } = entry ?? {};
  return stripUndefined({
    action,
    entity,
    entityId,
    before,
    after,
    actorUid: uid,
    createdAt: serverTimestamp(),
  });
}

export async function writeAudit(uid, entry) {
  const payload = auditPayload(uid, entry);
  try {
    await addDoc(userCollection(uid, 'auditLog'), payload);
    return { ok: true };
  } catch (error) {
    console.error('[audit] falha ao registrar auditoria — a operação principal foi concluída', error);
    return { ok: false, error };
  }
}

/**
 * Helpers CRUD + auditoria usados pelos services (VF-3-01). `io` permite injetar
 * create/update/remove/writeAudit nos testes. A auditoria nunca lança (ver writeAudit).
 */
export async function createAudited(uid, collectionName, data, io = {}) {
  const { create: createFn = create, writeAudit: auditFn = writeAudit } = io;
  const id = await createFn(uid, collectionName, data);
  await auditFn(uid, { action: 'create', collection: collectionName, docId: id, after: data });
  return id;
}

/** `action` padrão 'update'; `after` = campos gravados (patch). */
export async function updateAudited(uid, collectionName, docId, data, io = {}, action = 'update') {
  const { update: updateFn = update, writeAudit: auditFn = writeAudit } = io;
  await updateFn(uid, collectionName, docId, data);
  await auditFn(uid, { action, collection: collectionName, docId, after: data });
}

/** `before` = documento lido antes da exclusão. */
export async function removeAudited(uid, collectionName, docId, before, io = {}) {
  const { remove: removeFn = remove, writeAudit: auditFn = writeAudit } = io;
  await removeFn(uid, collectionName, docId);
  await auditFn(uid, { action: 'delete', collection: collectionName, docId, before });
}

/** Lote para operações que precisam ser atômicas na Fase 3. */
export function newBatch() {
  return writeBatch(db);
}

export { writeBatch };

/**
 * Grava várias operações e as auditorias correspondentes em UM lote (tudo ou nada).
 * ops: [{ type: 'create'|'update', collection, docId?, data, action? }]. Em 'create'
 * sem docId o ID é gerado. Retorna os IDs na ordem das ops. Diferente de
 * createAudited/updateAudited, a auditoria entra no lote: falha → nada é gravado.
 * `io` (newBatch, userDoc, newDocRef) é injetável nos testes.
 */
export async function commitAtomic(uid, ops, io = {}) {
  const {
    newBatch: newBatchFn = newBatch,
    userDoc: userDocFn = userDoc,
    newDocRef = (u, c) => doc(userCollection(u, c)),
  } = io;
  const batch = newBatchFn();
  const ids = [];
  for (const op of ops) {
    const stamps = { updatedAt: serverTimestamp() };
    if (op.type === 'create') {
      const ref = op.docId ? userDocFn(uid, op.collection, op.docId) : newDocRef(uid, op.collection);
      batch.set(ref, { ...toFirestoreData(op.data), createdAt: serverTimestamp(), ...stamps });
      ids.push(ref.id);
      batch.set(newDocRef(uid, 'auditLog'), auditPayload(uid, {
        action: op.action ?? 'create', collection: op.collection, docId: ref.id, after: op.data,
      }));
    } else {
      batch.update(userDocFn(uid, op.collection, op.docId), { ...toFirestoreData(op.data), ...stamps });
      ids.push(op.docId);
      batch.set(newDocRef(uid, 'auditLog'), auditPayload(uid, {
        action: op.action ?? 'update', collection: op.collection, docId: op.docId, after: op.data,
      }));
    }
  }
  await batch.commit();
  return ids;
}
