/**
 * Massa de testes (VF-2-03u): popula o usuário autenticado com um pacote completo de cenários, usando os
 * PRÓPRIOS services do app (Rules, centavos inteiros, saldo derivado e auditoria). Datas relativas a hoje.
 * Cada etapa é isolada: falha de uma é registrada e as demais continuam (`onLog(step)`).
 * Nomes começam com "Teste" para identificação. `volume` (1–20) multiplica receitas/despesas de volume
 * (paginação, filtros, orçamento de leitura). `io.services` é injetável nos testes.
 */
import { addMonths, clampDayInMonth } from '../core/model.js';
import * as accounts from './accounts.js';
import * as categories from './categories.js';
import * as incomes from './incomes.js';
import * as expenses from './expenses.js';
import * as transfers from './transfers.js';
import * as budgets from './budgets.js';
import * as goals from './goals.js';
import * as cardsSvc from './creditCards.js';
import * as subs from './subscriptions.js';
import * as debtors from './debtors.js';
import * as debtPayments from './debtPayments.js';
import { create } from './firestore.js';

export const MAX_VOLUME = 20;
const VOLUME_PER_STEP = 20; // receitas e despesas por unidade de volume

/** Falha clara quando o service responde { ok:false }. */
function must(result, label) {
  if (result?.ok === false) throw new Error(`${label}: ${Object.values(result.errors ?? {}).join(' · ') || 'rejeitado'}`);
  return result;
}

/**
 * Gera o pacote. Retorna { steps: [{ name, ok, detail?, error? }], ok, failed }.
 * `now` (Date) e `services` são injetáveis. Idempotência NÃO é garantida: rodar duas vezes duplica nomes
 * (use "Resetar + gerar" para um estado limpo).
 */
