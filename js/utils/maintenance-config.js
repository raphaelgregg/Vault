/**
 * Acesso ao painel de manutenção (VF-2-03u). É uma TRAVA DE INTERFACE, não segurança: a segurança real são as
 * Firestore Rules (cada usuário só enxerga/altera `users/{uid}/…` do próprio uid). Libera: (a) ambiente local /
 * emulador (localhost, 127.0.0.1) e (b) e-mails da lista abaixo. Em produção a lista nasce VAZIA — para liberar
 * o painel, o dono inclui o próprio e-mail aqui (nunca commite e-mail de terceiros).
 */
export const MAINTENANCE_ALLOWED_EMAILS = Object.freeze([]);

const LOCAL_HOSTS = Object.freeze(['localhost', '127.0.0.1', '[::1]']);

/** Puro: `hostname` e `email` vêm do chamador. */
export function isMaintenanceAuthorized({ email, hostname } = {}, allowed = MAINTENANCE_ALLOWED_EMAILS) {
  if (LOCAL_HOSTS.includes(String(hostname ?? '').toLowerCase())) return true;
  const mail = String(email ?? '').trim().toLowerCase();
  return mail !== '' && allowed.some((a) => String(a).trim().toLowerCase() === mail);
}

/** Frases de confirmação digitadas (reforço contra clique acidental). */
export const CONFIRM_PHRASES = Object.freeze({
  user: 'LIMPAR MEUS DADOS',
  database: 'LIMPAR BANCO INTEIRO',
  reset: 'RESETAR E GERAR',
});
