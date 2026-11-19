/**
 * Bancos/Contas — Fase 3: CRUD completo integrado ao Firestore.
 * - Lista contas (até 200); saldo atual derivado calculado sob demanda (botão), saldo inicial sempre visível
 * - Modal para criar/editar conta
 * - Validação client-side espelhando Security Rules
 * - Persistência em users/{uid}/accounts
 */
import { el, $, toast, refreshIcons } from '../core/ui.js';
import { openModal, closeModal } from '../components/modal.js';
import { createStatCard } from '../components/stat-card.js';
import { formatCentsInput, clearErrors, showFormErrors as showErrors } from '../components/form-kit.js';
import { loadBalances, READ_LIMIT } from '../services/balances.js';
import {
  listAccounts,
  createAccount,
  updateAccount,
  deleteAccount,
  getAccountTypeOptions,
  getStatusOptions,
  formatCents,
  parseMoneyToCents,
} from '../services/accounts.js';
import { listCategories } from '../services/categories.js';

export const meta = { title: 'Bancos', icon: 'landmark' };

let currentUser = null;
let accountsCache = [];
let categoriesCache = [];
/** Teto de contas listadas (VF-4-03); ao atingir, a página avisa. */
const ACCOUNT_LIST_LIMIT = 200;
/** Saldos derivados, calculados SOB DEMANDA (lê movimentos; poupa a cota de leituras): null = não calculado. */
let derived = null;

/** Render principal do módulo. */
export async function render(container, { user }) {
  currentUser = user;
  await loadData();
  renderPage(container);
}

/** Carrega dados iniciais. */
async function loadData() {
  [accountsCache, categoriesCache] = await Promise.all([
    listAccounts(currentUser.uid, { limit: ACCOUNT_LIST_LIMIT }),
    listCategories(currentUser.uid),
  ]);
  derived = null; // dados mudaram: o saldo derivado anterior ficou obsoleto
}

/** Calcula o saldo atual derivado (receitas recebidas, despesas pagas, transferências, recebimentos, metas). */
async function calculateBalances() {
  const result = await loadBalances(currentUser.uid, accountsCache);
  derived = result;
  renderPage($('.content') || document.getElementById('page-content'));
  if (result.truncated.length) toast('Leitura limitada: o saldo pode estar incompleto.', 6000);
}

/** Renderiza a página completa. */
function renderPage(container) {
  const stats = computeStats();

  const header = el('section', { class: 'panel' }, [
    el('div', { class: 'panel__header' }, [
      el('span', { class: 'card__icon' }, [el('i', { 'data-lucide': 'landmark', 'aria-hidden': 'true' })]),
      el('div', {}, [
        el('h2', { text: 'Bancos e contas' }),
        el('p', { class: 'card__hint', text: 'Instituições, tipos de conta e saldo calculado a partir das movimentações.' }),
      ]),
      el('div', { class: 'topbar__spacer' }),
      el('button', {
        type: 'button',
        class: 'btn btn--secondary',
        id: 'calc-balances',
        onClick: calculateBalances,
        text: derived ? 'Recalcular saldo atual' : 'Calcular saldo atual',
      }),
      el('button', {
        type: 'button',
        class: 'btn btn--primary',
        onClick: () => openAccountModal(),
        html: '<i data-lucide="plus" aria-hidden="true"></i> Nova conta',
      }),
    ]),
  ]);

  const cards = el('div', { class: 'grid grid--cards' }, [
    createStatCard('Saldo total', formatCents(stats.totalBalance), 'wallet', 'income', derived
      ? 'Saldo atual derivado das movimentações (contas ativas)'
      : 'Soma dos saldos iniciais; use "Calcular saldo atual" para incluir as movimentações'),
    createStatCard('Contas ativas', String(stats.activeCount), 'landmark', null, 'Contas com status "ativo"'),
  ]);

  const table = createAccountsTable();

  const limitNotice = accountsCache.length >= ACCOUNT_LIST_LIMIT
    ? el('p', { class: 'notice', role: 'status', text: `Exibindo as primeiras ${ACCOUNT_LIST_LIMIT} contas (limite de leitura).` })
    : null;
  const balanceNotice = derived?.truncated.length
    ? el('p', { class: 'notice', role: 'status', text: `Leitura limitada a ${READ_LIMIT} movimentos por tipo (${derived.truncated.join(', ')}): o saldo atual pode estar incompleto.` })
    : null;

  const nodes = [
    header,
    cards,
    limitNotice,
    balanceNotice,
    el('section', { class: 'panel' }, [
      el('div', { class: 'panel__header' }, [
        el('h2', { text: 'Contas cadastradas' }),
        el('div', { class: 'topbar__spacer' }),
        el('span', { class: 'badge', text: `${accountsCache.length} registro${accountsCache.length !== 1 ? 's' : ''}` }),
      ]),
      el('div', { class: 'panel__body panel__body--flush' }, [table]),
    ]),
  ];

  container.replaceChildren(...nodes.filter(Boolean));
  refreshIcons();
}

