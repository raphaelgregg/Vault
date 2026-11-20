/**
 * Função da Vercel: POST /api/finance — processamento financeiro confiável (VF-ARQ-02).
 * Toda a lógica está em `server/finance/` (Admin SDK + transações). Aqui só se adapta req/res.
 * Credencial do servidor: variável `FIREBASE_SERVICE_ACCOUNT` (nunca no navegador).
 */
import { handleFinance } from '../server/finance/index.mjs';

export default async function handler(req, res) {
  const result = await handleFinance({ method: req.method, headers: req.headers, body: req.body });
  res.setHeader('Cache-Control', 'no-store');
  res.status(result.status).json(result.body);
}
