/**
 * Dashboard — VF-2-03f. Somente leitura: tudo é derivado (js/services/dashboard.js).
 * Sem dado real mostra zeros/estado vazio; nada é DEMO.
 */
import { el, refreshIcons } from '../core/ui.js';
import { statCard, panelHeader, emptyBlock, dataTable, formatDate, formatMonth, mount } from '../components/form-kit.js';
import { loadDashboard, formatCents, DASHBOARD_SOURCES } from '../services/dashboard.js';

export const meta = { title: 'Dashboard', icon: 'layout-dashboard' };

const KIND_LABELS = { expense: 'Despesa', subscription: 'Assinatura', invoice: 'Fatura' };
const SOURCE_LABELS = {
  goals: 'metas (saldo vinculado)', monthPending: 'previsto do mês', cardInvoices: 'faturas e limite dos cartões', debtorMonth: 'a receber no mês (devedores)',
  accounts: 'contas', movements: 'movimentações (saldo e resultado)', pendingExpenses: 'despesas a vencer',
  subscriptions: 'assinaturas', invoices: 'faturas', debtors: 'devedores', budgets: 'orçamentos',
};
const COLLECTION_LABELS = {
  incomes: 'receitas', expenses: 'despesas', transfers: 'transferências',
  debtPayments: 'recebimentos', cardInvoices: 'faturas/compras de cartão', invoices: 'faturas pagas', goalTransactions: 'movimentações de metas', budgetExpenses: 'despesas do orçamento',
};

let selectedMonth = null; // mês do indicador; null = vigente

export async function render(container, { user }) {
  mount(container, el('p', { class: 'card__hint', role: 'status', text: 'Carregando indicadores…' }));
  let data;
  try {
    data = await loadDashboard(user.uid, selectedMonth ? { month: selectedMonth } : {});
  } catch (error) {
    console.error('[dashboard] falha ao carregar', error);
    mount(container, el('p', { role: 'alert', text: 'Não foi possível carregar o dashboard. Tente recarregar a página.' }));
    return;
  }
  if (data.failed.length >= DASHBOARD_SOURCES.length) {
    mount(container, el('p', { role: 'alert', text: 'Não foi possível carregar nenhum indicador. Verifique a conexão e as regras do Firestore e recarregue a página.' }));
    return;
  }
  draw(container, data, () => render(container, { user }));
}

const money = (value, fn = (v) => v) => (value === null || value === undefined ? '—' : formatCents(fn(value)));

