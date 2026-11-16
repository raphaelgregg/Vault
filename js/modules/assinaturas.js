/** Assinaturas — Fase 2: estrutura e estados vazios. */
import { renderModulePage } from './page-factory.js';

export const meta = { title: 'Assinaturas', icon: 'repeat' };

export function render(container) {
  renderModulePage(container, {
    title: 'Assinaturas',
    description: 'Serviços recorrentes, custo mensal equivalente e próximas cobranças.',
    icon: 'repeat',
    cards: [
      { label: 'Custo mensal', icon: 'repeat', hint: 'Equivalente mensal das ativas' },
      { label: 'Projeção anual', icon: 'calendar', hint: 'Custo mensal × 12' },
    ],
    columns: [
      { key: 'name', label: 'Serviço' },
      { key: 'amount', label: 'Valor', numeric: true },
      { key: 'periodicity', label: 'Periodicidade' },
      { key: 'nextCharge', label: 'Próxima cobrança' },
      { key: 'account', label: 'Conta' },
      { key: 'status', label: 'Status' },
    ],
    emptyTitle: 'Nenhuma assinatura cadastrada',
    emptyText: 'Cadastre streaming, nuvem e outros serviços para enxergar o custo recorrente real.',
  });
}
