/** Transferências — Fase 2: estrutura e estados vazios. */
import { renderModulePage } from './page-factory.js';

export const meta = { title: 'Transferências', icon: 'arrow-left-right' };

export function render(container) {
  renderModulePage(container, {
    title: 'Transferências',
    description: 'Movimentações entre contas e aportes em metas — nunca contam como receita ou despesa.',
    icon: 'arrow-left-right',
    cards: [
      { label: 'Transferido no mês', icon: 'arrow-left-right', hint: 'Neutro para o resultado' },
      { label: 'Aportes em metas', icon: 'target', hint: 'Saída da conta, entrada na meta' },
    ],
    columns: [
      { key: 'from', label: 'Origem' },
      { key: 'to', label: 'Destino' },
      { key: 'amount', label: 'Valor', numeric: true },
      { key: 'date', label: 'Data' },
      { key: 'reason', label: 'Motivo' },
    ],
    emptyTitle: 'Nenhuma transferência registrada',
    emptyText: 'Transfira entre contas mantendo o histórico auditável e o patrimônio correto.',
  });
}
