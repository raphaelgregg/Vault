/** Dashboard — Fase 2: somente estrutura; indicadores chegam na Fase 4. */
import { renderModulePage } from './page-factory.js';

export const meta = { title: 'Dashboard', icon: 'layout-dashboard' };

export function render(container) {
  renderModulePage(container, {
    title: 'Visão geral',
    description: 'Indicadores consolidados das suas finanças. Cálculos entram na Fase 4.',
    icon: 'layout-dashboard',
    cards: [
      { label: 'Saldo total', icon: 'wallet', hint: 'Derivado de saldos iniciais e movimentações (Fase 3)' },
      { label: 'Receitas do mês', icon: 'trending-up', tone: 'income', hint: 'Somente receitas recebidas' },
      { label: 'Despesas do mês', icon: 'trending-down', tone: 'expense', hint: 'Somente despesas pagas' },
      { label: 'Resultado do mês', icon: 'scale', hint: 'Receitas − despesas confirmadas' },
    ],
    emptyTitle: 'Seu dashboard começa vazio',
    emptyText:
      'Nenhuma conta ou movimentação cadastrada. Na Fase 3 você cadastra bancos, receitas e despesas; os indicadores aparecem automaticamente.',
    tableTitle: 'Próximos vencimentos',
    note: 'Sem dados DEMO: todos os indicadores mostram "—" até existir dado real seu.',
  });
}
