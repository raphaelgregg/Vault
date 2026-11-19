/**
 * Cliente da promoção/revogação de administradores (VF-2-03aa). O cliente NUNCA grava claims: chama a função
 * de servidor `POST /api/admin-claims` (que valida o administrador no servidor e usa a service account), e
 * depois registra a ação no auditLog do próprio executor (create-only). Só a interface de quem tem
 * `admin === true` exibe isto; a barreira real é o servidor.
 */
import { writeAudit } from './firestore.js';

export const ADMIN_CLAIMS_ENDPOINT = '/api/admin-claims';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Valida o alvo digitado: e-mail válido OU uid (sem espaços, ≤ 128). Retorna { ok, target, kind, error }. */
export function parseAdminTarget(text) {
  const target = String(text ?? '').trim();
  if (!target) return { ok: false, error: 'Informe o uid ou o e-mail do usuário.' };
  if (target.length > 128) return { ok: false, error: 'Valor longo demais.' };
  if (target.includes('@')) return EMAIL.test(target) ? { ok: true, target: target.toLowerCase(), kind: 'email' } : { ok: false, error: 'E-mail inválido.' };
  if (/\s/.test(target)) return { ok: false, error: 'O uid não pode conter espaços.' };
  return { ok: true, target, kind: 'uid' };
}

const ERROR_MESSAGES = {
  missing_token: 'Sessão ausente. Entre novamente.',
  invalid_token: 'Sessão inválida ou expirada. Entre novamente.',
  forbidden: 'Apenas administradores podem alterar administradores.',
  disabled: 'Sua conta está desativada.',
  target_not_found: 'Usuário alvo não encontrado (confira o uid/e-mail; ele precisa ter conta).',
  self_revoke: 'Você não pode revogar a sua própria claim de administrador; peça a outro administrador.',
  invalid_body: 'Dados inválidos.',
  not_configured: 'O servidor ainda não está configurado para administrar usuários (falta FIREBASE_SERVICE_ACCOUNT na Vercel).',
  bad_service_account: 'A credencial FIREBASE_SERVICE_ACCOUNT da Vercel está em formato inválido (veja os logs da função).',
  server_credential_failed: 'O Google recusou a credencial do servidor (veja os logs da função na Vercel).',
  auth_unreachable: 'Não foi possível validar a sessão agora. Tente novamente.',
  lookup_failed: 'Falha ao consultar o Firebase Auth. Tente novamente.',
  list_failed: 'Falha ao listar os usuários. Tente novamente.',
  method_not_allowed: 'Método não permitido.',
};

/**
 * Promove (`admin: true`) ou revoga (`admin: false`). `io`: fetch, writeAudit injetáveis.
 * Retorna { ok, target?, admin?, previousAdmin?, note?, error?, status?, auditError? }.
 */
export async function setAdminClaim(user, { target, admin }, io = {}) {
  const parsed = parseAdminTarget(target);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  if (typeof admin !== 'boolean') return { ok: false, error: 'Ação inválida.' };
  if (!user?.uid || typeof user.getIdToken !== 'function') return { ok: false, error: 'Sessão necessária.' };

  let response;
  try {
    const idToken = await user.getIdToken();
    response = await (io.fetch ?? globalThis.fetch)(ADMIN_CLAIMS_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${idToken}` },
      body: JSON.stringify({ target: parsed.target, admin }),
    });
  } catch {
    return { ok: false, error: 'Sem conexão com o servidor. Tente novamente.' };
  }
  let data = null;
  try { data = await response.json(); } catch { data = null; }
  if (!response.ok || !data?.ok) {
    const code = data?.error;
    return { ok: false, status: response.status, error: ERROR_MESSAGES[code] ?? data?.message ?? `Falha na operação (HTTP ${response.status}).` };
  }
  const result = { ok: true, target: data.target, admin: data.admin, previousAdmin: data.previousAdmin, note: data.note };
  const audit = await (io.writeAudit ?? writeAudit)(user.uid, {
    action: admin ? 'maintenance_admin_grant' : 'maintenance_admin_revoke',
    collection: 'maintenance',
    docId: data.target.uid,
    after: { adminUid: user.uid, targetUid: data.target.uid, targetEmail: data.target.email ?? null, admin: data.admin, previousAdmin: data.previousAdmin },
  });
  if (audit?.ok === false) result.auditError = String(audit.error?.message ?? audit.error ?? 'falha ao gravar');
  return result;
}

/** Mensagem amigável para uma resposta de erro do servidor. */
const failure = (response, data) => ({
  ok: false,
  status: response.status,
  error: ERROR_MESSAGES[data?.error] ?? data?.message ?? `Falha na operação (HTTP ${response.status}).`,
});

/**
 * Lista usuários e administradores (`GET /api/admin-claims`, só administrador — validado no servidor).
 * Retorna { ok, users, total, truncated, me } ou { ok: false, error, status }. `io.fetch` injetável.
 */
export async function listAdminUsers(user, io = {}) {
  if (!user?.uid || typeof user.getIdToken !== 'function') return { ok: false, error: 'Sessão necessária.' };
  let response;
  try {
    const idToken = await user.getIdToken();
    response = await (io.fetch ?? globalThis.fetch)(ADMIN_CLAIMS_ENDPOINT, { method: 'GET', headers: { authorization: `Bearer ${idToken}` } });
  } catch {
    return { ok: false, error: 'Sem conexão com o servidor. Tente novamente.' };
  }
  let data = null;
  try { data = await response.json(); } catch { data = null; }
  if (!response.ok || !data?.ok || !Array.isArray(data.users)) return failure(response, data);
  return { ok: true, users: data.users, total: data.total ?? data.users.length, truncated: Boolean(data.truncated), me: data.me ?? user.uid };
}

/**
 * Linhas da tabela de usuários (puro): administradores primeiro, depois os demais (e-mail). `action` = ação rápida:
 * 'revoke' (admin), 'grant' (não admin); `null` para a própria conta (não se revoga) e contas desativadas.
 */
export function buildAdminUserRows(users = [], meUid = null) {
  const rows = users.map((u) => ({
    uid: u.uid,
    email: u.email ?? null,
    label: u.email ?? u.displayName ?? u.uid,
    displayName: u.displayName ?? null,
    disabled: Boolean(u.disabled),
    admin: Boolean(u.admin),
    isMe: u.uid === meUid,
    action: u.uid === meUid ? null : u.admin ? 'revoke' : u.disabled ? null : 'grant',
  }));
  rows.sort((a, b) => Number(b.admin) - Number(a.admin) || String(a.label).localeCompare(String(b.label)));
  return { rows, admins: rows.filter((r) => r.admin).length, others: rows.filter((r) => !r.admin).length };
}
