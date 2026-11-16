/** Configurações — Fase 2: perfil básico e preferências de interface. */
import { renderModulePage } from './page-factory.js';

export const meta = { title: 'Configurações', icon: 'settings' };

export function render(container, { user } = {}) {
  renderModulePage(container, {
    title: 'Configurações',
    description: 'Perfil, moeda, tema e preferências de exibição.',
    icon: 'settings',
    cards: [
      { label: 'Conta', value: user?.email ?? '—', icon: 'user', hint: 'E-mail usado no login' },
      { label: 'Moeda', value: 'R$ (BRL)', icon: 'coins', hint: 'Valores armazenados em centavos' },
      { label: 'Tema', value: 'Claro/Escuro', icon: 'palette', hint: 'Alternável na barra superior' },
    ],
    emptyTitle: 'Perfil ainda não criado',
    emptyText:
      'O documento profile/main será criado na Fase 3 junto com os dados iniciais. Nada é gravado automaticamente agora.',
  });
}
