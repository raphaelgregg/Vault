/**
 * Cartões — VF-2-03d (UI). Cartões, compras (à vista/parceladas) e faturas.
 * Limite usado/disponível e total de fatura aberta são derivados; fechar grava o total e pagar
 * marca a fatura como paga (não movimenta conta — ver js/services/creditCards.js).
 */
import { el, toast, refreshIcons } from '../core/ui.js';
import { openModal, closeModal } from '../components/modal.js';
import {
  field,
  iconButton,
  statCard,
  panelHeader,
  emptyBlock,
  dataTable,
  confirmModal,
  formModal,
  formatCentsInput,
  formatDate,
  formatMonth,
  optionLabel,
  selectOptions,
} from '../components/form-kit.js';
import {
  listCards, createCard, updateCard, deleteCard, blockCard, unblockCard, cancelCard,
  registerCardPurchase, deleteCardPurchase, closeInvoice, payInvoice,
  listInvoices, listCardPurchases, getCardLimitUsage, getCardStatusOptions, getInvoiceStatusOptions, formatCents,
} from '../services/creditCards.js';
import { listAccounts } from '../services/accounts.js';
import { listCategories } from '../services/categories.js';
import { listOpenDebtors } from '../services/debtors.js';
import { describeError } from '../utils/errors.js';
import { invoiceTotalCents, debtorPendingCents } from '../core/model.js';

export const meta = { title: 'Cartões', icon: 'credit-card' };

let user = null;
let container = null;
let cards = [];
let usage = new Map();
let accounts = [];
let categories = [];
let openDebtors = [];
let debtorsFailed = null; // mensagem de diagnóstico quando a leitura falha

export async function render(target, ctx) {
  user = ctx.user;
  container = target;
  [accounts, categories] = await Promise.all([listAccounts(user.uid), listCategories(user.uid)]);
  await loadOpenDebtors();
  await reload();
}

/** Devedores em aberto (vínculo opcional na compra); falha aqui não impede a tela. Relido a cada compra. */
async function loadOpenDebtors() {
  try {
    openDebtors = await listOpenDebtors(user.uid);
    debtorsFailed = null;
  } catch (error) {
    console.error('[cartoes] falha ao listar devedores', error);
    openDebtors = [];
    // Diagnóstico visível: mensagem amigável + código técnico (ex.: failed-precondition = índice ausente).
    debtorsFailed = `${describeError(error)} [${error?.code ?? error?.name ?? 'erro'}]`;
  }
}

async function reload() {
  cards = await listCards(user.uid);
  const entries = await Promise.all(cards.map(async (c) => [c.id, await getCardLimitUsage(user.uid, c.id)]));
  usage = new Map(entries);
  renderPage();
}

const accountLabel = (id) => {
  const a = accounts.find((x) => x.id === id);
  return a ? `${a.institution} — ${a.name}` : '—';
};

function renderPage() {
  const live = cards.filter((c) => c.status !== 'cancelled');
  const limit = live.reduce((t, c) => t + c.limitCents, 0);
  const used = live.reduce((t, c) => t + (usage.get(c.id)?.usedCents ?? 0), 0);

  const header = panelHeader({
    icon: 'credit-card', title: 'Cartões de crédito', hint: 'Limites, compras parceladas e faturas.',
    actionLabel: 'Novo cartão', onAction: () => openCardModal(),
  });
  const stats = el('div', { class: 'grid grid--cards' }, [
    statCard('Limite total', formatCents(limit), 'credit-card', `${live.length} cartão(ões) não cancelado(s)`),
    statCard('Utilizado', formatCents(used), 'receipt', 'Compras em faturas ainda não pagas', 'expense'),
    statCard('Disponível', formatCents(Math.max(0, limit - used)), 'wallet', 'Limite − utilizado'),
  ]);

  const columns = [
    { key: 'name', label: 'Cartão', render: (v, c) => `${v} (${c.brand})` },
    { key: 'limitCents', label: 'Limite', numeric: true, render: (v) => formatCents(v) },
    { key: 'used', label: 'Utilizado', numeric: true, render: (_, c) => formatCents(usage.get(c.id)?.usedCents ?? 0) },
    { key: 'available', label: 'Disponível', numeric: true, render: (_, c) => formatCents(usage.get(c.id)?.availableCents ?? 0) },
    { key: 'closingDay', label: 'Fecha dia', numeric: true },
    { key: 'dueDay', label: 'Vence dia', numeric: true },
    { key: 'status', label: 'Status', render: (v) => optionLabel(getCardStatusOptions(), v) },
  ];
  const table = cards.length
    ? dataTable({ columns, rows: cards, actions: cardActions })
    : emptyBlock('credit-card', 'Nenhum cartão cadastrado', 'Cadastre um cartão para lançar compras e acompanhar faturas.');

  container.replaceChildren(header, stats, el('section', { class: 'panel' }, [
    el('div', { class: 'panel__header' }, [el('h2', { text: 'Meus cartões' })]),
    el('div', { class: 'panel__body panel__body--flush' }, [table]),
  ]));
  refreshIcons();
}

