/**
 * Devedores — parcelas e recebimentos (VF-2-03b2, UI). Modal aberto a partir de devedores.js.
 * "Atrasada" é exibição derivada (pendente com vencimento passado); o status gravado só muda via
 * recebimento (paid) ou cancelamento. Registrar recebimento é atômico (js/services/debtPayments.js).
 */
import { el, toast, refreshIcons } from '../core/ui.js';
import { openModal, closeModal } from '../components/modal.js';
import {
  field, iconButton, emptyBlock, dataTable, formModal, confirmModal,
  formatDate, formatMonth, formatCentsInput, selectOptions, todayIso,
} from '../components/form-kit.js';
import {
  listDebts, listDebtPayments, createDebtPlan, cancelDebt, registerDebtPayment, formatCents,
} from '../services/debtPayments.js';
import { debtorPendingCents, debtorObligations } from '../core/model.js';
import { getDebtor, getDebtorStatement } from '../services/debtors.js';
import { listCards } from '../services/creditCards.js';
import { listAccounts } from '../services/accounts.js';

const STATUS_LABELS = { pending: 'Pendente', paid: 'Paga', late: 'Atrasada', cancelled: 'Cancelada' };

/** Status exibido: pendente vencida aparece como atrasada (sem gravar). */
export function displayDebtStatus(debt, today = todayIso()) {
  return debt.status === 'pending' && debt.dueDate < today ? 'late' : debt.status;
}

/**
 * @param {{ user: {uid:string}, debtor: object, onChange: () => Promise<void> }} ctx
 */
