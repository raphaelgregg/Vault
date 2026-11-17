/**
 * Receitas — Fase 3: CRUD completo integrado ao Firestore.
 * - Lista receitas com filtros
 * - Modal para criar/editar receita
 * - Ações: marcar como recebida, cancelar
 * - Validação client-side espelhando Security Rules
 * - Persistência em users/{uid}/incomes
 */
import { el, $, $$, toast, refreshIcons } from '../core/ui.js';
import { openModal, closeModal } from '../components/modal.js';
import {
  listIncomes,
  createIncome,
  updateIncome,
  deleteIncome,
  markIncomeReceived,
  cancelIncome,
  getRecurrenceOptions,
  getIncomeStatusOptions,
  formatCents,
  parseMoneyToCents,
} from '../services/incomes.js';
import { listCategories } from '../services/categories.js';
import { listAccounts } from '../services/accounts.js';

export const meta = { title: 'Receitas', icon: 'trending-up' };

let currentUser = null;
let incomesCache = [];
let categoriesCache = [];
let accountsCache = [];
let currentFilter = { status: 'all', month: null };

/** Render principal do módulo. */
export async function render(container, { user }) {
  currentUser = user;
  await loadData();
  renderPage(container);
}

/** Carrega dados iniciais. */
async function loadData() {
  [incomesCache, categoriesCache, accountsCache] = await Promise.all([
    listIncomes(currentUser.uid),
    listCategories(currentUser.uid),
    listAccounts(currentUser.uid),
  ]);
  applyFilters();
}

/** Aplica filtros atuais. */
function applyFilters() {
  // Filtros são aplicados na renderização da tabela
}

/** Renderiza a página completa. */
function renderPage(container) {
  const stats = computeStats();

  const header = el('section', { class: 'panel' }, [
    el('div', { class: 'panel__header' }, [
      el('span', { class: 'card__icon' }, [el('i', { 'data-lucide': 'trending-up', 'aria-hidden': 'true' })]),
      el('div', {}, [
        el('h2', { text: 'Receitas' }),
        el('p', { class: 'card__hint', text: 'Receitas previstas e recebidas, com recorrência e histórico mensal.' }),
      ]),
      el('div', { class: 'topbar__spacer' }),
      el('button', {
        type: 'button',
        class: 'btn btn--primary',
        onClick: () => openIncomeModal(),
        html: '<i data-lucide="plus" aria-hidden="true"></i> Nova receita',
      }),
    ]),
  ]);

  const cards = el('div', { class: 'grid grid--cards' }, [
    createStatCard('Recebido no mês', formatCents(stats.receivedThisMonth), 'check-circle-2', 'income', 'Status "recebida" no mês atual'),
    createStatCard('Previsto no mês', formatCents(stats.pendingThisMonth), 'calendar-clock', null, 'Inclui previstas e atrasadas'),
  ]);

  const filterBar = createFilterBar();
  const table = createIncomesTable();

  const nodes = [
    header,
    cards,
    filterBar,
    el('section', { class: 'panel' }, [
      el('div', { class: 'panel__header' }, [
        el('h2', { text: 'Receitas registradas' }),
        el('div', { class: 'topbar__spacer' }),
        el('span', { class: 'badge', text: `${getFilteredIncomes().length} registro${getFilteredIncomes().length !== 1 ? 's' : ''}` }),
      ]),
      el('div', { class: 'panel__body panel__body--flush' }, [table]),
    ]),
  ];

  container.replaceChildren(...nodes);
  refreshIcons();
}

/** Cria card de estatística. */
function createStatCard(label, value, icon, tone, hint) {
  return el('article', { class: `card${tone ? ` card--${tone}` : ''}` }, [
    el('div', { class: 'card__icon' }, [el('i', { 'data-lucide': icon, 'aria-hidden': 'true' })]),
    el('div', { class: 'card__content' }, [
      el('p', { class: 'card__label', text: label }),
      el('p', { class: 'card__value', text: value }),
    ]),
    hint ? el('p', { class: 'card__hint', text: hint }) : null,
  ]);
}

