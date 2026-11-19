/**
 * Transferências — Fase 3: CRUD completo integrado ao Firestore.
 * - Lista transferências com filtros
 * - Modal para criar/editar transferência
 * - Ações: confirmar, cancelar
 * - Validação client-side espelhando Security Rules (conta origem ≠ conta destino)
 * - Persistência em users/{uid}/transfers
 */
import { el, $, $$, toast, refreshIcons } from '../core/ui.js';
import { openModal, closeModal } from '../components/modal.js';
import {
  listTransfers,
  createTransfer,
  updateTransfer,
  deleteTransfer,
  confirmTransfer,
  cancelTransfer,
  getTransferStatusOptions,
  formatCents,
  parseMoneyToCents,
} from '../services/transfers.js';
import { listAccounts } from '../services/accounts.js';

export const meta = { title: 'Transferências', icon: 'arrow-left-right' };

let currentUser = null;
let transfersCache = [];
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
  [transfersCache, accountsCache] = await Promise.all([
    listTransfers(currentUser.uid),
    listAccounts(currentUser.uid),
  ]);
}

/** Renderiza a página completa. */
function renderPage(container) {
  const stats = computeStats();

  const header = el('section', { class: 'panel' }, [
    el('div', { class: 'panel__header' }, [
      el('span', { class: 'card__icon' }, [el('i', { 'data-lucide': 'arrow-left-right', 'aria-hidden': 'true' })]),
      el('div', {}, [
        el('h2', { text: 'Transferências' }),
        el('p', { class: 'card__hint', text: 'Movimentações entre contas e aportes em metas — nunca contam como receita ou despesa.' }),
      ]),
      el('div', { class: 'topbar__spacer' }),
      el('button', {
        type: 'button',
        class: 'btn btn--primary',
        onClick: () => openTransferModal(),
        html: '<i data-lucide="plus" aria-hidden="true"></i> Nova transferência',
      }),
    ]),
  ]);

  const cards = el('div', { class: 'grid grid--cards' }, [
    createStatCard('Transferido no mês', formatCents(stats.confirmedThisMonth), 'arrow-left-right', null, 'Apenas confirmadas movem saldo'),
    createStatCard('Pendentes', String(stats.pendingCount), 'clock', null, 'Aguardando confirmação'),
  ]);

  const filterBar = createFilterBar();
  const table = createTransfersTable();

  const nodes = [
    header,
    cards,
    filterBar,
    el('section', { class: 'panel' }, [
      el('div', { class: 'panel__header' }, [
        el('h2', { text: 'Transferências registradas' }),
        el('div', { class: 'topbar__spacer' }),
        el('span', { class: 'badge', text: `${getFilteredTransfers().length} registro${getFilteredTransfers().length !== 1 ? 's' : ''}` }),
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

  let confirmedThisMonth = 0;
  let pendingCount = 0;

  for (const transfer of transfersCache) {
    const date = new Date(transfer.date + 'T00:00:00');
    const isThisMonth = date >= startOfMonth && date <= endOfMonth;

    if (transfer.status === 'confirmed' && isThisMonth) {
      confirmedThisMonth += Number(transfer.amountCents) || 0;
    }
    if (transfer.status === 'pending') {
      pendingCount++;
    }
  }

  return { confirmedThisMonth, pendingCount };
}

/** Cria barra de filtros. */
function createFilterBar() {
  const statusOptions = [
    { value: 'all', label: 'Todos' },
    { value: 'pending', label: 'Pendentes' },
    { value: 'confirmed', label: 'Confirmadas' },
    { value: 'cancelled', label: 'Canceladas' },
  ];

  const monthOptions = [{ value: '', label: 'Todos os meses' }];
  const months = new Set();
  for (const transfer of transfersCache) {
    const m = transfer.date?.substring(0, 7);
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

/** Retorna transferências filtradas. */
function getFilteredTransfers() {
  return transfersCache.filter((transfer) => {
    if (currentFilter.status !== 'all' && transfer.status !== currentFilter.status) return false;
    if (currentFilter.month && !transfer.date?.startsWith(currentFilter.month)) return false;
    return true;
  });
}

/** Atualiza apenas a tabela. */
function refreshTable() {
  const tableContainer = $('#transfers-table-container');
  if (tableContainer) {
    tableContainer.replaceWith(createTransfersTable());
    refreshIcons();
  }
}

/** Cria a tabela de transferências. */
function createTransfersTable() {
  const filtered = getFilteredTransfers();

  if (!filtered.length) {
    return el('div', { id: 'transfers-table-container', class: 'empty' }, [
      el('div', { class: 'empty__icon' }, [el('i', { 'data-lucide': 'arrow-left-right', 'aria-hidden': 'true' })]),
      el('p', { class: 'empty__title', text: 'Nenhuma transferência encontrada' }),
      el('p', { class: 'empty__text', text: currentFilter.status !== 'all' || currentFilter.month
        ? 'Tente ajustar os filtros acima.'
        : 'Transfira entre contas mantendo o histórico auditável e o patrimônio correto.' }),
      (currentFilter.status !== 'all' || currentFilter.month) ? el('button', {
        type: 'button',
        class: 'btn btn--secondary',
        onClick: () => {
          currentFilter = { status: 'all', month: null };
          refreshTable();
        },
        text: 'Limpar filtros',
      }) : null,
    ]);
  }

  const columns = [
    { key: 'from', label: 'Origem', render: (v) => getAccountLabel(v) },
    { key: 'to', label: 'Destino', render: (v) => getAccountLabel(v) },
    { key: 'amount', label: 'Valor', numeric: true, render: (v) => formatCents(Number(v) || 0) },
    { key: 'date', label: 'Data', render: (v) => formatDate(v) },
    { key: 'reason', label: 'Motivo' },
    { key: 'status', label: 'Status', render: (v) => getStatusLabel(v) },
  ];

  const headWithActions = el('tr', {}, [
    ...columns.map((c) => el('th', { class: c.numeric ? 'num' : '', text: c.label })),
    el('th', { text: 'Ações' }),
  ]);

  const bodyWithActions = filtered.map((transfer) =>
    el('tr', {}, [
      ...columns.map((column) => {
        const value = transfer[column.key];
        const display = column.render ? column.render(value) : (value ?? '—');
        return el('td', {
          class: column.numeric ? 'num' : '',
          text: display,
        });
      }),
      el('td', { class: 'actions' }, createTransferActions(transfer)),
    ])
  );

  return el('div', { id: 'transfers-table-container', class: 'table-wrap' }, [
    el('table', { class: 'table' }, [
      el('thead', {}, [headWithActions]),
      el('tbody', {}, bodyWithActions),
    ]),
  ]);
}

/** Cria botões de ação para uma transferência. */
function createTransferActions(transfer) {
  const actions = [];

  if (transfer.status === 'pending') {
    actions.push(
      el('button', {
        type: 'button',
        class: 'btn btn--icon btn--success',
        'aria-label': `Confirmar transferência de ${formatCents(transfer.amountCents)}`,
        onClick: () => confirmTransferAction(transfer),
        html: '<i data-lucide="check-circle-2" aria-hidden="true"></i>',
      })
    );
    actions.push(
      el('button', {
        type: 'button',
        class: 'btn btn--icon btn--danger',
        'aria-label': `Cancelar transferência`,
        onClick: () => confirmCancelTransfer(transfer),
        html: '<i data-lucide="x-circle" aria-hidden="true"></i>',
      })
    );
  }

  actions.push(
    el('button', {
      type: 'button',
      class: 'btn btn--icon',
      'aria-label': `Editar transferência`,
      onClick: () => openTransferModal(transfer),
      html: '<i data-lucide="edit-2" aria-hidden="true"></i>',
    })
  );

  if (transfer.status !== 'confirmed') {
    actions.push(
      el('button', {
        type: 'button',
        class: 'btn btn--icon btn--danger',
        'aria-label': `Excluir transferência`,
        onClick: () => confirmDeleteTransfer(transfer),
        html: '<i data-lucide="trash-2" aria-hidden="true"></i>',
      })
    );
  }

  return actions;
}

/** Abre modal para criar/editar transferência. */
function openTransferModal(transfer = null) {
  const isEdit = !!transfer;
  const statuses = getTransferStatusOptions();
  const activeAccounts = accountsCache.filter((a) => a.status === 'active');

  const form = el('form', { id: 'transfer-form', novalidate: true }, [
    el('div', { class: 'form__row' }, [
      el('div', { class: 'form__field' }, [
        el('label', { for: 'fromAccountId', text: 'Conta de origem *' }),
        el('select', {
          id: 'fromAccountId',
          name: 'fromAccountId',
          required: true,
        }, [
          el('option', { value: '', disabled: true, selected: !transfer }, 'Selecione a conta de origem'),
          ...activeAccounts.map((a) =>
            el('option', { value: a.id, selected: transfer?.fromAccountId === a.id }, `${a.institution} — ${a.name}`)
          ),
        ]),
        el('span', { class: 'form__error', 'data-for': 'fromAccountId' }),
      ]),
      el('div', { class: 'form__field' }, [
        el('label', { for: 'toAccountId', text: 'Conta de destino *' }),
        el('select', {
          id: 'toAccountId',
          name: 'toAccountId',
          required: true,
        }, [
          el('option', { value: '', disabled: true, selected: !transfer }, 'Selecione a conta de destino'),
          ...activeAccounts.map((a) =>
            el('option', { value: a.id, selected: transfer?.toAccountId === a.id }, `${a.institution} — ${a.name}`)
          ),
        ]),
        el('span', { class: 'form__error', 'data-for': 'toAccountId' }),
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
          value: transfer?.amountCents ? formatCentsInput(transfer.amountCents) : '',
          autocomplete: 'off',
        }),
        el('span', { class: 'form__error', 'data-for': 'amountCents' }),
      ]),
      el('div', { class: 'form__field' }, [
        el('label', { for: 'date', text: 'Data *' }),
        el('input', {
          type: 'date',
          id: 'date',
          name: 'date',
          required: true,
          value: transfer?.date ?? new Date().toISOString().split('T')[0],
        }),
        el('span', { class: 'form__error', 'data-for': 'date' }),
      ]),
    ]),
    el('div', { class: 'form__row' }, [
      el('div', { class: 'form__field' }, [
        el('label', { for: 'reason', text: 'Motivo *' }),
        el('input', {
          type: 'text',
          id: 'reason',
          name: 'reason',
          required: true,
          maxlength: 120,
          value: transfer?.reason ?? '',
          placeholder: 'Ex.: Reserva, investimento, aporte em meta...',
          autocomplete: 'off',
        }),
        el('span', { class: 'form__error', 'data-for': 'reason' }),
      ]),
      el('div', { class: 'form__field' }, [
        el('label', { for: 'status', text: 'Status *' }),
        el('select', {
          id: 'status',
          name: 'status',
          required: true,
        }, statuses.map((s) =>
          el('option', { value: s.value, selected: transfer?.status === s.value }, s.label)
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
        value: transfer?.notes ?? '',
      }),
    ]),
  ]);

  const footer = [
    el('button', { type: 'button', class: 'btn btn--secondary', onClick: closeModal, text: 'Cancelar' }),
    el('button', { type: 'submit', class: 'btn btn--primary', text: isEdit ? 'Salvar alterações' : 'Criar transferência' }),
  ];

  const modal = openModal({
    title: isEdit ? `Editar transferência: ${transfer.reason}` : 'Nova transferência',
    body: form,
    footer,
    onClose: () => form.removeEventListener('submit', handleSubmit),
  });

  const moneyInput = $('#amountCents', modal.overlay);
  moneyInput.addEventListener('blur', () => {
    const cents = parseMoneyToCents(moneyInput.value);
    moneyInput.value = cents !== null ? formatCentsInput(cents) : '';
  });

  // Validação de conta origem ≠ destino
  const fromSelect = $('#fromAccountId', form);
  const toSelect = $('#toAccountId', form);
  const validateAccounts = () => {
    if (fromSelect.value && toSelect.value && fromSelect.value === toSelect.value) {
      toSelect.setCustomValidity('A conta de destino deve ser diferente da conta de origem.');
      toSelect.reportValidity();
    } else {
      toSelect.setCustomValidity('');
    }
  };
  fromSelect.addEventListener('change', validateAccounts);
  toSelect.addEventListener('change', validateAccounts);

  async function handleSubmit(event) {
    event.preventDefault();
    const submitBtn = $('button[type="submit"]', form);
    submitBtn.disabled = true;
    submitBtn.textContent = 'Salvando...';

    const formData = new FormData(form);
    const rawData = {
      fromAccountId: formData.get('fromAccountId'),
      toAccountId: formData.get('toAccountId'),
      amountCents: formData.get('amountCents'),
      date: formData.get('date'),
      reason: formData.get('reason').trim(),
      status: formData.get('status'),
      notes: formData.get('notes').trim() || undefined,
    };

    clearErrors(form);
    const result = isEdit
      ? await updateTransfer(currentUser.uid, transfer.id, rawData)
      : await createTransfer(currentUser.uid, rawData);

    if (result.ok) {
      toast(isEdit ? 'Transferência atualizada com sucesso.' : 'Transferência criada com sucesso.');
      closeModal();
      await loadData();
      renderPage($('.content') || document.getElementById('page-content'));
    } else {
      showErrors(form, result.errors);
    }
    submitBtn.disabled = false;
    submitBtn.textContent = isEdit ? 'Salvar alterações' : 'Criar transferência';
  }

  form.addEventListener('submit', handleSubmit);
  $('#fromAccountId', form).focus();
}

/** Confirma transferência. */
async function confirmTransferAction(transfer) {
  const result = await confirmTransfer(currentUser.uid, transfer.id);
  if (result.ok) {
    toast('Transferência confirmada — saldo das contas atualizado.');
    await loadData();
    renderPage($('.content') || document.getElementById('page-content'));
  } else {
    toast(result.errors?._form || 'Erro ao confirmar transferência.', 5000);
  }
}

/** Confirma cancelamento. */
async function confirmCancelTransfer(transfer) {
  const result = await cancelTransfer(currentUser.uid, transfer.id);
  if (result.ok) {
    toast('Transferência cancelada.');
    await loadData();
    renderPage($('.content') || document.getElementById('page-content'));
  } else {
    toast(result.errors?._form || 'Erro ao cancelar.', 5000);
  }
}

/** Confirma exclusão. */
function confirmDeleteTransfer(transfer) {
  const body = el('div', {}, [
    el('p', { text: `Tem certeza que deseja excluir a transferência "${transfer.reason}"?` }),
    el('p', { class: 'card__hint', text: 'Esta ação não pode ser desfeita. Transferências confirmadas não podem ser excluídas (apenas canceladas).' }),
  ]);

  const footer = [
    el('button', { type: 'button', class: 'btn btn--secondary', onClick: closeModal, text: 'Cancelar' }),
    el('button', {
      type: 'button',
      class: 'btn btn--danger',
      onClick: async () => {
        closeModal();
        const result = await deleteTransfer(currentUser.uid, transfer.id);
        if (result.ok) {
          toast('Transferência excluída.');
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

function getAccountLabel(accountId) {
  const acc = accountsCache.find((a) => a.id === accountId);
  return acc ? `${acc.institution} — ${acc.name}` : accountId ?? '—';
}

function getStatusLabel(value) {
  const statuses = getTransferStatusOptions();
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