function draw(container, data, rerender) {
  const { result, budgets, debtors } = data;
  const header = panelHeader({ icon: 'layout-dashboard', title: 'Visão geral', hint: `Indicadores de ${formatMonth(data.month)}, derivados dos seus lançamentos.` });

  const notice = data.truncated.length
    ? el('p', { class: 'notice', role: 'status', text: `Leitura limitada em: ${data.truncated.map((k) => COLLECTION_LABELS[k] ?? k).join(', ')}. Saldo e totais podem estar incompletos.` })
    : null;

  const failedNotice = data.failed.length
    ? el('p', { class: 'notice', role: 'alert', text: `Não foi possível carregar: ${data.failed.map((k) => SOURCE_LABELS[k] ?? k).join(', ')}. Os demais indicadores continuam válidos; recarregue para tentar de novo.` })
    : null;
  const unavailable = 'Indisponível nesta carga';

  const monthInput = el('input', {
    type: 'month', id: 'dashboard-month', value: data.month, 'aria-label': 'Mês dos indicadores',
    onChange: (event) => {
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(event.target.value)) return;
      selectedMonth = event.target.value;
      rerender();
    },
  });
  const monthBar = el('div', { class: 'form__field' }, [el('label', { for: 'dashboard-month', text: 'Mês dos indicadores' }), monthInput]);

  const { forecast, cardInvoices: inv } = data;
  const sec = (title, cardsList) => el('section', { class: 'panel' }, [
    el('div', { class: 'panel__header' }, [el('h2', { text: title })]),
    el('div', { class: 'panel__body' }, [el('div', { class: 'grid grid--cards' }, cardsList)]),
  ]);

  const balanceSection = sec('Saldo em contas', [
    statCard('Saldo total', money(data.totalBalanceCents), 'wallet', data.accountCount === null ? unavailable : `${data.accountCount} conta(s) ativa(s)`),
    statCard('Livre', money(data.freeBalanceCents), 'unlock', data.freeBalanceCents === null ? unavailable : 'Saldo total − vinculado a metas'),
    statCard('Vinculado a metas', money(data.linkedGoalsCents), 'target', data.linkedGoalsCents === null ? unavailable : 'Caixinhas/investimentos com meta'),
  ]);
  const monthSection = sec(`Receitas × despesas — ${formatMonth(data.month)}`, [
    statCard('Receitas', money(result?.incomeCents), 'trending-up', forecast ? `Realizado · previsto pendente ${formatCents(forecast.incomeCents)}` : (result ? 'Realizado (previsto indisponível)' : unavailable), 'income'),
    statCard('Despesas', money(result?.expenseCents), 'trending-down', forecast ? `Realizado · previsto pendente ${formatCents(forecast.expenseCents)}` : (result ? 'Realizado (previsto indisponível)' : unavailable), 'expense'),
    statCard('Resultado', money(result?.resultCents), 'scale', forecast ? `Realizado · previsto ${formatCents(forecast.forecastResultCents)}` : (result ? 'Realizado' : unavailable)),
    statCard('Orçamentos', budgets && (budgets.spentCents > 0 || budgets.limitCents > 0) ? formatCents(budgets.spentCents) : '—', 'gauge',
      !budgets ? unavailable : budgets.limitCents > 0 ? `de ${formatCents(budgets.limitCents)} · ${budgets.overCount} estourado(s)` : 'Nenhum orçamento no mês'),
  ]);
  const cardSection = sec(`Faturas de cartão — ${formatMonth(data.month)}`, [
    statCard('Faturas a pagar', inv ? formatCents(inv.dueCents) : '—', 'credit-card',
      inv ? `${inv.count} fatura(s) · abertas ${formatCents(inv.openCents)} · fechadas ${formatCents(inv.closedCents)} · pagas ${formatCents(inv.paidCents)}` : unavailable),
    statCard('Limite utilizado', inv ? formatCents(inv.usedCents) : '—', 'gauge',
      inv ? `de ${formatCents(inv.limitCents)} · disponível ${formatCents(inv.availableCents)}` : unavailable),
  ]);
  const debtorSection = sec('Devedores', [
    statCard(`A receber em ${formatMonth(data.month)}`, money(debtors?.monthDueCents), 'calendar-check', debtors?.monthDueCents == null ? unavailable : 'Fechamento do mês (cartão + dívidas), limitado ao pendente'),
    statCard('Total em aberto', money(debtors?.pendingCents), 'hand-coins', debtors ? `${debtors.openCount} devedor(es) em aberto` : unavailable),
  ]);
  const note = el('p', { class: 'card__hint', text: 'Compras no cartão não entram em Despesas: aparecem em Faturas; pagar a fatura debita a conta escolhida (uma vez).' });

  const upcoming = el('section', { class: 'panel' }, [
    el('div', { class: 'panel__header' }, [el('h2', { text: 'Próximos vencimentos' })]),
    el('div', { class: 'panel__body panel__body--flush' }, [
      data.upcoming.length
        ? dataTable({
          columns: [
            { key: 'date', label: 'Data', render: (v) => formatDate(v) },
            { key: 'kind', label: 'Tipo', render: (v) => KIND_LABELS[v] ?? v },
            { key: 'label', label: 'Descrição' },
            { key: 'amountCents', label: 'Valor', numeric: true, render: (v) => formatCents(v) },
          ],
          rows: data.upcoming,
        })
        : emptyBlock('calendar-check', 'Nada a vencer', 'Despesas pendentes, assinaturas ativas e faturas fechadas aparecem aqui.'),
    ]),
  ]);

  mount(container, header, monthBar, failedNotice, notice, balanceSection, monthSection, cardSection, debtorSection, note, upcoming);
  refreshIcons();
}
