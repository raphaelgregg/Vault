/** Devedores — Fase 2: estrutura e estados vazios. */
import { renderModulePage } from './page-factory.js';

export const meta = { title: 'Devedores', icon: 'users' };

export function render(container) {
  renderModulePage(container, {
    title: 'Devedores',
    description: 'Empréstimos pessoais, recebimentos parciais e saldo pendente por pessoa.',
    icon: 'users',
    cards: [
      { label: 'A receber', icon: 'hand-coins', hint: 'Soma dos saldos pendentes' },
      { label: 'Recebido', icon: 'check-circle-2', tone: 'income', hint: 'Total já devolvido' },
    ],
    columns: [
      { key: 'name', label: 'Pessoa' },
      { key: 'loanDate', label: 'Empréstimo' },
      { key: 'lent', label: 'Emprestado', numeric: true },
      { key: 'received', label: 'Recebido', numeric: true },
      { key: 'pending', label: 'Pendente', numeric: true },
      { key: 'status', label: 'Status' },
    ],
    emptyTitle: 'Nenhum devedor cadastrado',
    emptyText: 'Registre valores emprestados para acompanhar parcelas, atrasos e quitações.',
  });
}
