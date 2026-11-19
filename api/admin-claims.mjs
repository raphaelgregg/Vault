/**
 * Função da Vercel: POST /api/admin-claims — promove/revoga administradores (VF-2-03aa).
 * Toda a lógica e as garantias de segurança estão em `server/adminClaims.mjs`; aqui só se adapta req/res.
 */
import { handleAdminClaims } from '../server/adminClaims.mjs';

export default async function handler(req, res) {
  const result = await handleAdminClaims({ method: req.method, headers: req.headers, body: req.body });
  res.setHeader('Cache-Control', 'no-store');
  res.status(result.status).json(result.body);
}
