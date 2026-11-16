/** Despesas — Fase 2: estrutura e estados vazios. */
import { renderModulePage } from './page-factory.js';

export const meta = { title: 'Despesas', icon: 'trending-down' };

export function render(container) {
  renderModulePage(container, {
    title: 'Despesas',
    description: 'Despesas por categoria, vencimentos, parcelamentos e orçamento mensal.',
    icon: 'trending-down',
    cards: [
      { label: 'Pago no mês', icon: 'check-circle-2', tone: 'expense', hint: 'Status "paga"' },
      { label: 'Pendente no mês', icon: 'clock', hint: 'Pendentes não reduzem o saldo' },
    ],
    columns: [
      { key: 'description', label: 'Descrição' },
      { key: 'category', label: 'Categoria' },
      { key: 'amount', label: 'Valor', numeric: true },
      { key: 'dueDate', label: 'Vencimento' },
      { key: 'paidDate', label: 'Pagamento' },
      { key: 'status', label: 'Status' },
    ],
    emptyTitle: 'Nenhuma despesa registrada',
    emptyText: 'Cadastre contas do mês para controlar vencimentos e comparar com o orçamento.',
  });
}
