/**
 * Auditoria de integridade financeira — PURA (sem DOM, sem rede, sem gravação). Recalcula, com laços simples e
 * independentes de `accountBalances`/dashboard, o que os documentos persistidos implicam e COMPARA com os valores
 * gravados (agregados do devedor, status de parcelas/devedores/faturas) e derivados. Não corrige nada: apenas
 * relata diferenças (`findings`) com código, gravidade e ids. Dinheiro em centavos inteiros.
 *
 * Gravidade: `error` = dinheiro/estado incorreto; `warning` = estado suspeito ou recuperável.
 */
import { accountBalances, orphanMovements } from './model.js';

const n = (v) => Number(v) || 0;
const sum = (rows, pick) => rows.reduce((t, r) => t + n(pick(r)), 0);

export function auditLedgerData({
  accounts = [], debtors = [], debts = [], payments = [], purchases = [], invoices = [], transfers = [],
  incomes = [], expenses = [], goalTransactions = [], reversals = [],
} = {}) {
  // Recebimentos estornados continuam no histórico, mas não contam (nem no saldo nem no recebido do devedor).
  const reversedPayments = new Set(reversals.filter((r) => r.targetCollection === 'debtPayments').map((r) => r.targetId));
  const allPayments = payments;
  payments = payments.filter((p) => !reversedPayments.has(p.id));
  const findings = [];
  const add = (code, severity, message, extra = {}) => findings.push({ code, severity, message, ...extra });
  const accountIds = new Set(accounts.map((a) => a.id));
  const debtorById = new Map(debtors.map((d) => [d.id, d]));
  const debtById = new Map(debts.map((d) => [d.id, d]));
  const purchaseById = new Map(purchases.map((p) => [p.id, p]));

  // ---- recebimentos (debtPayments) ----------------------------------------------------------------------------
  const byInstallment = new Map();
  const byDebtor = new Map();
  const opKeys = new Map();
  for (const p of payments) {
    if (!(n(p.amountCents) > 0) || !Number.isInteger(p.amountCents)) add('PAYMENT_INVALID_AMOUNT', 'error', `Recebimento ${p.id} com valor inválido (${p.amountCents}).`, { paymentId: p.id });
    const hasDebt = Boolean(p.debtId);
    const hasPurchase = Boolean(p.purchaseId);
    if (hasDebt === hasPurchase) add('PAYMENT_BAD_TARGET', 'error', `Recebimento ${p.id} deve apontar para exatamente UMA parcela (debtId XOR purchaseId).`, { paymentId: p.id });
    const key = p.debtId ?? p.purchaseId;
    byInstallment.set(key, n(byInstallment.get(key)) + n(p.amountCents));
    byDebtor.set(p.debtorId, n(byDebtor.get(p.debtorId)) + n(p.amountCents));
    const target = hasDebt ? debtById.get(p.debtId) : purchaseById.get(p.purchaseId);
    if (!target) add(hasDebt ? 'PAYMENT_ORPHAN_DEBT' : 'PAYMENT_ORPHAN_PURCHASE', 'error', `Recebimento ${p.id} aponta para parcela inexistente (${key}).`, { paymentId: p.id });
    else if (target.debtorId !== p.debtorId) add('PAYMENT_DEBTOR_MISMATCH', 'error', `Recebimento ${p.id}: devedor do recebimento difere do devedor da parcela.`, { paymentId: p.id });
    if (!debtorById.has(p.debtorId)) add('PAYMENT_ORPHAN_DEBTOR', 'error', `Recebimento ${p.id} aponta para devedor inexistente.`, { paymentId: p.id });
    if (!accountIds.has(p.accountId)) add('PAYMENT_ORPHAN_ACCOUNT', 'error', `Recebimento ${p.id} aponta para conta inexistente: o valor não entra em nenhum saldo.`, { paymentId: p.id, amountCents: p.amountCents });
    if (p.operationId) {
      const k = `${p.operationId}|${key}`;
      if (opKeys.has(k)) add('DUPLICATE_OPERATION', 'error', `Operação ${p.operationId} gravou mais de um recebimento para a mesma parcela (${opKeys.get(k)}, ${p.id}).`, { paymentId: p.id, operationId: p.operationId });
      opKeys.set(k, p.id);
    }
  }

  // ---- parcelas ----------------------------------------------------------------------------------------------------
  for (const d of debts) {
    const received = n(byInstallment.get(d.id));
    const principal = n(d.principalCents);
    if (received > principal) add('INSTALLMENT_OVERPAID', 'error', `Parcela ${d.id} recebeu ${received} de ${principal} (acima do valor).`, { debtId: d.id, receivedCents: received, principalCents: principal });
    if (d.status === 'paid' && received < principal) add('DEBT_PAID_BUT_REMAINING', 'error', `Parcela ${d.id} está "paga" mas restam ${principal - received}.`, { debtId: d.id });
    if (['pending', 'late'].includes(d.status) && received >= principal && principal > 0) add('DEBT_PENDING_BUT_FULLY_RECEIVED', 'warning', `Parcela ${d.id} totalmente recebida mas ainda "${d.status}".`, { debtId: d.id });
    if (!debtorById.has(d.debtorId)) add('DEBT_ORPHAN_DEBTOR', 'error', `Parcela ${d.id} aponta para devedor inexistente.`, { debtId: d.id });
  }
  for (const p of purchases.filter((x) => x.debtorId)) {
    const received = n(byInstallment.get(p.id));
    if (received > n(p.amountCents)) add('INSTALLMENT_OVERPAID', 'error', `Parcela de cartão ${p.id} recebeu ${received} de ${p.amountCents}.`, { purchaseId: p.id });
    if (!debtorById.has(p.debtorId)) add('PURCHASE_ORPHAN_DEBTOR', 'error', `Compra ${p.id} vinculada a devedor inexistente.`, { purchaseId: p.id });
  }

  // ---- devedores: agregados gravados × soma dos recebimentos ------------------------------------------------------
  for (const d of debtors) {
    const sumPayments = n(byDebtor.get(d.id));
    const lent = n(d.lentCents);
    const received = n(d.receivedCents);
    if (received !== sumPayments) add('DEBTOR_RECEIVED_MISMATCH', 'error', `Devedor ${d.name ?? d.id}: recebido gravado ${received} ≠ soma dos recebimentos ${sumPayments}.`, { debtorId: d.id, storedCents: received, ledgerCents: sumPayments });
    if (received > lent) add('DEBTOR_RECEIVED_ABOVE_LENT', 'error', `Devedor ${d.name ?? d.id}: recebido ${received} acima do emprestado ${lent} (saldo devedor negativo).`, { debtorId: d.id });
    if (d.status === 'open' && lent > 0 && received >= lent) add('DEBTOR_STATUS_OPEN_WITH_ZERO_PENDING', 'warning', `Devedor ${d.name ?? d.id} em aberto com pendente zero (recuperável por conciliação).`, { debtorId: d.id });
    if (d.status === 'paid' && received < lent) add('DEBTOR_STATUS_PAID_WITH_PENDING', 'error', `Devedor ${d.name ?? d.id} "quitado" mas pendente ${lent - received}.`, { debtorId: d.id });
    const listed = sum(debts.filter((x) => x.debtorId === d.id && x.status !== 'cancelled'), (x) => x.principalCents)
      + sum(purchases.filter((x) => x.debtorId === d.id), (x) => x.amountCents);
    if (listed > lent) add('DEBTOR_LENT_BELOW_LISTED', 'error', `Devedor ${d.name ?? d.id}: emprestado ${lent} menor que as parcelas listadas ${listed}.`, { debtorId: d.id });
  }

  // ---- faturas de cartão ------------------------------------------------------------------------------------------
  for (const inv of invoices) {
    const own = purchases.filter((p) => p.invoiceId === inv.id);
    if (inv.status === 'paid') {
      if (!inv.accountId) add('INVOICE_PAID_WITHOUT_ACCOUNT', 'error', `Fatura ${inv.id} paga sem conta: o pagamento não debita nenhum saldo.`, { invoiceId: inv.id });
      else if (!accountIds.has(inv.accountId)) add('INVOICE_PAID_ORPHAN_ACCOUNT', 'error', `Fatura ${inv.id} paga com conta inexistente.`, { invoiceId: inv.id });
      if (n(inv.paidCents) !== n(inv.totalCents)) add('INVOICE_PAID_AMOUNT_MISMATCH', 'warning', `Fatura ${inv.id}: pago ${inv.paidCents} ≠ total ${inv.totalCents}.`, { invoiceId: inv.id });
    }
    if (inv.status === 'closed' && n(inv.totalCents) !== sum(own, (p) => p.amountCents)) add('INVOICE_CLOSED_TOTAL_MISMATCH', 'warning', `Fatura fechada ${inv.id}: total ${inv.totalCents} ≠ soma das compras ${sum(own, (p) => p.amountCents)}.`, { invoiceId: inv.id });
  }

  // ---- transferências ---------------------------------------------------------------------------------------------
  for (const t of transfers) {
    if (t.fromAccountId === t.toAccountId) add('TRANSFER_SAME_ACCOUNT', 'error', `Transferência ${t.id} com origem = destino.`, { transferId: t.id });
    if (t.status === 'confirmed' && (!accountIds.has(t.fromAccountId) || !accountIds.has(t.toAccountId))) add('TRANSFER_ORPHAN_ACCOUNT', 'error', `Transferência confirmada ${t.id} com conta inexistente: o dinheiro some/aparece em um lado só.`, { transferId: t.id });
  }

  // ---- saldos e movimentos ----------------------------------------------------------------------------------------
  const movements = { incomes, expenses, transfers, debtPayments: allPayments, goalTransactions, invoices, reversals };
  const balances = accountBalances(accounts, movements);
  const orphans = orphanMovements(accounts, movements);
  if (orphans.count) add('ORPHAN_MOVEMENTS', 'warning', `${orphans.count} movimentação(ões) apontam para conta inexistente e ficam fora dos saldos.`, { byCollection: orphans.byCollection });
  for (const a of accounts) if ((balances.get(a.id) ?? 0) < 0) add('ACCOUNT_NEGATIVE_BALANCE', 'warning', `Conta ${a.id} com saldo negativo (${balances.get(a.id)}).`, { accountId: a.id, balanceCents: balances.get(a.id) });

  return {
    findings,
    errors: findings.filter((f) => f.severity === 'error').length,
    warnings: findings.filter((f) => f.severity === 'warning').length,
    totals: {
      balances: Object.fromEntries(balances),
      paymentsCents: sum(payments, (p) => p.amountCents),
      debtorsReceivedCents: sum(debtors, (d) => d.receivedCents),
      debtorsLentCents: sum(debtors, (d) => d.lentCents),
    },
  };
}
