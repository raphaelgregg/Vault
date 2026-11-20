/**
 * Cliente da Central de validação do sistema (VF-UI-02): `POST /api/validation` com o ID token do administrador.
 * Serviço PRÓPRIO: não usa nem altera `financeApi.js`/`adminClaims.js`. Quem decide o acesso é o SERVIDOR (claim `admin`
 * no token + claim atual da conta); a interface apenas esconde a seção para quem não é administrador.
 */
import { auth } from '../firebase/client.js';

export const VALIDATION_ENDPOINT = '/api/validation';
export const VALIDATION_CONFIRM = Object.freeze({ seed: 'POPULAR DEMONSTRACAO', cleanup: 'REMOVER DEMONSTRACAO' });

export class ValidationApiError extends Error {
  constructor({ status = 0, code = 'NETWORK_ERROR', message = 'Falha de comunicação com o servidor.' } = {}) {
    super(message);
    this.name = 'ValidationApiError';
    this.status = status;
    this.code = code;
  }
}

/** Chama uma operação (`status` | `seed` | `audit` | `cleanup`). Resolve com o corpo `{ ok:true, … }`; rejeita com `ValidationApiError`. */
export async function callValidation(op, extra = {}, options = {}) {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const getToken = options.getToken ?? (async () => { const u = auth.currentUser; if (!u) throw new ValidationApiError({ status: 401, code: 'UNAUTHENTICATED', message: 'Sessão expirada: entre novamente.' }); return u.getIdToken(true); });
  let response;
  try {
    response = await fetchImpl(options.endpoint ?? VALIDATION_ENDPOINT, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${await getToken()}` }, body: JSON.stringify({ op, ...extra }),
    });
  } catch (error) {
    if (error instanceof ValidationApiError) throw error;
    throw new ValidationApiError({ code: 'NETWORK_ERROR', message: 'Sem conexão com o servidor.' });
  }
  const body = await response.json().catch(() => ({}));
  if (response.ok && body.ok) return body;
  throw new ValidationApiError({ status: response.status, code: body.error ?? 'HTTP_ERROR', message: body.message ?? `Erro ${response.status} do servidor.` });
}