/** Computa estatísticas rápidas do mês atual. */
function computeStats() {
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);

  let receivedThisMonth = 0;
  let pendingThisMonth = 0;

  for (const income of incomesCache) {
    const expectedDate = new Date(income.expectedDate + 'T00:00:00');
    const isThisMonth = expectedDate >= startOfMonth && expectedDate <= endOfMonth;

    if (income.status === 'received' && isThisMonth) {
      receivedThisMonth += Number(income.amountCents) || 0;
    } else if (income.status === 'pending' && isThisMonth) {
      pendingThisMonth += Number(income.amountCents) || 0;
    }
  }

  return { receivedThisMonth, pendingThisMonth };
}

/** Cria barra de filtros. */
function createFilterBar() {
  const statusOptions = [
    { value: 'all', label: 'Todos' },
    { value: 'pending', label: 'Previstas' },
    { value: 'received', label: 'Recebidas' },
    { value: 'cancelled', label: 'Canceladas' },
  ];

  const monthOptions = [{ value: '', label: 'Todos os meses' }];
  // Gerar opções de mês baseadas nos dados
  const months = new Set();
  for (const income of incomesCache) {
    const m = income.expectedDate?.substring(0, 7); // YYYY-MM
    if (m) months.add(m);
  }
  const sortedMonths = Array.from(months).sort().reverse();
  for (const m of sortedMonths) {
    const [y, mo] = m.split('-');
    monthOptions.push({ value: m, label: `${mo}/${y}` });
  }

  return el('section', { class: 'panel' }, [
    el('div', { class: 'panel__header' }, [
      el('h2', { text: 'Filtros' }),
    ]),
    el('div', { class: 'panel__body', style: 'padding: var(--space-4);' }, [
      el('div', { class: 'form__row', style: 'gap: var(--space-3); flex-wrap: wrap;' }, [
        el('div', { class: 'form__field', style: 'flex: 1; min-width: 180px;' }, [
          el('label', { for: 'filter-status', text: 'Status' }),
          el('select', {
            id: 'filter-status',
            value: currentFilter.status,
            onChange: (e) => {
              currentFilter.status = e.target.value;
              refreshTable();
            },
          }, statusOptions.map((o) => el('option', { value: o.value, selected: currentFilter.status === o.value }, o.label))),
        ]),
        el('div', { class: 'form__field', style: 'flex: 1; min-width: 180px;' }, [
          el('label', { for: 'filter-month', text: 'Mês' }),
          el('select', {
            id: 'filter-month',
            value: currentFilter.month ?? '',
            onChange: (e) => {
              currentFilter.month = e.target.value || null;
              refreshTable();
            },
          }, monthOptions.map((o) => el('option', { value: o.value, selected: currentFilter.month === o.value }, o.label))),
        ]),
      ]),
    ]),
  ]);
}

/** Retorna receitas filtradas. */
function getFilteredIncomes() {
  return incomesCache.filter((income) => {
    if (currentFilter.status !== 'all' && income.status !== currentFilter.status) return false;
    if (currentFilter.month && !income.expectedDate?.startsWith(currentFilter.month)) return false;
    return true;
  });
}

/** Atualiza apenas a tabela. */
function refreshTable() {
  const tableContainer = $('#incomes-table-container');
  if (tableContainer) {
    tableContainer.replaceWith(createIncomesTable());
    refreshIcons();
  }
}

