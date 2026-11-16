/**
 * Entrada das páginas internas.
 * Fluxo: tema -> emuladores -> guarda de sessão -> shell -> módulo da página.
 * Nenhum módulo é importado antes da autenticação.
 */
import { applyStoredTheme } from './components/theme.js';
import { connectEmulatorsOnce, configMissing } from './firebase/client.js';
import { requireSession } from './core/guard.js';
import { mountSidebar } from './components/sidebar.js';
import { mountTopbar } from './components/topbar.js';
import { navItemById } from './utils/nav.js';
import { $, toast, refreshIcons } from './core/ui.js';

const MODULES = {
  dashboard: () => import('./modules/dashboard.js'),
  bancos: () => import('./modules/bancos.js'),
  receitas: () => import('./modules/receitas.js'),
  despesas: () => import('./modules/despesas.js'),
  transferencias: () => import('./modules/transferencias.js'),
  assinaturas: () => import('./modules/assinaturas.js'),
  devedores: () => import('./modules/devedores.js'),
  metas: () => import('./modules/metas.js'),
  cartoes: () => import('./modules/cartoes.js'),
  relatorios: () => import('./modules/relatorios.js'),
  configuracoes: () => import('./modules/configuracoes.js'),
};

async function bootstrap() {
  applyStoredTheme();
  if (configMissing) {
    toast('Configuração do Firebase ausente. Veja o README (js/firebase/config.js).', 6000);
  }
  connectEmulatorsOnce();

  const pageId = document.body.dataset.page || 'dashboard';
  const user = await requireSession();
  if (!user) return;

  const navItem = navItemById(pageId);
  const sidebar = mountSidebar($('#sidebar'), { activeId: pageId });
  mountTopbar($('#topbar'), {
    title: navItem?.label ?? 'Personal Finance',
    user,
    onMenuClick: () => sidebar.toggleMobile(),
  });

  const loadModule = MODULES[pageId];
  if (!loadModule) {
    $('#page-content').textContent = 'Página não encontrada.';
    return;
  }

  try {
    const module = await loadModule();
    module.render($('#page-content'), { user });
    refreshIcons();
  } catch (error) {
    console.error('[app] falha ao carregar módulo', error);
    $('#page-content').replaceChildren(
      Object.assign(document.createElement('p'), {
        textContent: 'Não foi possível carregar esta página. Recarregue ou verifique o console.',
      })
    );
  }
}

bootstrap();
