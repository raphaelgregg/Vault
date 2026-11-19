/**
 * Dashboard — VF-2-03f. Somente leitura: tudo é derivado (js/services/dashboard.js).
 * Sem dado real mostra zeros/estado vazio; nada é DEMO.
 */
import { el, refreshIcons } from '../core/ui.js';
import { statCard, panelHeader, emptyBlock, dataTable, formatDate, formatMonth, mount } from '../components/form-kit.js';
import { loadDashboard, formatCents } from '../services/dashboard.js';

export const meta = { title: 'Dashboard', icon: 'layout-dashboard' };

const KIND_LABELS = { expense: 'Despesa', subscription: 'Assinatura', invoice: 'Fatura' };
const COLLECTION_LABELS = {
  incomes: 'receitas', expenses: 'despesas', transfers: 'transferências',
  debtPayments: 'recebimentos', goalTransactions: 'movimentações de metas', budgetExpenses: 'despesas do orçamento',
};

export async function render(container, { user }) {
  mount(container, el('p', { class: 'card__hint', role: 'status', text: 'Carregando indicadores…' }));
  let data;
  try {
    data = await loadDashboard(user.uid);
  } catch (error) {
    console.error('[dashboard] falha ao carregar', error);
    mount(container, el('p', { role: 'alert', text: 'Não foi possível carregar o dashboard. Tente recarregar a página.' }));
    return;
  }
  draw(container, data);
}

function draw(container, data) {
  const { result, budgets, debtors } = data;
  const header = panelHeader({ icon: 'layout-dashboard', title: 'Visão geral', hint: `Indicadores de ${formatMonth(data.month)}, derivados dos seus lançamentos.` });

  const notice = data.truncated.length
    ? el('p', { class: 'notice', role: 'status', text: `Leitura limitada em: ${data.truncated.map((k) => COLLECTION_LABELS[k] ?? k).join(', ')}. Saldo e totais podem estar incompletos.` })
    : null;

  const cards = el('div', { class: 'grid grid--cards' }, [
    statCard('Saldo total', formatCents(data.totalBalanceCents), 'wallet', `${data.accountCount} conta(s) ativa(s)`),
    statCard('Receitas do mês', formatCents(result.incomeCents), 'trending-up', 'Somente receitas recebidas', 'income'),
    statCard('Despesas do mês', formatCents(result.expenseCents), 'trending-down', 'Somente despesas pagas', 'expense'),
    statCard('Resultado do mês', formatCents(result.resultCents), 'scale', 'Receitas − despesas realizadas'),
    statCard('A receber', formatCents(debtors.pendingCents), 'hand-coins', `${debtors.openCount} devedor(es) em aberto`),
    statCard('Orçamentos', `${budgets.spentCents > 0 || budgets.limitCents > 0 ? formatCents(budgets.spentCents) : '—'}`, 'gauge',
      budgets.limitCents > 0 ? `de ${formatCents(budgets.limitCents)} · ${budgets.overCount} estourado(s)` : 'Nenhum orçamento no mês'),
  ]);

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

  mount(container, header, notice, cards, upcoming);
  refreshIcons();
}
