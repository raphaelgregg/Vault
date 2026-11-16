/** Metas — Fase 2: estrutura e estados vazios. */
import { renderModulePage } from './page-factory.js';

export const meta = { title: 'Metas', icon: 'target' };

export function render(container) {
  renderModulePage(container, {
    title: 'Metas financeiras',
    description: 'Objetivos, aportes, resgates e progresso percentual.',
    icon: 'target',
    cards: [
      { label: 'Total acumulado', icon: 'piggy-bank', hint: 'Soma dos aportes líquidos' },
      { label: 'Metas ativas', icon: 'target', hint: 'Objetivos em andamento' },
    ],
    columns: [
      { key: 'name', label: 'Meta' },
      { key: 'target', label: 'Objetivo', numeric: true },
      { key: 'saved', label: 'Acumulado', numeric: true },
      { key: 'progress', label: 'Progresso', numeric: true },
      { key: 'deadline', label: 'Prazo' },
      { key: 'status', label: 'Status' },
    ],
    emptyTitle: 'Nenhuma meta criada',
    emptyText: 'Crie reserva de emergência, viagem ou qualquer objetivo e acompanhe o progresso.',
  });
}
