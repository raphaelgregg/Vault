/** Menu principal — fonte única dos itens de navegação. */
export const NAV_ITEMS = Object.freeze([
  { id: 'dashboard', label: 'Dashboard', icon: 'layout-dashboard', href: 'dashboard.html' },
  { id: 'bancos', label: 'Bancos', icon: 'landmark', href: 'bancos.html' },
  { id: 'receitas', label: 'Receitas', icon: 'trending-up', href: 'receitas.html' },
  { id: 'despesas', label: 'Despesas', icon: 'trending-down', href: 'despesas.html' },
  { id: 'transferencias', label: 'Transferências', icon: 'arrow-left-right', href: 'transferencias.html' },
  { id: 'categorias', label: 'Categorias', icon: 'tags', href: 'categorias.html' },
  { id: 'assinaturas', label: 'Assinaturas', icon: 'repeat', href: 'assinaturas.html' },
  { id: 'devedores', label: 'Devedores', icon: 'users', href: 'devedores.html' },
  { id: 'metas', label: 'Metas', icon: 'target', href: 'metas.html' },
  { id: 'cartoes', label: 'Cartões', icon: 'credit-card', href: 'cartoes.html' },
  { id: 'relatorios', label: 'Relatórios', icon: 'bar-chart-3', href: 'relatorios.html' },
  { id: 'configuracoes', label: 'Configurações', icon: 'settings', href: 'configuracoes.html' },
]);

export function navItemById(id) {
  return NAV_ITEMS.find((item) => item.id === id) ?? null;
}
