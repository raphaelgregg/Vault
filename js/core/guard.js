/**
 * Guarda de sessão das páginas internas.
 * Sem usuário autenticado, redireciona para o login preservando o destino.
 */
import { currentUser } from '../services/auth.js';
import { configMissing } from '../firebase/client.js';

const LOGIN_URL = '../index.html';

export async function requireSession() {
  if (configMissing) {
    redirectWithReason('config');
    return null;
  }
  const user = await currentUser();
  if (!user) {
    redirectWithReason('auth');
    return null;
  }
  return user;
}

function redirectWithReason(reason) {
  const target = new URL(LOGIN_URL, window.location.href);
  target.searchParams.set('reason', reason);
  target.searchParams.set('next', window.location.pathname.split('/').pop() || 'dashboard.html');
  window.location.replace(target.toString());
}

export async function redirectIfAuthenticated() {
  const user = await currentUser();
  if (user) window.location.replace('pages/dashboard.html');
  return user;
}