/** Computa estatísticas rápidas. */
function computeStats() {
  const activeAccounts = accountsCache.filter((a) => a.status === 'active');
  // Saldo total: derivado quando calculado sob demanda; senão, soma dos saldos iniciais.
  const totalBalance = activeAccounts.reduce((sum, acc) => sum + (derived
    ? (derived.balances.get(acc.id) ?? 0)
    : (Number(acc.initialBalanceCents) || 0)), 0);
  return { totalBalance, activeCount: activeAccounts.length };
}

/** Cria a tabela de contas. */
function createAccountsTable() {
  if (!accountsCache.length) {
    return el('div', { class: 'empty' }, [
      el('div', { class: 'empty__icon' }, [el('i', { 'data-lucide': 'landmark', 'aria-hidden': 'true' })]),
      el('p', { class: 'empty__title', text: 'Nenhuma conta cadastrada' }),
      el('p', { class: 'empty__text', text: 'Cadastre sua primeira instituição para começar a acompanhar entradas e saídas.' }),
      el('button', {
        type: 'button',
        class: 'btn btn--primary',
        onClick: () => openAccountModal(),
        text: 'Criar primeira conta',
      }),
    ]);
  }

  const columns = [
    { key: 'institution', label: 'Instituição' },
    { key: 'name', label: 'Conta' },
    { key: 'type', label: 'Tipo', render: (v) => getTypeLabel(v) },
    { key: 'initialBalanceCents', label: 'Saldo inicial', numeric: true, render: (v) => formatCents(Number(v) || 0) },
    ...(derived ? [{ key: 'id', label: 'Saldo atual', numeric: true, render: (v) => formatCents(derived.balances.get(v) ?? 0) }] : []),
    { key: 'status', label: 'Status', render: (v) => getStatusLabel(v) },
  ];

  const head = el('tr', {}, columns.map((c) =>
    el('th', { class: c.numeric ? 'num' : '', text: c.label })
  ));

  const body = accountsCache.map((account) =>
    el('tr', {}, columns.map((column) => {
      const value = account[column.key];
      const display = column.render ? column.render(value) : (value ?? '—');
      return el('td', {
        class: column.numeric ? 'num' : '',
        text: display,
      });
    }))
  );

  // Adiciona coluna de ações
  const headWithActions = el('tr', {}, [
    ...columns.map((c) => el('th', { class: c.numeric ? 'num' : '', text: c.label })),
    el('th', { text: 'Ações' }),
  ]);

  const bodyWithActions = accountsCache.map((account) =>
    el('tr', {}, [
      ...columns.map((column) => {
        const value = account[column.key];
        const display = column.render ? column.render(value) : (value ?? '—');
        return el('td', {
          class: column.numeric ? 'num' : '',
          text: display,
        });
      }),
      el('td', { class: 'actions' }, [
        el('button', {
          type: 'button',
          class: 'btn btn--icon',
          'aria-label': `Editar ${account.name}`,
          onClick: () => openAccountModal(account),
          html: '<i data-lucide="edit-2" aria-hidden="true"></i>',
        }),
        el('button', {
          type: 'button',
          class: 'btn btn--icon btn--danger',
          'aria-label': `Excluir ${account.name}`,
          onClick: () => confirmDeleteAccount(account),
          html: '<i data-lucide="trash-2" aria-hidden="true"></i>',
        }),
      ]),
    ])
  );

  return el('div', { class: 'table-wrap' }, [
    el('table', { class: 'table' }, [
      el('thead', {}, [headWithActions]),
      el('tbody', {}, bodyWithActions),
    ]),
  ]);
}

