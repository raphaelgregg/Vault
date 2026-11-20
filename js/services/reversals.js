/**
 * Estornos (VF-ARQ-02): correção de lançamentos liquidados por LANÇAMENTO COMPENSATÓRIO, feita pelo servidor.
 * O documento original é preservado; o estorno referencia o original (`reversals/{coleção}_{id}`), registra o motivo,
 * ajusta saldos/status atomicamente, não pode ser duplicado e deixa trilha de auditoria. O cliente só pede e mostra.
 */
import { COLLECTIONS } from '../utils/constants.js';
import { list } from './firestore.js';
import { financeResult } from './financeApi.js';

/** Tipos estornáveis → rótulo para a interface. */
export const REVERSAL_KINDS = Object.freeze({
  income: 'receita recebida',
  expense: 'despesa paga',
  transfer: 'transferência confirmada',
  invoice: 'fatura paga',
  debtPayment: 'recebimento de devedor',
  goalTransaction: 'movimentação de meta',
});

/**
 * Estorna um lançamento. `rawData`: { reason (3–300), date? (AAAA-MM-DD), operationId? }. Retorna { ok, reversalId,
 * amountCents, errors, code } — erros reais do servidor (ex.: ALREADY_REVERSED, INSUFFICIENT_BALANCE) sem tradução.
 */
export async function createReversal(uid, kind, targetId, rawData = {}, io = {}) {
  if (!REVERSAL_KINDS[kind]) return { ok: false, errors: { _form: 'Tipo de lançamento não estornável.' } };
  const reason = String(rawData.reason ?? '').trim();
  if (reason.length < 3) return { ok: false, errors: { reason: 'Informe o motivo do estorno (mínimo 3 caracteres).' } };
  if (reason.length > 300) return { ok: false, errors: { reason: 'O motivo deve ter no máximo 300 caracteres.' } };
  const r = await (io.finance ?? financeResult)('reversal.create', {
    kind, targetId, reason, ...(rawData.date ? { date: rawData.date } : {}),
  }, { operationId: rawData.operationId, ...(io.apiOptions ?? {}) });
  return r.ok ? { ok: true, reversalId: r.reversalId, amountCents: r.amountCents, result: r } : r;
}

/** Lista os estornos do usuário (mais recentes primeiro). */
export async function listReversals(uid, options = {}, io = {}) {
  return (io.list ?? list)(uid, COLLECTIONS.reversals, { orderBy: ['createdAt', 'desc'], ...(options.limit ? { limit: options.limit } : {}), ...(options.where ? { where: options.where } : {}) });
}
