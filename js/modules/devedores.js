/**
 * Devedores — VF-2-03b: CRUD integrado ao Firestore (users/{uid}/debtors).
 * Pendente = emprestado − recebido (derivado, nunca gravado). Parcelas e recebimentos: VF-2-03b2.
 */
import { el, $, $$, toast, refreshIcons } from '../core/ui.js';
import { openModal, closeModal } from '../components/modal.js';
import {
  listDebtors,
  createDebtor,
  updateDebtor,
  deleteDebtor,
  cancelDebtor,
  reopenDebtor,
  getDebtorStatusOptions,
  summarizeDebtors,
  debtorPendingCents,
  formatCents,
  parseMoneyToCents,
} from '../services/debtors.js';

export const meta = { title: 'Devedores', icon: 'users' };

let currentUser = null;
let container = null;
let debtorsCache = [];

export async function render(target, { user }) {
  currentUser = user;
  container = target;
  await reload();
}

async function reload() {
  debtorsCache = await listDebtors(currentUser.uid);
  renderPage();
}

function renderPage() {
  const summary = summarizeDebtors(debtorsCache);
  const count = debtorsCache.length;

  const header = el('section', { class: 'panel' }, [
    el('div', { class: 'panel__header' }, [
      el('span', { class: 'card__icon' }, [el('i', { 'data-lucide': 'users', 'aria-hidden': 'true' })]),
      el('div', {}, [
        el('h2', { text: 'Devedores' }),
        el('p', { class: 'card__hint', text: 'Empréstimos pessoais e saldo pendente por pessoa.' }),
      ]),
      el('div', { class: 'topbar__spacer' }),
      el('button', {
        type: 'button',
        class: 'btn btn--primary',
        onClick: () => openDebtorModal(),
        html: '<i data-lucide="plus" aria-hidden="true"></i> Novo devedor',
      }),
    ]),
  ]);

  const cards = el('div', { class: 'grid grid--cards' }, [
    statCard('A receber', formatCents(summary.pendingCents), 'hand-coins', `Saldo pendente de ${summary.openCount} em aberto`),
    statCard('Recebido', formatCents(summary.receivedCents), 'check-circle-2', 'Total já devolvido (não cancelados)'),
  ]);

  const panel = el('section', { class: 'panel' }, [
    el('div', { class: 'panel__header' }, [
      el('h2', { text: 'Devedores cadastrados' }),
      el('div', { class: 'topbar__spacer' }),
      el('span', { class: 'badge', text: `${count} registro${count !== 1 ? 's' : ''}` }),
    ]),
    el('div', { class: 'panel__body panel__body--flush' }, [createTableOrEmpty()]),
  ]);

  container.replaceChildren(header, cards, panel);
  refreshIcons();
}

function statCard(label, value, icon, hint) {
  return el('article', { class: 'card' }, [
    el('div', { class: 'card__icon' }, [el('i', { 'data-lucide': icon, 'aria-hidden': 'true' })]),
    el('div', { class: 'card__content' }, [
      el('p', { class: 'card__label', text: label }),
      el('p', { class: 'card__value', text: value }),
    ]),
    el('p', { class: 'card__hint', text: hint }),
  ]);
}

