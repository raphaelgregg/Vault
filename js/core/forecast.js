/**
 * Previsão financeira mensal — PURO (sem DOM, sem rede). Nada é gravado: tudo é derivado dos documentos recebidos.
 *
 * Pergunta respondida: "quanto vou gastar neste mês e quanto deve sobrar no fim dele?"
 *
 * FÓRMULA (centavos inteiros):
 *   saldo projetado = saldo atual das contas ativas
 *                   + receitas PENDENTES com data prevista até o fim do mês
 *                   − despesas PENDENTES com vencimento até o fim do mês (inclui vencidas de meses anteriores)
 *                   − faturas de cartão NÃO pagas (abertas/fechadas) com vencimento até o fim do mês
 *                   − assinaturas diretas (sem cartão) com cobrança prevista no mês, exceto as já lançadas como despesa
 *                   − assinaturas no cartão ainda não lançadas na fatura (cobrança prevista no mês)
 *                   [+ a receber de devedores no mês, só se `includeDebtors`]
 *
 * SEM DUPLA CONTAGEM:
 *  - o saldo atual já contém tudo que está pago/recebido/confirmado → só PENDENTES entram na projeção;
 *  - compra de cartão é compromisso, NÃO saída de caixa: o caixa só sai quando a FATURA é paga, então a
 *    projeção soma faturas (não compras); o "comprometido em cartões" (compras não quitadas) é só informativo;
 *  - fatura aberta = soma das suas compras; fechada = `totalCents`; paga/cancelada nunca entram;
 *  - assinatura no cartão só vira compra quando a cobrança é registrada (a data avança): antes disso é
 *    compromisso previsto, depois está na fatura — nunca nos dois;
 *  - assinatura direta que já existe como despesa do mês (mesmo nome e valor) é descartada e sinalizada;
 *  - o mês de uma fatura no caixa é o do VENCIMENTO (`dueDate`), não o `referenceMonth`.
 */
import { monthBounds } from '../utils/dates.js';
import { normalizeName } from '../utils/csv.js';
import { addMonths, advanceChargeDate, cardLimitUsage, invoiceTotalCents, summarizeSubscriptions } from './model.js';

const cents = (v) => (Number.isInteger(v) ? v : Number(v) || 0);
const isoMonth = (d) => (typeof d === 'string' ? d.slice(0, 7) : null);
const sum = (rows, pick = (r) => r.amountCents) => rows.reduce((t, r) => t + cents(pick(r)), 0);

/** Total de uma fatura NÃO paga: aberta = soma das compras vinculadas; fechada = totalCents. Paga/cancelada = 0. */
export function unpaidInvoiceCents(invoice, purchases = []) {
  if (invoice?.status === 'open') return invoiceTotalCents(purchases.filter((p) => p.invoiceId === invoice.id));
  if (invoice?.status === 'closed') return cents(invoice.totalCents);
  return 0;
}

/**
 * Cobranças de uma assinatura dentro de [start, end] (ISO), a partir de `nextChargeDate`, avançando pela
 * periodicidade (semanal pode cair várias vezes no mês). Máx. 60 passos. Datas inválidas → [].
 */
export function subscriptionOccurrences(subscription, start, end) {
  const out = [];
  let date = subscription?.nextChargeDate;
  for (let i = 0; i < 60 && typeof date === 'string' && date <= end; i += 1) {
    if (date >= start) out.push(date);
    date = advanceChargeDate(date, subscription.periodicity);
  }
  return out;
}

/** Assinatura direta já lançada como despesa no mês (mesmo nome normalizado e valor) → duplicidade provável. */
function matchingExpense(subscription, expenses) {
  const name = normalizeName(subscription.name);
  return expenses.find((e) => normalizeName(e.description) === name && cents(e.amountCents) === cents(subscription.amountCents)) ?? null;
}

