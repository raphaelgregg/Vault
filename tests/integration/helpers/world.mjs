/** Fixtures e leitura independente (oráculo) para os testes de integração com o emulador. */
import { createAccount } from '../../../js/services/accounts.js';
import { createDebtor } from '../../../js/services/debtors.js';
import { createDebtPlan } from '../../../js/services/debtPayments.js';
import { loadBalances } from '../../../js/services/balances.js';
import { dump, ALICE } from './real-io.mjs';

export const MONTH = '2026-12';
export const NOW = () => new Date('2026-12-05T15:00:00Z');

export async function seedAccount(io, initial = '1.000,00', institution = 'Banco') {
  const r = await createAccount(ALICE, { institution, name: 'Conta', type: 'checking', initialBalanceCents: initial, color: '#000', status: 'active' }, io);
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.id;
}

export async function seedDebtor(io, name = 'Renan') {
  const r = await createDebtor(ALICE, { name, lentCents: '0,00', loanDate: '2026-12-01' }, io);
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.id;
}

/** Dívida em `installments` parcelas (a 1ª vence em 10/12/2026). Retorna { ids, groupId }. */
export async function seedPlan(io, debtorId, totalCents, installments, description = 'Dívida') {
  const r = await createDebtPlan(ALICE, { debtorId, description, totalCents, installments, firstDueDate: '2026-12-10' }, io);
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return { ...r, ids: r.ids.slice(0, installments) }; // `ids` inclui a escrita do devedor no fim do lote
}

/**
 * ORÁCULO INDEPENDENTE: lê os documentos crus (sem passar pelos services) e recalcula, com laços simples, os valores
 * que a aplicação deriva. Serve para comparar com `accountBalances`, dashboard e totais gravados.
 */
export async function oracle(env, { accountId, debtorId } = {}) {
  const [accounts, payments, debts, debtors, purchases] = await Promise.all(
    ['accounts', 'debtPayments', 'debts', 'debtors', 'cardPurchases'].map((c) => dump(env, c)),
  );
  const acc = accounts.find((a) => a.id === accountId);
  const mine = payments.filter((p) => !debtorId || p.debtorId === debtorId);
  const receivedByInstallment = {};
  for (const p of payments) {
    const k = p.debtId ?? p.purchaseId;
    receivedByInstallment[k] = (receivedByInstallment[k] ?? 0) + p.amountCents;
  }
  const debtor = debtors.find((d) => d.id === debtorId);
  return {
    payments, debts, debtor, purchases, receivedByInstallment,
    sumPayments: mine.reduce((t, p) => t + p.amountCents, 0),
    // saldo da conta = abertura + Σ recebimentos nela (cenários de devedores não têm outros movimentos)
    balance: acc ? acc.initialBalanceCents + payments.filter((p) => p.accountId === accountId).reduce((t, p) => t + p.amountCents, 0) : null,
    lent: debtor?.lentCents, received: debtor?.receivedCents,
    pending: debtor ? debtor.lentCents - debtor.receivedCents : null,
  };
}

export async function derivedBalance(io, accountId) {
  const accounts = await io.list(ALICE, 'accounts', {});
  const r = await loadBalances(ALICE, accounts, { list: io.list });
  return r.balances.get(accountId);
}