export async function seedFullTestSuite(uid, { volume = 0, onLog, now = new Date(), services = {} } = {}) {
  const S = { accounts, categories, incomes, expenses, transfers, budgets, goals, cardsSvc, subs, debtors, debtPayments, ...services };
  const iso = (offsetDays) => new Date(now.getTime() + offsetDays * 86400000).toISOString().slice(0, 10);
  const today = iso(0);
  const month = today.slice(0, 7);
  const prev = addMonths(month, -1);
  const prev2 = addMonths(month, -2);
  const steps = [];
  const ctx = {};
  const step = async (name, fn) => {
    const entry = { name, ok: true };
    try {
      entry.detail = await fn();
    } catch (error) {
      entry.ok = false;
      entry.error = `${error?.code ? `${error.code}: ` : ''}${error?.message ?? error}`;
    }
    steps.push(entry);
    onLog?.(entry);
  };

  await step('Contas: corrente, caixinha (meta) e investimento', async () => {
    const mk = async (raw) => must(await S.accounts.createAccount(uid, { color: '#1f7a5c', status: 'active', ...raw }), raw.name).id;
    ctx.main = await mk({ institution: 'Banco Teste', name: 'Teste Conta Corrente', type: 'checking', initialBalanceCents: '5.000,00' });
    ctx.box = await mk({ institution: 'Nubank', name: 'Teste Caixinha', type: 'savings', initialBalanceCents: '0,00' });
    ctx.invest = await mk({ institution: 'Corretora Teste', name: 'Teste Investimentos', type: 'investment', initialBalanceCents: '0,00' });
    return '3 contas';
  });

  await step('Categorias (receita, despesa e assinaturas)', async () => {
    const mk = async (name, kind, color) => must(await S.categories.createCategory(uid, { name, kind, color }), name).id;
    ctx.catSalary = await mk('Teste Salário', 'income', '#1f8a5b');
    ctx.catMarket = await mk('Teste Mercado', 'expense', '#c0392b');
    ctx.catLeisure = await mk('Teste Lazer', 'expense', '#8e44ad');
    ctx.catHome = await mk('Teste Moradia', 'expense', '#2c7be5');
    ctx.catSubs = await mk('Teste Assinaturas', 'expense', '#e67e22');
    return '5 categorias';
  });

  await step('Receitas: recebida e prevista', async () => {
    const paid = must(await S.incomes.createIncome(uid, { description: 'Teste Salário recebido', categoryId: ctx.catSalary, amountCents: '6.000,00', expectedDate: today, accountId: ctx.main, status: 'pending', recurrence: 'none' }), 'receita');
    must(await S.incomes.markIncomeReceived(uid, paid.id, today), 'receber');
    must(await S.incomes.createIncome(uid, { description: 'Teste Freelance previsto', categoryId: ctx.catSalary, amountCents: '1.200,00', expectedDate: clampDayInMonth(month, 28), accountId: ctx.main, status: 'pending', recurrence: 'none' }), 'receita prevista');
    return '1 recebida + 1 prevista';
  });

  await step('Despesas: pagas (base dos orçamentos) e pendente', async () => {
    const pay = async (description, categoryId, amount) => {
      const e = must(await S.expenses.createExpense(uid, { description, categoryId, amountCents: amount, accountId: ctx.main, purchaseDate: today, dueDate: today, status: 'pending', recurrence: 'none' }), description);
      must(await S.expenses.markExpensePaid(uid, e.id, today), description);
    };
    await pay('Teste Supermercado', ctx.catMarket, '500,00');
    await pay('Teste Cinema e jantar', ctx.catLeisure, '340,00');
    await pay('Teste Reforma', ctx.catHome, '360,00');
    must(await S.expenses.createExpense(uid, { description: 'Teste Aluguel a vencer', categoryId: ctx.catHome, amountCents: '1.500,00', accountId: ctx.main, purchaseDate: today, dueDate: iso(5), status: 'pending', recurrence: 'none' }), 'pendente');
    return '3 pagas + 1 pendente';
  });

  await step('Orçamentos: dentro do limite, em atenção (≥80%) e estourado', async () => {
    must(await S.budgets.createBudget(uid, { categoryId: ctx.catMarket, month, limitCents: '1.000,00' }), 'ok 50%');
    must(await S.budgets.createBudget(uid, { categoryId: ctx.catLeisure, month, limitCents: '400,00' }), 'atenção 85%');
    must(await S.budgets.createBudget(uid, { categoryId: ctx.catHome, month, limitCents: '300,00' }), 'estourado 120%');
    return '3 orçamentos';
  });

  await step('Transferências realizadas (corrente → caixinha e investimento) + 1 pendente', async () => {
    const mk = async (to, amount, reason, confirm) => {
      const t = must(await S.transfers.createTransfer(uid, { fromAccountId: ctx.main, toAccountId: to, amountCents: amount, date: today, reason, status: 'pending' }), reason);
      if (confirm) must(await S.transfers.confirmTransfer(uid, t.id), reason);
    };
    await mk(ctx.box, '1.000,00', 'Teste Reserva na caixinha', true);
    await mk(ctx.invest, '800,00', 'Teste Aporte em investimentos', true);
    await mk(ctx.box, '100,00', 'Teste Transferência pendente', false);
    return '2 confirmadas + 1 pendente';
  });

  await step('Metas: duas na mesma caixinha (repartição do saldo) e uma tradicional com aporte', async () => {
    const deadline = iso(365);
    must(await S.goals.createGoal(uid, { name: 'Teste Reserva de emergência', targetCents: '600,00', deadline, accountId: ctx.box }), 'meta 1');
    must(await S.goals.createGoal(uid, { name: 'Teste Viagem', targetCents: '3.000,00', deadline, accountId: ctx.box }), 'meta 2');
    const trad = must(await S.goals.createGoal(uid, { name: 'Teste Notebook', targetCents: '2.000,00', deadline: iso(180) }), 'meta tradicional');
    must(await S.goals.depositToGoal(uid, trad.id, { amountCents: '300,00', date: today, accountId: ctx.main }), 'aporte');
    return 'caixinha R$ 1.000: 600 + 400; tradicional R$ 300';
  });

  await step('Cartões, compras à vista e parceladas, faturas fechada/paga/aberta/cancelada e consolidado', async () => {
    const card = must(await S.cardsSvc.createCard(uid, { name: 'Teste Nubank', brand: 'Mastercard', limitCents: '8.000,00', closingDay: 10, dueDay: 17 }), 'cartão');
    ctx.card = card.id;
    const inter = must(await S.cardsSvc.createCard(uid, { name: 'Teste Inter', brand: 'Visa', limitCents: '2.000,00', closingDay: 10, dueDay: 17 }), 'cartão 2');
    must(await S.cardsSvc.registerCardPurchase(uid, card.id, { description: 'Teste Compra à vista', amountCents: '250,00', purchaseDate: clampDayInMonth(prev, 5), installmentsTotal: 1 }), 'à vista');
    must(await S.cardsSvc.registerCardPurchase(uid, card.id, { description: 'Teste Compra parcelada 3x', amountCents: '900,00', purchaseDate: clampDayInMonth(prev, 5), installmentsTotal: 3 }), 'parcelada');
    must(await S.cardsSvc.closeInvoice(uid, `${card.id}_${prev}`), 'fechar fatura');
    must(await S.cardsSvc.payInvoice(uid, `${card.id}_${prev}`, { accountId: ctx.main, date: today }), 'pagar fatura');
    must(await S.cardsSvc.registerCardPurchase(uid, inter.id, { description: 'Teste Compra fatura fechada', amountCents: '120,00', purchaseDate: clampDayInMonth(prev2, 5), installmentsTotal: 1 }), 'compra inter');
    must(await S.cardsSvc.closeInvoice(uid, `${inter.id}_${prev2}`), 'fechar inter');
    await create(uid, 'invoices', { cardId: inter.id, referenceMonth: addMonths(month, 6), dueDate: clampDayInMonth(addMonths(month, 6), 17), status: 'open' }, `${inter.id}_${addMonths(month, 6)}`);
    must(await S.cardsSvc.cancelInvoice(uid, `${inter.id}_${addMonths(month, 6)}`), 'cancelar fatura zerada');
    must(await S.cardsSvc.registerInvoiceConsolidation(uid, card.id, { referenceMonth: addMonths(month, 1), amountCents: '180,00', description: 'Teste Consolidado' }), 'consolidado');
    return 'paga (conta debitada), aberta, fechada, cancelada R$ 0 e consolidada';
  });

  await step('Assinaturas: em conta e cobrada no cartão', async () => {
    must(await S.subs.createSubscription(uid, { name: 'Teste Netflix', amountCents: '55,90', periodicity: 'monthly', nextChargeDate: iso(5), accountId: ctx.main, categoryId: ctx.catSubs, status: 'active' }), 'assinatura conta');
    const sp = must(await S.subs.createSubscription(uid, { name: 'Teste Spotify', amountCents: '21,90', periodicity: 'monthly', nextChargeDate: today, accountId: ctx.main, categoryId: ctx.catSubs, cardId: ctx.card, status: 'active' }), 'assinatura cartão');
    must(await S.subs.registerSubscriptionCharge(uid, sp.id), 'cobrança no cartão');
    return '1 em conta + 1 no cartão (cobrança lançada na fatura)';
  });

  await step('Devedores: zerado, dívida à vista/parcelada, compra de cartão vinculada, antecipação e quitação', async () => {
    const maria = must(await S.debtors.createDebtor(uid, { name: 'Teste Maria', loanDate: today, lentCents: '0,00' }), 'devedor zerado');
    must(await S.debtPayments.createDebtPlan(uid, { debtorId: maria.id, description: 'Teste Empréstimo à vista', totalCents: '300,00', installments: 1, firstDueDate: iso(10) }), 'à vista');
    const moto = must(await S.debtPayments.createDebtPlan(uid, { debtorId: maria.id, description: 'Teste Moto', totalCents: '600,00', installments: 3, firstDueDate: iso(30) }), 'parcelada');
    must(await S.cardsSvc.registerCardPurchase(uid, ctx.card, { description: 'Teste Geladeira (Maria)', amountCents: '450,00', purchaseDate: today, installmentsTotal: 3, debtorId: maria.id }), 'compra vinculada');
    must(await S.debtPayments.registerDebtPayment(uid, moto.ids[2], { amountCents: '200,00', date: today, accountId: ctx.main }), 'parcela antecipada');
    const joao = must(await S.debtors.createDebtor(uid, { name: 'Teste João', loanDate: today, lentCents: '0,00' }), 'devedor 2');
    const plan = must(await S.debtPayments.createDebtPlan(uid, { debtorId: joao.id, description: 'Teste Notebook João', totalCents: '400,00', installments: 2, firstDueDate: iso(15) }), 'dívida João');
    must(await S.debtPayments.settleDebts(uid, joao.id, { groupId: plan.groupId }, { date: today, accountId: ctx.main }), 'quitação');
    return 'Maria (à vista + parcelada com 3/3 antecipada + cartão) e João (quitado)';
  });

  const rounds = Math.min(MAX_VOLUME, Math.max(0, Math.floor(Number(volume) || 0)));
  if (rounds > 0 && ctx.main && ctx.catMarket) {
    await step(`Volume ×${rounds}: ${rounds * VOLUME_PER_STEP} despesas + ${rounds * VOLUME_PER_STEP} receitas`, async () => {
      const total = rounds * VOLUME_PER_STEP;
      for (let i = 1; i <= total; i += 1) {
        const d = iso(-((i * 7) % 330));
        const e = must(await S.expenses.createExpense(uid, { description: `Teste Massa Despesa ${i}`, categoryId: ctx.catMarket, amountCents: `${(i % 90) + 1},00`, accountId: ctx.main, purchaseDate: d, dueDate: d, status: 'pending', recurrence: 'none' }), `despesa ${i}`);
        if (i % 3 === 0) must(await S.expenses.markExpensePaid(uid, e.id, d), `pagar ${i}`);
        const r = must(await S.incomes.createIncome(uid, { description: `Teste Massa Receita ${i}`, categoryId: ctx.catSalary, amountCents: `${(i % 70) + 5},00`, expectedDate: d, accountId: ctx.main, status: 'pending', recurrence: 'none' }), `receita ${i}`);
        if (i % 4 === 0) must(await S.incomes.markIncomeReceived(uid, r.id, d), `receber ${i}`);
      }
      return `${total} + ${total}`;
    });
  }

  return { steps, ok: steps.filter((s) => s.ok).length, failed: steps.filter((s) => !s.ok).length };
}
