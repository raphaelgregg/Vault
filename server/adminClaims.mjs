/**
 * Promoção/revogação de administradores (VF-2-03aa) — lógica de SERVIDOR (Node, sem dependências).
 *
 * Por que existe: `customUserClaims` só podem ser gravadas com privilégio administrativo (Admin SDK / API
 * administrativa do Identity Toolkit); o cliente NUNCA pode se auto-promover. Esta função roda na Vercel
 * (`api/admin-claims.mjs`), com a service account guardada APENAS em variável de ambiente do servidor.
 *
 * Fluxo (defesa em camadas):
 *  1. o chamador envia o ID token (`Authorization: Bearer`); o servidor o valida E lê o estado ATUAL do usuário em
 *     `accounts:lookup` (a claim `admin` é conferida no servidor, não só no token que pode estar velho);
 *  2. só `admin === true` passa (403 caso contrário, sem tocar em nada);
 *  3. o alvo é resolvido por uid OU e-mail; as demais claims do alvo são preservadas;
 *  4. `accounts:update` grava `customAttributes` com `admin: true` (promover) ou sem `admin` (revogar);
 *  5. um administrador não revoga a PRÓPRIA claim (evita ficar sem administradores).
 *
 * Variáveis de ambiente (servidor): `FIREBASE_SERVICE_ACCOUNT` (JSON ou base64 do JSON da service account),
 * opcional `FIREBASE_PROJECT_ID` (padrão: o do app) e `FIREBASE_WEB_API_KEY` (padrão: a chave pública do app).
 * Em emulador (`FIREBASE_AUTH_EMULATOR_HOST`) não há service account: usa `Bearer owner` como o Admin SDK.
 * O token de acesso e a chave privada NUNCA são retornados nem registrados.
 */
import { createSign } from 'node:crypto';
import { firebaseConfig } from '../js/firebase/config.js';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const MAX_TARGET = 128;

const json = (status, body) => ({ status, body });
const fail = (status, error, message) => json(status, { ok: false, error, message });

const b64url = (input) => Buffer.from(input).toString('base64url');

/** JWT RS256 (grant de service account). Puro/determinístico dado `now` — testável com chave gerada. */
export function signServiceAccountJwt(account, now = Date.now(), sign = null) {
  const iat = Math.floor(now / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({ iss: account.client_email, scope: SCOPE, aud: TOKEN_URL, iat, exp: iat + 3600 }));
  const unsigned = `${header}.${claims}`;
  const signer = createSign('RSA-SHA256');
  signer.update(unsigned);
  const signature = (sign ?? ((data) => signer.sign(account.private_key, 'base64url')))(unsigned);
  return `${unsigned}.${signature}`;
}

/** Lê a service account do ambiente (JSON ou base64). Retorna null se ausente/ inválida. */
export function readServiceAccount(env) {
  const raw = env?.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) return null;
  for (const text of [raw, Buffer.from(raw, 'base64').toString('utf8')]) {
    try {
      const parsed = JSON.parse(text);
      if (parsed?.client_email && parsed?.private_key) return parsed;
    } catch { /* tenta a próxima forma */ }
  }
  return null;
}

let cachedToken = null; // { value, exp } — por instância da função

/** Limpa o cache do token (testes). */
export function resetAdminClaimsCache() {
  cachedToken = null;
}

/** Token OAuth2 do servidor (service account) ou `owner` no emulador. */
async function serverToken({ env, fetch, now }) {
  if (env.FIREBASE_AUTH_EMULATOR_HOST) return { token: 'owner', base: `http://${env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com` };
  const account = readServiceAccount(env);
  if (!account) return null;
  if (cachedToken && cachedToken.exp > now() + 60000 && cachedToken.email === account.client_email) {
    return { token: cachedToken.value, base: 'https://identitytoolkit.googleapis.com' };
  }
  const assertion = signServiceAccountJwt(account, now());
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
  });
  if (!res.ok) throw new Error(`token_exchange_failed:${res.status}`);
  const data = await res.json();
  cachedToken = { value: data.access_token, exp: now() + (Number(data.expires_in) || 3600) * 1000, email: account.client_email };
  return { token: data.access_token, base: 'https://identitytoolkit.googleapis.com' };
}

const parseClaims = (user) => {
  try { return JSON.parse(user?.customAttributes || '{}') ?? {}; } catch { return {}; }
};

/**
 * Processa o pedido. `request`: { method, headers, body } (body = string JSON ou objeto).
 * `deps`: { env, fetch, now } injetáveis. Retorna { status, body } — nunca lança por erro do chamador.
 */