/** Cria a tabela de receitas. */
function createIncomesTable() {
  const filtered = getFilteredIncomes();

  if (!filtered.length) {
    return el('div', { id: 'incomes-table-container', class: 'empty' }, [
      el('div', { class: 'empty__icon' }, [el('i', { 'data-lucide': 'trending-up', 'aria-hidden': 'true' })]),
      el('p', { class: 'empty__title', text: 'Nenhuma receita encontrada' }),
      el('p', { class: 'empty__text', text: currentFilter.status !== 'all' || currentFilter.month
        ? 'Tente ajustar os filtros acima.'
        : 'Registre salário, bônus ou outras entradas para acompanhar o previsto versus o realizado.' }),
      !currentFilter.status !== 'all' || !currentFilter.month ? null : el('button', {
        type: 'button',
        class: 'btn btn--secondary',
        onClick: () => {
          currentFilter = { status: 'all', month: null };
          refreshTable();
        },
        text: 'Limpar filtros',
      }),
    ]);
  }

  const columns = [
    { key: 'description', label: 'Descrição' },
    { key: 'category', label: 'Categoria', render: (v) => getCategoryLabel(v) },
    { key: 'amount', label: 'Valor', numeric: true, render: (v) => formatCents(Number(v) || 0) },
    { key: 'expectedDate', label: 'Prevista', render: (v) => formatDate(v) },
    { key: 'receivedDate', label: 'Recebida', render: (v) => v ? formatDate(v) : '—' },
    { key: 'status', label: 'Status', render: (v) => getStatusLabel(v) },
  ];

  const headWithActions = el('tr', {}, [
    ...columns.map((c) => el('th', { class: c.numeric ? 'num' : '', text: c.label })),
    el('th', { text: 'Ações' }),
  ]);

  const bodyWithActions = filtered.map((income) =>
    el('tr', {}, [
      ...columns.map((column) => {
        const value = income[column.key];
        const display = column.render ? column.render(value) : (value ?? '—');
        return el('td', {
          class: column.numeric ? 'num' : '',
          text: display,
        });
      }),
      el('td', { class: 'actions' }, createIncomeActions(income)),
    ])
  );

  return el('div', { id: 'incomes-table-container', class: 'table-wrap' }, [
    el('table', { class: 'table' }, [
      el('thead', {}, [headWithActions]),
      el('tbody', {}, bodyWithActions),
    ]),
  ]);
}

/** Cria botões de ação para uma receita. */
function createIncomeActions(income) {
  const actions = [];

  if (income.status === 'pending') {
    actions.push(
      el('button', {
        type: 'button',
        class: 'btn btn--icon btn--success',
        'aria-label': `Marcar ${income.description} como recebida`,
        onClick: () => confirmMarkReceived(income),
        html: '<i data-lucide="check-circle-2" aria-hidden="true"></i>',
      })
    );
    actions.push(
      el('button', {
        type: 'button',
        class: 'btn btn--icon btn--danger',
        'aria-label': `Cancelar ${income.description}`,
        onClick: () => confirmCancelIncome(income),
        html: '<i data-lucide="x-circle" aria-hidden="true"></i>',
      })
    );
  }

  actions.push(
    el('button', {
      type: 'button',
      class: 'btn btn--icon',
      'aria-label': `Editar ${income.description}`,
      onClick: () => openIncomeModal(income),
      html: '<i data-lucide="edit-2" aria-hidden="true"></i>',
    })
  );

  if (income.status !== 'received') {
    actions.push(
      el('button', {
        type: 'button',
        class: 'btn btn--icon btn--danger',
        'aria-label': `Excluir ${income.description}`,
        onClick: () => confirmDeleteIncome(income),
        html: '<i data-lucide="trash-2" aria-hidden="true"></i>',
      })
    );
  }

  return actions;
}

