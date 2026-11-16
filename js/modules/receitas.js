/** Receitas — Fase 2: estrutura e estados vazios. */
import { renderModulePage } from './page-factory.js';

export const meta = { title: 'Receitas', icon: 'trending-up' };

export function render(container) {
  renderModulePage(container, {
    title: 'Receitas',
    description: 'Receitas previstas e recebidas, com recorrência e histórico mensal.',
    icon: 'trending-up',
    cards: [
      { label: 'Recebido no mês', icon: 'check-circle-2', tone: 'income', hint: 'Status "recebida"' },
      { label: 'Previsto no mês', icon: 'calendar-clock', hint: 'Inclui previstas e atrasadas' },
    ],
    columns: [
      { key: 'description', label: 'Descrição' },
      { key: 'category', label: 'Categoria' },
      { key: 'amount', label: 'Valor', numeric: true },
      { key: 'expectedDate', label: 'Prevista' },
      { key: 'receivedDate', label: 'Recebida' },
      { key: 'status', label: 'Status' },
    ],
    emptyTitle: 'Nenhuma receita registrada',
    emptyText: 'Registre salário, bônus ou outras entradas para acompanhar o previsto versus o realizado.',
  });
}