/**
 * @param {object} input
 *  month           "YYYY-MM" analisado
 *  today           "YYYY-MM-DD" (vencida = pendente com vencimento < today)
 *  balanceCents    saldo atual das contas ativas (derivado; já inclui pagos/recebidos)
 *  expenses        despesas com vencimento no mês (qualquer status) + pendentes anteriores (a função filtra)
 *  pendingIncomes  receitas pendentes com data prevista até o fim do mês
 *  cards, invoices, purchases   cartões, faturas e compras (compromissos)
 *  subscriptions   assinaturas ativas
 *  debtorsReceivableCents  a receber de devedores no mês (informativo; entra na projeção só com includeDebtors)
 *  includeDebtors  inclui o a receber de devedores no saldo projetado
 *  futureMonths    quantos meses seguintes detalhar (padrão 3)
 */
export function monthlyForecast({
  month, today, balanceCents = 0, expenses = [], pendingIncomes = [], cards = [], invoices = [], purchases = [],
  subscriptions = [], debtorsReceivableCents = 0, includeDebtors = false, futureMonths = 3,
} = {}) {
  const bounds = monthBounds(month);
  if (!bounds) throw new RangeError('Mês inválido (use AAAA-MM).');
  const { start, end } = bounds;
  const live = expenses.filter((e) => e?.status !== 'cancelled');

  // A. Despesas ---------------------------------------------------------------------------------------------
  const inMonth = live.filter((e) => e.dueDate >= start && e.dueDate <= end);
  const pendingThroughEnd = live.filter((e) => e.status === 'pending' && e.dueDate <= end);
  const overdue = pendingThroughEnd.filter((e) => e.dueDate < today);
  const expensesBlock = {
    plannedCents: sum(inMonth),
    paidCents: sum(inMonth.filter((e) => e.status === 'paid')),
    pendingCents: sum(inMonth.filter((e) => e.status === 'pending')),
    overdueCents: sum(overdue),
    overduePreviousCents: sum(pendingThroughEnd.filter((e) => e.dueDate < start)),
    upcomingCents: sum(pendingThroughEnd.filter((e) => e.dueDate >= today)),
    // Tudo o que ainda vai sair da conta por despesa até o fim do mês (vencidas incluídas).
    toPayCents: sum(pendingThroughEnd),
    recurringPlannedCents: sum(inMonth.filter((e) => e.recurrence && e.recurrence !== 'none')),
  };

  // Receitas pendentes até o fim do mês.
  const incomes = pendingIncomes.filter((i) => i?.status === 'pending' && i.expectedDate <= end);
  const incomesBlock = { pendingCents: sum(incomes), overdueCents: sum(incomes.filter((i) => i.expectedDate < today)) };

  // B. Cartões ----------------------------------------------------------------------------------------------
  const purchasesByInvoice = new Map();
  for (const p of purchases) {
    if (!p.invoiceId) continue;
    if (!purchasesByInvoice.has(p.invoiceId)) purchasesByInvoice.set(p.invoiceId, []);
    purchasesByInvoice.get(p.invoiceId).push(p);
  }
  const unpaid = invoices
    .filter((i) => i.status === 'open' || i.status === 'closed')
    .map((i) => ({ ...i, unpaidCents: unpaidInvoiceCents(i, purchasesByInvoice.get(i.id) ?? []) }));
  const due = unpaid.filter((i) => i.dueDate <= end);
  const cardsBlock = {
    // Compromisso: tudo que foi comprado e ainda não quitado (inclui parcelas de meses futuros). NÃO é saída de caixa.
    committedCents: cards.filter((c) => c.status === 'active')
      .reduce((t, c) => t + cardLimitUsage(c, purchases.filter((p) => p.cardId === c.id), invoices.filter((i) => i.cardId === c.id)).usedCents, 0),
    purchasesInMonthCents: sum(purchases.filter((p) => isoMonth(p.purchaseDate) === month)),
    openInvoicesCents: sum(due.filter((i) => i.status === 'open'), (i) => i.unpaidCents),
    closedInvoicesCents: sum(due.filter((i) => i.status === 'closed'), (i) => i.unpaidCents),
    invoicesToPayCents: sum(due, (i) => i.unpaidCents),
    invoicesDueInMonthCents: sum(due.filter((i) => i.dueDate >= start), (i) => i.unpaidCents),
    invoicesOverdueCents: sum(due.filter((i) => i.dueDate < today), (i) => i.unpaidCents),
  };

  // C. Assinaturas ------------------------------------------------------------------------------------------
  const active = subscriptions.filter((s) => s?.status === 'active');
  const subItems = [];
  const duplicates = [];
  for (const s of active) {
    for (const date of subscriptionOccurrences(s, start, end)) {
      if (!s.cardId) {
        const twin = matchingExpense(s, inMonth);
        if (twin) { duplicates.push({ subscriptionId: s.id, name: s.name, expenseId: twin.id, date, amountCents: cents(s.amountCents) }); continue; }
      }
      subItems.push({ id: s.id, name: s.name, date, amountCents: cents(s.amountCents), viaCard: Boolean(s.cardId) });
    }
  }
  const nextCharges = active
    .filter((s) => s.nextChargeDate)
    .map((s) => ({ id: s.id, name: s.name, date: s.nextChargeDate, amountCents: cents(s.amountCents), viaCard: Boolean(s.cardId) }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const subscriptionsBlock = {
    monthlyCents: summarizeSubscriptions(active).monthlyCents, // valor mensal consolidado (todas as ativas)
    plannedInMonthCents: sum(subItems),
    directCents: sum(subItems.filter((s) => !s.viaCard)),
    cardCents: sum(subItems.filter((s) => s.viaCard)),
    items: subItems,
    duplicates,
    nextCharges,
  };

  // D. A receber de devedores (parcelas e dívidas deles; informativo por padrão) ---------------------------------
  const debtorsBlock = { receivableCents: cents(debtorsReceivableCents), included: Boolean(includeDebtors) };

  // Saldo projetado ---------------------------------------------------------------------------------------------
  const components = [
    { key: 'incomes', label: 'Receitas pendentes', cents: incomesBlock.pendingCents },
    { key: 'expenses', label: 'Despesas pendentes e vencidas', cents: -expensesBlock.toPayCents },
    { key: 'invoices', label: 'Faturas de cartão a pagar', cents: -cardsBlock.invoicesToPayCents },
    { key: 'subscriptionsDirect', label: 'Assinaturas previstas (conta)', cents: -subscriptionsBlock.directCents },
    { key: 'subscriptionsCard', label: 'Assinaturas no cartão ainda não lançadas', cents: -subscriptionsBlock.cardCents },
    ...(debtorsBlock.included ? [{ key: 'debtors', label: 'A receber de devedores', cents: debtorsBlock.receivableCents }] : []),
  ];
  const projectedBalanceCents = cents(balanceCents) + components.reduce((t, c) => t + c.cents, 0);

  // Meses seguintes ---------------------------------------------------------------------------------------------
  const next = [];
  for (let i = 1; i <= futureMonths; i += 1) {
    const m = addMonths(month, i);
    const b = monthBounds(m);
    const monthExpenses = sum(live.filter((e) => e.status === 'pending' && e.dueDate >= b.start && e.dueDate <= b.end));
    const monthInvoices = sum(unpaid.filter((inv) => inv.dueDate >= b.start && inv.dueDate <= b.end), (inv) => inv.unpaidCents);
    const monthSubs = sum(active.flatMap((s) => subscriptionOccurrences(s, b.start, b.end).map(() => s)), (s) => s.amountCents);
    next.push({ month: m, expensesCents: monthExpenses, invoicesCents: monthInvoices, subscriptionsCents: monthSubs, commitmentsCents: monthExpenses + monthInvoices + monthSubs });
  }

  return {
    month, start, end,
    balanceCents: cents(balanceCents),
    expenses: expensesBlock,
    incomes: incomesBlock,
    cards: cardsBlock,
    subscriptions: subscriptionsBlock,
    debtors: debtorsBlock,
    components,
    projectedBalanceCents,
    nextMonths: next,
  };
}