export async function handleAdminClaims(request, { env = process.env, fetch = globalThis.fetch, now = Date.now } = {}) {
  if (request?.method !== 'POST') return fail(405, 'method_not_allowed', 'Use POST.');
  const auth = String(request.headers?.authorization ?? request.headers?.Authorization ?? '');
  const idToken = /^Bearer\s+(\S+)$/i.exec(auth)?.[1];
  if (!idToken) return fail(401, 'missing_token', 'Envie o ID token no cabeçalho Authorization: Bearer.');

  let body = request.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = null; } }
  const target = typeof body?.target === 'string' ? body.target.trim() : '';
  if (!target || target.length > MAX_TARGET || typeof body?.admin !== 'boolean') {
    return fail(400, 'invalid_body', 'Informe `target` (uid ou e-mail) e `admin` (true/false).');
  }

  const projectId = env.FIREBASE_PROJECT_ID || firebaseConfig.projectId;
  const apiKey = env.FIREBASE_WEB_API_KEY || firebaseConfig.apiKey;
  const emulator = Boolean(env.FIREBASE_AUTH_EMULATOR_HOST);
  const publicBase = emulator ? `http://${env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com` : 'https://identitytoolkit.googleapis.com';

  // 1) Quem chama: token válido + estado ATUAL no servidor.
  let caller;
  try {
    const res = await fetch(`${publicBase}/v1/accounts:lookup?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ idToken }),
    });
    if (!res.ok) return fail(401, 'invalid_token', 'Sessão inválida ou expirada. Entre novamente.');
    caller = (await res.json())?.users?.[0];
  } catch {
    return fail(502, 'auth_unreachable', 'Não foi possível validar a sessão agora.');
  }
  if (!caller?.localId) return fail(401, 'invalid_token', 'Sessão inválida ou expirada. Entre novamente.');
  if (caller.disabled) return fail(403, 'disabled', 'Conta desativada.');
  if (parseClaims(caller).admin !== true) return fail(403, 'forbidden', 'Apenas administradores podem alterar administradores.');

  // 2) Credencial do servidor.
  let creds;
  try {
    creds = await serverToken({ env, fetch, now });
  } catch {
    return fail(502, 'server_credential_failed', 'Falha ao obter a credencial administrativa do servidor.');
  }
  if (!creds) return fail(501, 'not_configured', 'Servidor sem FIREBASE_SERVICE_ACCOUNT: a promoção não está configurada.');
  const admin = (path) => `${creds.base}/v1/projects/${encodeURIComponent(projectId)}/${path}`;
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${creds.token}` };

  // 3) Alvo por uid ou e-mail.
  let targetUser;
  try {
    const query = target.includes('@') ? { email: [target.toLowerCase()] } : { localId: [target] };
    const res = await fetch(admin('accounts:lookup'), { method: 'POST', headers, body: JSON.stringify(query) });
    if (!res.ok) return fail(502, 'lookup_failed', 'Falha ao consultar o usuário alvo.');
    targetUser = (await res.json())?.users?.[0];
  } catch {
    return fail(502, 'lookup_failed', 'Falha ao consultar o usuário alvo.');
  }
  if (!targetUser?.localId) return fail(404, 'target_not_found', 'Usuário alvo não encontrado.');
  if (body.admin === false && targetUser.localId === caller.localId) {
    return fail(400, 'self_revoke', 'Você não pode revogar a própria claim de administrador (peça a outro administrador).');
  }

  // 4) Grava as claims preservando as demais.
  const claims = parseClaims(targetUser);
  const previousAdmin = claims.admin === true;
  if (body.admin) claims.admin = true; else delete claims.admin;
  try {
    const res = await fetch(admin('accounts:update'), {
      method: 'POST', headers, body: JSON.stringify({ localId: targetUser.localId, customAttributes: JSON.stringify(claims) }),
    });
    if (!res.ok) return fail(502, 'update_failed', 'Falha ao gravar a claim do usuário.');
  } catch {
    return fail(502, 'update_failed', 'Falha ao gravar a claim do usuário.');
  }
  console.info(JSON.stringify({ event: 'admin_claim_changed', by: caller.localId, target: targetUser.localId, admin: body.admin, previousAdmin }));
  return json(200, {
    ok: true,
    target: { uid: targetUser.localId, email: targetUser.email ?? null },
    admin: body.admin,
    previousAdmin,
    note: 'O usuário precisa sair e entrar de novo (ou renovar o token) para a claim valer; o token atual pode levar até 1 hora para expirar.',
  });
}