function cardActions(card) {
  const acts = [];
  if (card.status === 'active') acts.push(iconButton(`Nova compra em ${card.name}`, 'shopping-cart', () => openPurchaseModal(card)));
  acts.push(iconButton(`Faturas e compras de ${card.name}`, 'receipt', () => openInvoicesModal(card)));
  if (card.status !== 'cancelled') acts.push(iconButton(`Editar ${card.name}`, 'edit-2', () => openCardModal(card)));
  if (card.status === 'active') acts.push(iconButton(`Bloquear ${card.name}`, 'lock', () => changeStatus(card, blockCard, 'Cartão bloqueado.')));
  if (card.status === 'blocked') acts.push(iconButton(`Desbloquear ${card.name}`, 'unlock', () => changeStatus(card, unblockCard, 'Cartão desbloqueado.'), 'btn--success'));
  if (card.status !== 'cancelled') {
    acts.push(iconButton(`Cancelar ${card.name}`, 'x-circle', () => confirmModal({
      title: 'Cancelar cartão', message: `Cancelar o cartão "${card.name}"?`,
      hint: 'Cancelado é definitivo e só é permitido sem limite utilizado.', confirmLabel: 'Cancelar cartão',
      onConfirm: () => changeStatus(card, cancelCard, 'Cartão cancelado.'),
    }), 'btn--danger'));
  }
  acts.push(iconButton(`Excluir ${card.name}`, 'trash-2', () => confirmModal({
    title: 'Excluir cartão', message: `Excluir "${card.name}"?`,
    hint: 'Só é possível sem compras nem faturas; para manter o histórico, cancele.', confirmLabel: 'Excluir',
    onConfirm: async () => {
      const r = await deleteCard(user.uid, card.id);
      if (r.ok) { toast('Cartão excluído.'); await reload(); } else toast(r.errors._form, 6000);
    },
  }), 'btn--danger'));
  return acts;
}

async function changeStatus(card, fn, okMessage) {
  const r = await fn(user.uid, card.id);
  if (r.ok) { toast(okMessage); await reload(); } else toast(r.errors._form, 6000);
}