/** Abre modal para criar/editar receita. */
function openIncomeModal(income = null) {
  const isEdit = !!income;
  const recurrences = getRecurrenceOptions();
  const statuses = getIncomeStatusOptions();
  const incomeCategories = categoriesCache.filter((c) => c.kind === 'income' || c.kind === 'both');
  const activeAccounts = accountsCache.filter((a) => a.status === 'active');

  const form = el('form', { id: 'income-form', novalidate: true }, [
    el('div', { class: 'form__row' }, [
      el('div', { class: 'form__field' }, [
        el('label', { for: 'description', text: 'Descrição *' }),
        el('input', {
          type: 'text',
          id: 'description',
          name: 'description',
          required: true,
          maxlength: 120,
          value: income?.description ?? '',
          autocomplete: 'off',
        }),
        el('span', { class: 'form__error', 'data-for': 'description' }),
      ]),
      el('div', { class: 'form__field' }, [
        el('label', { for: 'categoryId', text: 'Categoria *' }),
        el('select', {
          id: 'categoryId',
          name: 'categoryId',
          required: true,
        }, [
          el('option', { value: '', disabled: true, selected: !income }, 'Selecione uma categoria'),
          ...incomeCategories.map((c) =>
            el('option', { value: c.id, selected: income?.categoryId === c.id }, c.name)
          ),
        ]),
        el('span', { class: 'form__error', 'data-for': 'categoryId' }),
      ]),
    ]),
    el('div', { class: 'form__row' }, [
      el('div', { class: 'form__field' }, [
        el('label', { for: 'amountCents', text: 'Valor (R$) *' }),
        el('input', {
          type: 'text',
          id: 'amountCents',
          name: 'amountCents',
          required: true,
          placeholder: '0,00',
          value: income?.amountCents ? formatCentsInput(income.amountCents) : '',
          autocomplete: 'off',
        }),
        el('span', { class: 'form__error', 'data-for': 'amountCents' }),
      ]),
      el('div', { class: 'form__field' }, [
        el('label', { for: 'accountId', text: 'Conta *' }),
        el('select', {
          id: 'accountId',
          name: 'accountId',
          required: true,
        }, [
          el('option', { value: '', disabled: true, selected: !income }, 'Selecione uma conta'),
          ...activeAccounts.map((a) =>
            el('option', { value: a.id, selected: income?.accountId === a.id }, `${a.institution} — ${a.name}`)
          ),
        ]),
        el('span', { class: 'form__error', 'data-for': 'accountId' }),
      ]),
    ]),
    el('div', { class: 'form__row' }, [
      el('div', { class: 'form__field' }, [
        el('label', { for: 'expectedDate', text: 'Data prevista *' }),
        el('input', {
          type: 'date',
          id: 'expectedDate',
          name: 'expectedDate',
          required: true,
          value: income?.expectedDate ?? new Date().toISOString().split('T')[0],
        }),
        el('span', { class: 'form__error', 'data-for': 'expectedDate' }),
      ]),
      el('div', { class: 'form__field' }, [
        el('label', { for: 'recurrence', text: 'Recorrência *' }),
        el('select', {
          id: 'recurrence',
          name: 'recurrence',
          required: true,
        }, recurrences.map((r) =>
          el('option', { value: r.value, selected: income?.recurrence === r.value }, r.label)
        )),
        el('span', { class: 'form__error', 'data-for': 'recurrence' }),
      ]),
    ]),
    el('div', { class: 'form__row' }, [
      el('div', { class: 'form__field' }, [
        el('label', { for: 'receivedDate', text: 'Data de recebimento' }),
        el('input', {
          type: 'date',
          id: 'receivedDate',
          name: 'receivedDate',
          value: income?.receivedDate ?? '',
        }),
      ]),
      el('div', { class: 'form__field' }, [
        el('label', { for: 'status', text: 'Status *' }),
        el('select', {
          id: 'status',
          name: 'status',
          required: true,
        }, statuses.map((s) =>
          el('option', { value: s.value, selected: income?.status === s.value }, s.label)
        )),
        el('span', { class: 'form__error', 'data-for': 'status' }),
      ]),
    ]),
    el('div', { class: 'form__field' }, [
      el('label', { for: 'notes', text: 'Observações' }),
      el('textarea', {
        id: 'notes',
        name: 'notes',
        maxlength: 500,
        rows: 3,
        value: income?.notes ?? '',
      }),
    ]),
  ]);

  const footer = [
    el('button', { type: 'button', class: 'btn btn--secondary', onClick: closeModal, text: 'Cancelar' }),
    el('button', { type: 'submit', class: 'btn btn--primary', text: isEdit ? 'Salvar alterações' : 'Criar receita' }),
  ];

  const modal = openModal({
    title: isEdit ? `Editar receita: ${income.description}` : 'Nova receita',
    body: form,
    footer,
    onClose: () => form.removeEventListener('submit', handleSubmit),
  });

  const moneyInput = $('#amountCents', modal.overlay);
  moneyInput.addEventListener('blur', () => {
    const cents = parseMoneyToCents(moneyInput.value);
    moneyInput.value = cents !== null ? formatCentsInput(cents) : '';
  });

  async function handleSubmit(event) {
    event.preventDefault();
    const submitBtn = $('button[type="submit"]', form);
    submitBtn.disabled = true;
    submitBtn.textContent = 'Salvando...';

    const formData = new FormData(form);
    const rawData = {
      description: formData.get('description').trim(),
      categoryId: formData.get('categoryId'),
      amountCents: formData.get('amountCents'),
      expectedDate: formData.get('expectedDate'),
      receivedDate: formData.get('receivedDate') || undefined,
      accountId: formData.get('accountId'),
      status: formData.get('status'),
      recurrence: formData.get('recurrence'),
      notes: formData.get('notes').trim() || undefined,
    };

    clearErrors(form);
    const result = isEdit
      ? await updateIncome(currentUser.uid, income.id, rawData)
      : await createIncome(currentUser.uid, rawData);

    if (result.ok) {
      toast(isEdit ? 'Receita atualizada com sucesso.' : 'Receita criada com sucesso.');
      closeModal();
      await loadData();
      renderPage($('.content') || document.getElementById('page-content'));
    } else {
      showErrors(form, result.errors);
    }
    submitBtn.disabled = false;
    submitBtn.textContent = isEdit ? 'Salvar alterações' : 'Criar receita';
  }

  form.addEventListener('submit', handleSubmit);
  $('#description', form).focus();
}