export async function openDebtorInstallments({ user, debtor, onChange, month = todayIso().slice(0, 7) }) {
  const [debts, payments, accounts, statement, cards] = await Promise.all([
    listDebts(user.uid, debtor.id),
    listDebtPayments(user.uid, { where: [['debtorId', '==', debtor.id]] }),
    listAccounts(user.uid),
    getDebtorStatement(user.uid, debtor, month === 'all' ? todayIso().slice(0, 7) : month),
    listCards(user.uid).catch(() => []),
  ]);
  const cardName = new Map(cards.map((c) => [c.id, c.name]));
  debts.sort((a, b) => a.installmentNumber - b.installmentNumber);
  const receivedBy = new Map();
  for (const p of payments) receivedBy.set(p.debtId, (receivedBy.get(p.debtId) ?? 0) + p.amountCents);
  const isOpen = debtor.status === 'open';
  const activeAccounts = accounts.filter((a) => a.status === 'active').map((a) => ({ value: a.id, label: `${a.institution} — ${a.name}` }));

  const refresh = async () => {
    await onChange?.();
    const fresh = await getDebtor(user.uid, debtor.id);
    await openDebtorInstallments({ user, debtor: fresh ?? debtor, onChange, month });
  };

  const reopen = () => { closeModal(); openDebtorInstallments({ user, debtor, onChange, month }); };

  // Nova dívida (VF-2-03m): à vista (1 parcela) ou parcelada; soma ao emprestado do devedor.
  const openCreate = () => formModal({
    title: `Nova dívida — ${debtor.name}`,
    formId: 'debt-form',
    submitLabel: 'Criar dívida',
    focusId: 'description',
    fields: [
      field('Descrição *', 'description', el('input', { type: 'text', id: 'description', name: 'description', maxlength: 120, autocomplete: 'off' })),
      el('div', { class: 'form__row' }, [
        field('Valor total (R$) *', 'totalCents', el('input', { type: 'text', id: 'totalCents', name: 'totalCents', placeholder: '0,00', autocomplete: 'off' })),
        field('Parcelas (1 = à vista) *', 'installments', el('input', { type: 'number', id: 'installments', name: 'installments', min: 1, max: 120, value: 1 })),
      ]),
      field('1º vencimento *', 'firstDueDate', el('input', { type: 'date', id: 'firstDueDate', name: 'firstDueDate', value: todayIso() })),
      el('p', { class: 'card__hint', text: 'As parcelas vencem todo mês no mesmo dia; o total é somado ao valor emprestado do devedor.' }),
    ],
    submit: (d) => createDebtPlan(user.uid, {
      debtorId: debtor.id, description: d.get('description').trim(), totalCents: d.get('totalCents'),
      installments: d.get('installments'), firstDueDate: d.get('firstDueDate'),
    }),
    onDone: async (r) => { toast(r.installments > 1 ? `Dívida criada em ${r.installments} parcelas.` : 'Dívida à vista criada.'); await refresh(); },
  });

  const openReceive = (debt) => {
    const remaining = debt.principalCents - (receivedBy.get(debt.id) ?? 0);
    const suggested = Math.min(remaining, debtorPendingCents(debtor));
    formModal({
      title: `Receber — parcela ${debt.installmentNumber}`,
      formId: 'debt-pay-form',
      submitLabel: 'Registrar recebimento',
      focusId: 'amountCents',
      fields: [
        el('p', { class: 'card__hint', text: `Restante da parcela: ${formatCents(remaining)} · pendente do devedor: ${formatCents(debtorPendingCents(debtor))}.` }),
        field('Valor (R$) *', 'amountCents', el('input', { type: 'text', id: 'amountCents', name: 'amountCents', value: formatCentsInput(suggested), autocomplete: 'off' })),
        field('Data *', 'date', el('input', { type: 'date', id: 'date', name: 'date', value: todayIso() })),
        field('Conta que recebe *', 'accountId', el('select', { id: 'accountId', name: 'accountId' }, selectOptions(activeAccounts, '', { placeholder: 'Selecione uma conta' }))),
        field('Observações', 'notes', el('textarea', { id: 'notes', name: 'notes', maxlength: 500, rows: 2 })),
      ],
      submit: (d) => registerDebtPayment(user.uid, debt.id, {
        amountCents: d.get('amountCents'), date: d.get('date'), accountId: d.get('accountId'), notes: d.get('notes').trim() || undefined,
      }),
      onDone: async (r) => {
        toast(r.debtorPaid ? 'Recebimento registrado — devedor quitado!' : 'Recebimento registrado.');
        await refresh();
      },
    });
  };

  // Lista única de dívidas/parcelas (VF-2-03m): à vista, parceladas, legadas e de cartão.
  const obligations = debtorObligations({
    debtor, debts, receivedByDebt: receivedBy, purchases: statement.purchases,
    invoicesById: statement.invoicesById, cardsById: cardName,
  });
  const reopenMonth = (m) => { closeModal(); openDebtorInstallments({ user, debtor, onChange, month: m }); };
  const listAll = month === 'all';
  const closingMonth = statement.month;
  const monthValues = [...new Set([...obligations.items.map((i) => i.referenceMonth).filter(Boolean), closingMonth])].sort();
  const monthSelect = el('select', { id: 'statement-month', 'aria-label': 'Mês de referência', onChange: (e) => reopenMonth(e.target.value) }, [
    el('option', { value: 'all', selected: listAll }, 'Todos os meses'),
    ...monthValues.map((m) => el('option', { value: m, selected: !listAll && m === month }, formatMonth(m))),
  ]);
  const visible = obligations.items.filter((i) => listAll || i.referenceMonth === month);
  const KIND_LABELS = { cash: 'À vista', installment: 'Parcelada', legacy: 'Parcela', card: 'Cartão' };
  const statusLabel = (i) => {
    if (i.source === 'card') return i.status === 'paid' ? 'Fatura paga' : i.status === 'cancelled' ? 'Cancelada' : 'Pendente';
    const raw = debts.find((d) => d.id === i.id);
    return STATUS_LABELS[raw ? displayDebtStatus(raw) : i.status] ?? i.status;
  };

  const table = visible.length
    ? dataTable({
      columns: [
        { key: 'kind', label: 'Tipo', render: (v) => KIND_LABELS[v] ?? v },
        { key: 'description', label: 'Dívida', render: (v, i) => (i.cardName ? `${v} · ${i.cardName}` : v) },
        { key: 'installmentNumber', label: 'Parcela', render: (v, i) => (i.installmentsTotal ? `${v}/${i.installmentsTotal}` : String(v)) },
        { key: 'referenceMonth', label: 'Mês', render: (v) => formatMonth(v) },
        { key: 'dueDate', label: 'Vencimento', render: (v, i) => (v ? formatDate(v) : (i.source === 'card' ? '—' : '—')) },
        { key: 'amountCents', label: 'Valor', numeric: true, render: (v) => formatCents(v) },
        { key: 'receivedCents', label: 'Recebido', numeric: true, render: (v, i) => (i.source === 'card' ? '—' : formatCents(v)) },
        { key: 'status', label: 'Situação', render: (_, i) => statusLabel(i) },
      ],
      rows: visible,
      actions: (item) => {
        if (item.source !== 'debt') return [];
        const debt = debts.find((d) => d.id === item.id);
        if (!isOpen || !debt || !['pending', 'late'].includes(debt.status)) return [];
        const acts = [iconButton(`Receber parcela ${debt.installmentNumber} de ${debt.description}`, 'hand-coins', () => openReceive(debt), 'btn--success')];
        if (!(receivedBy.get(debt.id) > 0)) {
          acts.push(iconButton(`Cancelar parcela ${debt.installmentNumber} de ${debt.description}`, 'x-circle', () => confirmModal({
            title: 'Cancelar parcela', message: `Cancelar a parcela ${debt.installmentNumber} de ${debtor.name}?`, confirmLabel: 'Cancelar parcela',
            onConfirm: async () => {
              const r = await cancelDebt(user.uid, debt.id);
              if (r.ok) { toast('Parcela cancelada.'); await refresh(); } else { toast(r.errors._form, 6000); reopen(); }
            },
          }), 'btn--danger'));
        }
        return acts;
      },
    })
    : emptyBlock('list-checks', 'Sem dívidas neste filtro', 'Crie uma dívida (à vista ou parcelada) ou lance uma compra de cartão vinculada a este devedor.');

  const closing = el('div', { class: 'card' }, [
    el('p', { class: 'card__label', text: `Total a receber em ${formatMonth(closingMonth)}` }),
    el('p', { class: 'card__value', text: isOpen ? formatCents(statement.totalCents) : '—' }),
    el('p', { class: 'card__hint', text: `Cartão ${formatCents(statement.cardCents)} + dívidas ${formatCents(statement.loanCents)}${statement.capped ? ` — limitado ao total em aberto (${formatCents(obligations.openCents)})` : ''}.` }),
  ]);
  const totals = el('div', { class: 'card' }, [
    el('p', { class: 'card__label', text: 'Total em aberto' }),
    el('p', { class: 'card__value', text: formatCents(obligations.openCents) }),
    el('p', { class: 'card__hint', text: `Emprestado ${formatCents(debtor.lentCents)} − recebido ${formatCents(debtor.receivedCents ?? 0)}. Detalhado: ${formatCents(obligations.listedCents)}${obligations.unlistedCents > 0 ? ` · sem parcelas cadastradas ${formatCents(obligations.unlistedCents)}` : ''}.` }),
  ]);

  openModal({
    title: `Dívidas — ${debtor.name}`,
    body: el('div', {}, [
      el('div', { class: 'grid grid--cards' }, [totals, closing]),
      !isOpen ? el('p', { class: 'card__hint', text: 'Devedor não está em aberto: somente consulta.' }) : null,
      el('div', { class: 'form__field' }, [el('label', { for: 'statement-month', text: 'Mês de referência' }), monthSelect]),
      isOpen ? el('button', { type: 'button', class: 'btn btn--primary', onClick: openCreate, text: 'Nova dívida' }) : null,
      table,
    ]),
    footer: [el('button', { type: 'button', class: 'btn btn--secondary', onClick: closeModal, text: 'Fechar' })],
  });
  refreshIcons();
}