/** Abre modal para criar/editar conta. */
function openAccountModal(account = null) {
  const isEdit = !!account;
  const types = getAccountTypeOptions();
  const statuses = getStatusOptions();

  const form = el('form', { id: 'account-form', novalidate: true }, [
    el('div', { class: 'form__row' }, [
      el('div', { class: 'form__field' }, [
        el('label', { for: 'institution', text: 'Instituição *' }),
        el('input', {
          type: 'text',
          id: 'institution',
          name: 'institution',
          required: true,
          maxlength: 80,
          value: account?.institution ?? '',
          autocomplete: 'off',
        }),
        el('span', { class: 'form__error', 'data-for': 'institution' }),
      ]),
      el('div', { class: 'form__field' }, [
        el('label', { for: 'name', text: 'Nome da conta *' }),
        el('input', {
          type: 'text',
          id: 'name',
          name: 'name',
          required: true,
          maxlength: 80,
          value: account?.name ?? '',
          autocomplete: 'off',
        }),
        el('span', { class: 'form__error', 'data-for': 'name' }),
      ]),
    ]),
    el('div', { class: 'form__row' }, [
      el('div', { class: 'form__field' }, [
        el('label', { for: 'type', text: 'Tipo *' }),
        el('select', {
          id: 'type',
          name: 'type',
          required: true,
        }, types.map((t) =>
          el('option', { value: t.value, selected: account?.type === t.value }, t.label)
        )),
        el('span', { class: 'form__error', 'data-for': 'type' }),
      ]),
      el('div', { class: 'form__field' }, [
        el('label', { for: 'status', text: 'Status *' }),
        el('select', {
          id: 'status',
          name: 'status',
          required: true,
        }, statuses.map((s) =>
          el('option', { value: s.value, selected: account?.status === s.value }, s.label)
        )),
        el('span', { class: 'form__error', 'data-for': 'status' }),
      ]),
    ]),
    el('div', { class: 'form__row' }, [
      el('div', { class: 'form__field' }, [
        el('label', { for: 'initialBalanceCents', text: 'Saldo inicial (R$)' }),
        el('input', {
          type: 'text',
          id: 'initialBalanceCents',
          name: 'initialBalanceCents',
          value: account?.initialBalanceCents ? formatCentsInput(account.initialBalanceCents) : '',
          placeholder: '0,00',
          autocomplete: 'off',
        }),
        el('span', { class: 'form__error', 'data-for': 'initialBalanceCents' }),
      ]),
      el('div', { class: 'form__field' }, [
        el('label', { for: 'color', text: 'Cor (hex)' }),
        el('input', {
          type: 'color',
          id: 'color',
          name: 'color',
          value: account?.color ?? '#1f7a5c',
        }),
      ]),
    ]),
  ]);

  const footer = [
    el('button', {
      type: 'button',
      class: 'btn btn--secondary',
      onClick: closeModal,
      text: 'Cancelar',
    }),
    el('button', {
      type: 'submit',
      class: 'btn btn--primary',
      text: isEdit ? 'Salvar alterações' : 'Criar conta',
    }),
  ];

  const modal = openModal({
    title: isEdit ? `Editar conta: ${account.name}` : 'Nova conta',
    body: form,
    footer,
    onClose: () => form.removeEventListener('submit', handleSubmit),
  });

  // Formatação de dinheiro no input
  const moneyInput = $('#initialBalanceCents', modal.overlay);
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
      institution: formData.get('institution').trim(),
      name: formData.get('name').trim(),
      type: formData.get('type'),
      initialBalanceCents: formData.get('initialBalanceCents') || '0',
      color: formData.get('color') || '#1f7a5c',
      status: formData.get('status'),
    };

    clearErrors(form);
    const result = isEdit
      ? await updateAccount(currentUser.uid, account.id, rawData)
      : await createAccount(currentUser.uid, rawData);

    if (result.ok) {
      toast(isEdit ? 'Conta atualizada com sucesso.' : 'Conta criada com sucesso.');
      closeModal();
      await loadData();
      renderPage($('.content') || document.getElementById('page-content'));
    } else {
      showErrors(form, result.errors);
    }
    submitBtn.disabled = false;
    submitBtn.textContent = isEdit ? 'Salvar alterações' : 'Criar conta';
  }

  form.addEventListener('submit', handleSubmit);
  $('#institution', form).focus();
}

/** Confirma exclusão de conta. */
function confirmDeleteAccount(account) {
  const body = el('div', {}, [
    el('p', { text: `Tem certeza que deseja excluir a conta "${account.name}"?` }),
    el('p', { class: 'card__hint', text: 'Esta ação não pode ser desfeita. Contas com movimentações vinculadas não podem ser excluídas — nesse caso, arquive a conta (status "Arquivada").' }),
  ]);

  const footer = [
    el('button', { type: 'button', class: 'btn btn--secondary', onClick: closeModal, text: 'Cancelar' }),
    el('button', {
      type: 'button',
      class: 'btn btn--danger',
      onClick: async () => {
        closeModal();
        const result = await deleteAccount(currentUser.uid, account.id);
        if (result.ok) {
          toast('Conta excluída.');
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

function getTypeLabel(value) {
  const types = getAccountTypeOptions();
  const found = types.find((t) => t.value === value);
  return found?.label ?? value;
}

function getStatusLabel(value) {
  const statuses = getStatusOptions();
  const found = statuses.find((s) => s.value === value);
  return found?.label ?? value;
}
