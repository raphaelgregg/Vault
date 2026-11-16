/** Bancos — Fase 2: estrutura e estados vazios. */
import { renderModulePage } from './page-factory.js';

export const meta = { title: 'Bancos', icon: 'landmark' };

export function render(container) {
  renderModulePage(container, {
    title: 'Bancos e contas',
    description: 'Instituições, tipos de conta e saldo calculado a partir das movimentações.',
    icon: 'landmark',
    cards: [
      { label: 'Saldo total', icon: 'wallet', hint: 'Sempre derivado — não é gravado na conta' },
      { label: 'Contas ativas', icon: 'landmark', hint: 'Contagem de contas com status ativo' },
    ],
    columns: [
      { key: 'institution', label: 'Instituição' },
      { key: 'name', label: 'Conta' },
      { key: 'type', label: 'Tipo' },
      { key: 'balance', label: 'Saldo atual', numeric: true },
      { key: 'status', label: 'Status' },
    ],
    emptyTitle: 'Nenhuma conta cadastrada',
    emptyText: 'Cadastre sua primeira instituição para começar a acompanhar entradas e saídas.',
  });
}
