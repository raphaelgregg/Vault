/**
 * Serviço de autenticação: única porta de entrada para o Firebase Auth.
 * Nenhuma tela chama o SDK diretamente.
 */
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut as fbSignOut,
  sendPasswordResetEmail,
  onAuthStateChanged,
  setPersistence,
  browserLocalPersistence,
  updateProfile,
} from 'firebase/auth';
import { auth } from '../firebase/client.js';

/** Códigos do Firebase traduzidos para mensagens acionáveis em pt-BR. */
const AUTH_ERRORS = {
  'auth/invalid-email': 'E-mail inválido.',
  'auth/user-not-found': 'Não existe conta com este e-mail.',
  'auth/wrong-password': 'Senha incorreta.',
  'auth/invalid-credential': 'E-mail ou senha incorretos.',
  'auth/email-already-in-use': 'Este e-mail já está cadastrado.',
  'auth/weak-password': 'A senha precisa ter ao menos 6 caracteres.',
  'auth/too-many-requests': 'Muitas tentativas. Aguarde alguns minutos.',
  'auth/network-request-failed': 'Sem conexão. Verifique sua internet.',
  'auth/operation-not-allowed': 'Login por e-mail/senha não está habilitado no Firebase.',
};

export function authErrorMessage(error) {
  return AUTH_ERRORS[error?.code] ?? error?.message ?? 'Falha de autenticação.';
}

export async function signIn(email, password) {
  await setPersistence(auth, browserLocalPersistence);
  return signInWithEmailAndPassword(auth, String(email).trim(), password);
}

export async function register(email, password, displayName) {
  const credential = await createUserWithEmailAndPassword(auth, String(email).trim(), password);
  if (displayName) await updateProfile(credential.user, { displayName });
  return credential;
}

export async function resetPassword(email) {
  return sendPasswordResetEmail(auth, String(email).trim());
}

export async function signOut() {
  return fbSignOut(auth);
}

/** Guarda de sessão: resolve com o usuário atual (ou null). */
export function currentUser() {
  return new Promise((resolve) => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      unsubscribe();
      resolve(user);
    });
  });
}

/** Assinatura contínua do estado de sessão. */
export function onSessionChange(callback) {
  return onAuthStateChanged(auth, callback);
}