function createTableOrEmpty() {
  if (!debtorsCache.length) {
    return el('div', { class: 'empty' }, [
      el('div', { class: 'empty__icon' }, [el('i', { 'data-lucide': 'users', 'aria-hidden': 'true' })]),
      el('p', { class: 'empty__title', text: 'Nenhum devedor cadastrado' }),
      el('p', { class: 'empty__text', text: 'Registre valores emprestados para acompanhar o saldo pendente por pessoa.' }),
    ]);
  }

  const columns = [
    { key: 'name', label: 'Pessoa' },
    { key: 'loanDate', label: 'Empréstimo', render: (v) => formatDate(v) },
    { key: 'lentCents', label: 'Emprestado', numeric: true, render: (v) => formatCents(Number(v) || 0) },
    { key: 'receivedCents', label: 'Recebido', numeric: true, render: (v) => formatCents(Number(v) || 0) },
    { key: 'pending', label: 'Pendente', numeric: true, render: (_, item) => formatCents(debtorPendingCents(item)) },
    { key: 'status', label: 'Status', render: (v) => optionLabel(getDebtorStatusOptions(), v) },
  ];

  return el('div', { class: 'table-wrap' }, [
    el('table', { class: 'table' }, [
      el('thead', {}, [
        el('tr', {}, [
          ...columns.map((c) => el('th', { class: c.numeric ? 'num' : '', text: c.label })),
          el('th', { text: 'Ações' }),
        ]),
      ]),
      el('tbody', {}, debtorsCache.map((item) =>
        el('tr', {}, [
          ...columns.map((c) => el('td', {
            class: c.numeric ? 'num' : '',
            text: c.render ? c.render(item[c.key], item) : (item[c.key] ?? '—'),
          })),
          el('td', { class: 'actions' }, createActions(item)),
        ])
      )),
    ]),
  ]);
}

function iconButton(label, icon, onClick, extraClass = '') {
  return el('button', {
    type: 'button',
    class: `btn btn--icon ${extraClass}`.trim(),
    'aria-label': label,
    onClick,
    html: `<i data-lucide="${icon}" aria-hidden="true"></i>`,
  });
}

function createActions(item) {
  const actions = [];
  if (item.status === 'open') {
    actions.push(iconButton(`Editar ${item.name}`, 'edit-2', () => openDebtorModal(item)));
    actions.push(iconButton(`Cancelar ${item.name}`, 'x-circle', () => confirmCancel(item), 'btn--danger'));
  }
  if (item.status === 'cancelled') {
    actions.push(iconButton(`Reabrir ${item.name}`, 'rotate-ccw', () => changeStatus(item, reopenDebtor, 'Devedor reaberto.'), 'btn--success'));
  }
  actions.push(iconButton(`Excluir ${item.name}`, 'trash-2', () => confirmDelete(item), 'btn--danger'));
  return actions;
}

async function changeStatus(item, fn, successMessage) {
  const result = await fn(currentUser.uid, item.id);
  if (result.ok) {
    toast(successMessage);
    await reload();
  } else {
    toast(result.errors?._form ?? 'Erro ao alterar o status.', 5000);
  }
}

function confirmCancel(item) {
  const body = el('div', {}, [
    el('p', { text: `Cancelar o registro de "${item.name}"?` }),
    el('p', { class: 'card__hint', text: 'O valor deixa de contar em "A receber". Você pode reabrir depois.' }),
  ]);
  const footer = [
    el('button', { type: 'button', class: 'btn btn--secondary', onClick: closeModal, text: 'Voltar' }),
    el('button', {
      type: 'button',
      class: 'btn btn--danger',
      onClick: async () => {
        closeModal();
        await changeStatus(item, cancelDebtor, 'Devedor cancelado.');
      },
      text: 'Cancelar registro',
    }),
  ];
  openModal({ title: 'Confirmar cancelamento', body, footer });
}

function confirmDelete(item) {
  const body = el('div', {}, [
    el('p', { text: `Tem certeza que deseja excluir "${item.name}"?` }),
    el('p', { class: 'card__hint', text: 'Esta ação não pode ser desfeita. Para manter o histórico, prefira cancelar.' }),
  ]);
  const footer = [
    el('button', { type: 'button', class: 'btn btn--secondary', onClick: closeModal, text: 'Cancelar' }),
    el('button', {
      type: 'button',
      class: 'btn btn--danger',
      onClick: async () => {
        closeModal();
        const result = await deleteDebtor(currentUser.uid, item.id);
        if (result.ok) {
          toast('Devedor excluído.');
          await reload();
        } else {
          toast(`Erro: ${result.errors._form}`, 6000);
        }
      },
      text: 'Excluir',
    }),
  ];
  openModal({ title: 'Confirmar exclusão', body, footer });
}

function field(label, id, control) {
  return el('div', { class: 'form__field' }, [
    el('label', { for: id, text: label }),
    control,
    el('span', { class: 'form__error', 'data-for': id }),
  ]);
}

