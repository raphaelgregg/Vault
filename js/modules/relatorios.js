/** Relatórios — Fase 2: estrutura e estados vazios. */
import { renderModulePage } from './page-factory.js';

export const meta = { title: 'Relatórios', icon: 'bar-chart-3' };

export function render(container) {
  renderModulePage(container, {
    title: 'Relatórios',
    description: 'Receitas e despesas por período e categoria, evolução patrimonial e comparativos.',
    icon: 'bar-chart-3',
    cards: [
      { label: 'Período', icon: 'calendar-range', hint: 'Filtros entram na Fase 4' },
      { label: 'Exportação', icon: 'download', hint: 'CSV e PDF na Fase 5' },
    ],
    emptyTitle: 'Nenhum dado para relatar',
    emptyText: 'Os relatórios são gerados a partir das movimentações reais. Sem dados, não há gráfico.',
  });
}