function openCardModal(card = null) {
  const isEdit = !!card;
  const activeAccounts = accounts.filter((a) => a.status === 'active').map((a) => ({ value: a.id, label: accountLabel(a.id) }));
  const text = (id, label, value, extra = {}) => field(label, id, el('input', { type: 'text', id, name: id, value: value ?? '', autocomplete: 'off', ...extra }));
  formModal({
    title: isEdit ? `Editar cartão: ${card.name}` : 'Novo cartão',
    formId: 'card-form',
    submitLabel: isEdit ? 'Salvar alterações' : 'Criar cartão',
    focusId: 'name',
    fields: [
      el('div', { class: 'form__row' }, [text('name', 'Nome *', card?.name, { maxlength: 80 }), text('brand', 'Bandeira *', card?.brand, { maxlength: 40 })]),
      text('limitCents', 'Limite (R$) *', card ? formatCentsInput(card.limitCents) : '', { placeholder: '0,00' }),
      el('div', { class: 'form__row' }, [
        field('Dia de fechamento *', 'closingDay', el('input', { type: 'number', id: 'closingDay', name: 'closingDay', min: 1, max: 31, value: card?.closingDay ?? '' })),
        field('Dia de vencimento *', 'dueDay', el('input', { type: 'number', id: 'dueDay', name: 'dueDay', min: 1, max: 31, value: card?.dueDay ?? '' })),
      ]),
      field('Conta de pagamento', 'accountId', el('select', { id: 'accountId', name: 'accountId' }, [
        el('option', { value: '' }, 'Nenhuma'),
        ...selectOptions(activeAccounts, card?.accountId),
      ])),
    ],
    submit: (d) => {
      const raw = {
        name: d.get('name').trim(), brand: d.get('brand').trim(), limitCents: d.get('limitCents'),
        closingDay: d.get('closingDay'), dueDay: d.get('dueDay'), accountId: d.get('accountId') || undefined,
      };
      return isEdit ? updateCard(user.uid, card.id, raw) : createCard(user.uid, raw);
    },
    onDone: async () => { toast(isEdit ? 'Cartão atualizado.' : 'Cartão criado.'); await reload(); },
  });
}

async function openPurchaseModal(card) {
  await loadOpenDebtors(); // inclui devedores criados após abrir esta tela (VF-2-03l)
  const expenseCats = categories.filter((c) => c.kind === 'expense' || c.kind === 'both').map((c) => ({ value: c.id, label: c.name }));
  const available = usage.get(card.id)?.availableCents ?? 0;
  formModal({
    title: `Nova compra — ${card.name}`,
    formId: 'purchase-form',
    submitLabel: 'Lançar compra',
    focusId: 'description',
    fields: [
      el('p', { class: 'card__hint', text: `Limite disponível: ${formatCents(available)}. Compras após o dia ${card.closingDay} entram na fatura seguinte.` }),
      field('Descrição *', 'description', el('input', { type: 'text', id: 'description', name: 'description', maxlength: 120, autocomplete: 'off' })),
      el('div', { class: 'form__row' }, [
        field('Valor total (R$) *', 'amountCents', el('input', { type: 'text', id: 'amountCents', name: 'amountCents', placeholder: '0,00', autocomplete: 'off' })),
        field('Parcelas *', 'installmentsTotal', el('input', { type: 'number', id: 'installmentsTotal', name: 'installmentsTotal', min: 1, max: 48, value: 1 })),
      ]),
      field('Data da compra *', 'purchaseDate', el('input', { type: 'date', id: 'purchaseDate', name: 'purchaseDate', value: new Date().toISOString().slice(0, 10) })),
      field('Categoria', 'categoryId', el('select', { id: 'categoryId', name: 'categoryId' }, [el('option', { value: '' }, 'Sem categoria'), ...selectOptions(expenseCats, '')])),
      field('Devedor (opcional)', 'debtorId', el('select', { id: 'debtorId', name: 'debtorId' }, [
        el('option', { value: '' }, 'Compra minha (sem devedor)'),
        ...selectOptions(openDebtors.map((x) => ({ value: x.id, label: `${x.name} — pendente ${formatCents(debtorPendingCents(x))}` })), ''),
      ])),
      el('p', { class: 'card__hint', text: debtorsFailed
        ? `Não foi possível carregar os devedores (${debtorsFailed}). A compra só poderá ser lançada sem vínculo.`
        : openDebtors.length
          ? 'Ao vincular a um devedor, o total da compra é somado ao valor emprestado dele.'
          : 'Nenhum devedor em aberto. Cadastre em Devedores (o valor emprestado pode ser 0) para vincular compras.' }),
      field('Observações', 'notes', el('textarea', { id: 'notes', name: 'notes', maxlength: 300, rows: 2 })),
    ],
    submit: (d) => registerCardPurchase(user.uid, card.id, {
      description: d.get('description').trim(), amountCents: d.get('amountCents'),
      installmentsTotal: d.get('installmentsTotal'), purchaseDate: d.get('purchaseDate'),
      categoryId: d.get('categoryId') || undefined, debtorId: d.get('debtorId') || undefined, notes: d.get('notes').trim() || undefined,
    }),
    onDone: async () => { toast('Compra lançada.'); await reload(); },
  });
}

