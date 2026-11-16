/**
 * Fábrica de páginas de módulo da Fase 2: cabeçalho, aviso de escopo e
 * estrutura de tabela/cards vazios. Nenhuma lógica financeira aqui.
 */
import { el, refreshIcons } from '../core/ui.js';
import { createEmptyState } from '../components/empty-state.js';
import { createCard } from '../components/card.js';
import { createTable } from '../components/table.js';

export function renderModulePage(container, config) {
  const {
    title,
    description,
    icon,
    cards = [],
    columns = [],
    emptyTitle,
    emptyText,
    tableTitle,
    note,
  } = config;

  const header = el('section', { class: 'panel' }, [
    el('div', { class: 'panel__header' }, [
      el('span', { class: 'card__icon' }, [el('i', { 'data-lucide': icon, 'aria-hidden': 'true' })]),
      el('div', {}, [
        el('h2', { text: title }),
        el('p', { class: 'card__hint', text: description }),
      ]),
      el('div', { class: 'topbar__spacer' }),
      el('span', { class: 'badge badge--demo', text: 'Estrutura — sem dados' }),
    ]),
  ]);

  const nodes = [header];

  if (cards.length) {
    nodes.push(
      el('div', { class: 'grid grid--cards' }, cards.map((card) => createCard(card)))
    );
  }

  const body = columns.length
    ? createTable({
        columns,
        rows: [],
        emptyTitle,
        emptyText,
        emptyIcon: icon,
      })
    : createEmptyState({ icon, title: emptyTitle, text: emptyText });

  nodes.push(
    el('section', { class: 'panel' }, [
      el('div', { class: 'panel__header' }, [
        el('h2', { text: tableTitle ?? 'Registros' }),
        el('div', { class: 'topbar__spacer' }),
        el('span', { class: 'badge', text: '0 registros' }),
      ]),
      el('div', { class: 'panel__body panel__body--flush' }, [body]),
    ])
  );

  if (note) {
    nodes.push(el('p', { class: 'card__hint', text: note }));
  }

  container.replaceChildren(...nodes);
  refreshIcons();
}
