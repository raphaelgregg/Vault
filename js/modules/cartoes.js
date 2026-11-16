/** Cartões — Fase 2: estrutura e estados vazios. */
import { renderModulePage } from './page-factory.js';

export const meta = { title: 'Cartões', icon: 'credit-card' };

export function render(container) {
  renderModulePage(container, {
    title: 'Cartões de crédito',
    description: 'Limites, fechamento, vencimento, compras parceladas e faturas.',
    icon: 'credit-card',
    cards: [
      { label: 'Limite disponível', icon: 'credit-card', hint: 'Limite total − faturas abertas' },
      { label: 'Fatura aberta', icon: 'receipt', tone: 'expense', hint: 'Compras do ciclo atual' },
    ],
    columns: [
      { key: 'card', label: 'Cartão' },
      { key: 'limit', label: 'Limite', numeric: true },
      { key: 'openInvoice', label: 'Fatura aberta', numeric: true },
      { key: 'closing', label: 'Fechamento' },
      { key: 'due', label: 'Vencimento' },
      { key: 'status', label: 'Status' },
    ],
    emptyTitle: 'Nenhum cartão cadastrado',
    emptyText: 'Cadastre seus cartões para controlar limite, faturas e evitar cobrança duplicada.',
  });
}