function openDebtorModal(item = null) {
  const isEdit = !!item;
  const today = new Date().toISOString().split('T')[0];

  const form = el('form', { id: 'debtor-form', novalidate: true }, [
    el('div', { class: 'form__row' }, [
      field('Pessoa *', 'name', el('input', {
        type: 'text', id: 'name', name: 'name', required: true, maxlength: 80,
        value: item?.name ?? '', autocomplete: 'off',
      })),
      field('Valor emprestado (R$) *', 'lentCents', el('input', {
        type: 'text', id: 'lentCents', name: 'lentCents', required: true, placeholder: '0,00',
        value: item?.lentCents ? formatCentsInput(item.lentCents) : '', autocomplete: 'off',
      })),
    ]),
    field('Data do empréstimo *', 'loanDate', el('input', {
      type: 'date', id: 'loanDate', name: 'loanDate', required: true, value: item?.loanDate ?? today,
    })),
    el('div', { class: 'form__field' }, [
      el('label', { for: 'notes', text: 'Observações' }),
      el('textarea', { id: 'notes', name: 'notes', maxlength: 500, rows: 3, value: item?.notes ?? '' }),
    ]),
  ]);

  const footer = [
    el('button', { type: 'button', class: 'btn btn--secondary', onClick: closeModal, text: 'Cancelar' }),
    el('button', { type: 'submit', class: 'btn btn--primary', text: isEdit ? 'Salvar alterações' : 'Criar devedor' }),
  ];

  const modal = openModal({
    title: isEdit ? `Editar devedor: ${item.name}` : 'Novo devedor',
    body: form,
    footer,
    onClose: () => form.removeEventListener('submit', handleSubmit),
  });

  const moneyInput = $('#lentCents', modal.overlay);
  moneyInput.addEventListener('blur', () => {
    const cents = parseMoneyToCents(moneyInput.value);
    moneyInput.value = cents !== null ? formatCentsInput(cents) : '';
  });

  async function handleSubmit(event) {
    event.preventDefault();
    const submitBtn = $('button[type="submit"]', form);
    submitBtn.disabled = true;
    submitBtn.textContent = 'Salvando...';

    const data = new FormData(form);
    const rawData = {
      name: data.get('name').trim(),
      lentCents: data.get('lentCents'),
      loanDate: data.get('loanDate'),
      notes: data.get('notes').trim() || undefined,
    };

    clearErrors(form);
    const result = isEdit
      ? await updateDebtor(currentUser.uid, item.id, rawData)
      : await createDebtor(currentUser.uid, rawData);

    if (result.ok) {
      toast(isEdit ? 'Devedor atualizado com sucesso.' : 'Devedor criado com sucesso.');
      closeModal();
      await reload();
    } else {
      showErrors(form, result.errors);
    }
    submitBtn.disabled = false;
    submitBtn.textContent = isEdit ? 'Salvar alterações' : 'Criar devedor';
  }

  form.addEventListener('submit', handleSubmit);
  $('#name', form).focus();
}

function formatCentsInput(cents) {
  const abs = Math.abs(Number(cents));
  return `${Number(cents) < 0 ? '-' : ''}${Math.trunc(abs / 100)},${String(abs % 100).padStart(2, '0')}`;
}

function optionLabel(options, value) {
  return options.find((o) => o.value === value)?.label ?? value ?? '—';
}

function formatDate(value) {
  if (!value) return '—';
  const [y, m, d] = value.split('-');
  return `${d}/${m}/${y}`;
}

function clearErrors(form) {
  $$('.form__error', form).forEach((node) => (node.textContent = ''));
  $$('.form__field', form).forEach((node) => node.classList.remove('form__field--error'));
}

function showErrors(form, errors) {
  for (const [name, message] of Object.entries(errors)) {
    const errorEl = $(`.form__error[data-for="${name}"]`, form);
    const fieldEl = $(`#${name}`, form);
    if (errorEl) errorEl.textContent = message;
    if (fieldEl) fieldEl.closest('.form__field')?.classList.add('form__field--error');
  }
  if (errors._form) toast(errors._form, 5000);
}
