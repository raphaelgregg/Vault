/**
 * Função da Vercel: POST /api/validation — Central de validação do sistema (VF-UI-02). SOMENTE administradores.
 * Endpoint próprio e isolado: não altera `/api/finance` nem `/api/admin-claims`. Credencial: `FIREBASE_SERVICE_ACCOUNT`.
 */
import { handleValidation } from '../server/validation/center.mjs';

export default async function handler(req, res) {
  const result = await handleValidation({ method: req.method, headers: req.headers, body: req.body });
  res.setHeader('Cache-Control', 'no-store');
  res.status(result.status).json(result.body);
}