/** Confirma marcar como recebida. */
async function confirmMarkReceived(income) {
  const result = await markIncomeReceived(currentUser.uid, income.id);
  if (result.ok) {
    toast('Receita marcada como recebida.');
    await loadData();
    renderPage($('.content') || document.getElementById('page-content'));
  } else {
    toast('Erro ao marcar como recebida.', 5000);
  }
}

/** Confirma cancelamento. */
async function confirmCancelIncome(income) {
  const result = await cancelIncome(currentUser.uid, income.id);
  if (result.ok) {
    toast('Receita cancelada.');
    await loadData();
    renderPage($('.content') || document.getElementById('page-content'));
  } else {
    toast('Erro ao cancelar.', 5000);
  }
}

/** Confirma exclusão. */
function confirmDeleteIncome(income) {
  const body = el('div', {}, [
    el('p', { text: `Tem certeza que deseja excluir a receita "${income.description}"?` }),
    el('p', { class: 'card__hint', text: 'Esta ação não pode ser desfeita.' }),
  ]);

  const footer = [
    el('button', { type: 'button', class: 'btn btn--secondary', onClick: closeModal, text: 'Cancelar' }),
    el('button', {
      type: 'button',
      class: 'btn btn--danger',
      onClick: async () => {
        closeModal();
        const result = await deleteIncome(currentUser.uid, income.id);
        if (result.ok) {
          toast('Receita excluída.');
          await loadData();
          renderPage($('.content') || document.getElementById('page-content'));
        } else {
          toast(`Erro: ${result.errors._form}`, 5000);
        }
      },
      text: 'Excluir',
    }),
  ];

  openModal({ title: 'Confirmar exclusão', body, footer });
}

/** Helpers. */
function formatCentsInput(cents) {
  const abs = Math.abs(Number(cents));
  const int = Math.trunc(abs / 100);
  const frac = String(abs % 100).padStart(2, '0');
  const sign = Number(cents) < 0 ? '-' : '';
  return `${sign}${int},${frac}`;
}

function getCategoryLabel(categoryId) {
  const cat = categoriesCache.find((c) => c.id === categoryId);
  return cat?.name ?? categoryId ?? '—';
}

function getStatusLabel(value) {
  const statuses = getIncomeStatusOptions();
  const found = statuses.find((s) => s.value === value);
  return found?.label ?? value;
}

function formatDate(value) {
  if (!value) return '—';
  const [y, m, d] = value.split('-');
  return `${d}/${m}/${y}`;
}

function clearErrors(form) {
  $$('.form__error', form).forEach((el) => (el.textContent = ''));
  $$('.form__field', form).forEach((el) => el.classList.remove('form__field--error'));
}

function showErrors(form, errors) {
  for (const [field, message] of Object.entries(errors)) {
    const errorEl = $(`.form__error[data-for="${field}"]`, form);
    const fieldEl = $(`#${field}`, form);
    if (errorEl) errorEl.textContent = message;
    if (fieldEl) fieldEl.closest('.form__field')?.classList.add('form__field--error');
  }
  if (errors._form) toast(errors._form, 5000);
}