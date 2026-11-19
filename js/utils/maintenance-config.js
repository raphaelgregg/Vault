/**
 * Acesso ao painel de manutenção (VF-2-03z): QUALQUER usuário autenticado abre `/manutencao-dados` — sem lista de
 * e-mails e sem checagem de host (nenhum e-mail fica no bundle público). O que cada um pode fazer é decidido por
 * escopo, e a barreira real são as Firestore Rules:
 *  - usuário comum: só o PRÓPRIO uid — limpar meus dados, massa de testes, importar/exportar (as Rules negam
 *    qualquer acesso a outro uid);
 *  - administrador (claim de token `admin === true`, definida só pelo Admin SDK): além disso vê e executa
 *    "limpar usuário específico" e "limpar banco inteiro" (a interface esconde; as Rules exigem `isAdmin()`).
 */

/** Frases de confirmação digitadas (reforço contra clique acidental). */
export const CONFIRM_PHRASES = Object.freeze({
  user: 'LIMPAR MEUS DADOS',
  target: 'LIMPAR USUARIO ALVO',
  database: 'LIMPAR BANCO INTEIRO',
  reset: 'RESETAR E GERAR',
  grantAdmin: 'PROMOVER ADMIN',
  revokeAdmin: 'REVOGAR ADMIN',
});

/** Puro: qualquer usuário autenticado (com `uid`) acessa o painel. Sessão ausente = sem acesso. */
export function canAccessMaintenance(user) {
  return Boolean(user) && typeof user.uid === 'string' && user.uid.trim() !== '';
}