async function openInvoicesModal(card) {
  const [invoices, purchases] = await Promise.all([listInvoices(user.uid, card.id), listCardPurchases(user.uid, card.id)]);
  invoices.sort((a, b) => (a.referenceMonth < b.referenceMonth ? 1 : -1));
  const invoiceById = new Map(invoices.map((i) => [i.id, i]));
  const totalOf = (inv) => (inv.status === 'open' ? invoiceTotalCents(purchases.filter((p) => p.invoiceId === inv.id)) : (inv.totalCents ?? 0));

  const refreshModal = async () => { closeModal(); await reload(); await openInvoicesModal(card); };
  const act = async (fn, id, okMsg) => {
    const r = await fn(user.uid, id);
    if (r.ok) { toast(okMsg); await refreshModal(); } else toast(r.errors._form, 6000);
  };

  const invoiceTable = invoices.length
    ? dataTable({
      columns: [
        { key: 'referenceMonth', label: 'Fatura', render: (v) => formatMonth(v) },
        { key: 'closingDate', label: 'Fecha', render: (v) => formatDate(v) },
        { key: 'dueDate', label: 'Vence', render: (v) => formatDate(v) },
        { key: 'total', label: 'Total', numeric: true, render: (_, i) => formatCents(totalOf(i)) },
        { key: 'status', label: 'Status', render: (v) => optionLabel(getInvoiceStatusOptions(), v) },
      ],
      rows: invoices,
      actions: (inv) => [
        inv.status === 'open' ? iconButton(`Fechar fatura ${formatMonth(inv.referenceMonth)}`, 'lock', () => act(closeInvoice, inv.id, 'Fatura fechada.')) : null,
        inv.status === 'closed' ? iconButton(`Pagar fatura ${formatMonth(inv.referenceMonth)}`, 'check-circle-2', () => act(payInvoice, inv.id, 'Fatura paga.'), 'btn--success') : null,
      ].filter(Boolean),
    })
    : emptyBlock('receipt', 'Sem faturas', 'As faturas são criadas ao lançar compras.');

  const sorted = [...purchases].sort((a, b) => (a.purchaseDate < b.purchaseDate ? 1 : -1));
  const purchaseTable = sorted.length
    ? dataTable({
      columns: [
        { key: 'purchaseDate', label: 'Data', render: (v) => formatDate(v) },
        { key: 'description', label: 'Descrição' },
        { key: 'installmentNumber', label: 'Parcela', numeric: true, render: (v, p) => `${v}/${p.installmentsTotal}` },
        { key: 'invoiceId', label: 'Fatura', render: (v) => formatMonth(invoiceById.get(v)?.referenceMonth) },
        { key: 'amountCents', label: 'Valor', numeric: true, render: (v) => formatCents(v) },
      ],
      rows: sorted,
      actions: (p) => [iconButton(`Excluir parcela ${p.installmentNumber}/${p.installmentsTotal} de ${p.description}`, 'trash-2', async () => {
        const r = await deleteCardPurchase(user.uid, p.id);
        if (r.ok) { toast('Parcela excluída.'); await refreshModal(); } else toast(r.errors._form, 6000);
      }, 'btn--danger')],
    })
    : emptyBlock('shopping-cart', 'Sem compras', 'Lance uma compra para vê-la aqui.');

  openModal({
    title: `Faturas e compras — ${card.name}`,
    body: el('div', {}, [el('h3', { text: 'Faturas' }), invoiceTable, el('h3', { text: 'Compras (parcelas)' }), purchaseTable]),
    footer: [el('button', { type: 'button', class: 'btn btn--secondary', onClick: closeModal, text: 'Fechar' })],
  });
  refreshIcons();
}
