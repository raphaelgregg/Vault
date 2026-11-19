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
  listDebts, listDebtPayments, createDebt, cancelDebt, registerDebtPayment, formatCents,
} from '../services/debtPayments.js';
import { debtorPendingCents, debtorOverview } from '../core/model.js';
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
    getDebtorStatement(user.uid, debtor, month),
    listCards(user.uid).catch(() => []),
  ]);
  const overview = debtorOverview(debtor, statement.purchases); // sem 2ª leitura das compras
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

  const openCreate = () => formModal({
    title: `Nova parcela — ${debtor.name}`,
    formId: 'debt-form',
    submitLabel: 'Criar parcela',
    focusId: 'description',
    fields: [
      field('Descrição *', 'description', el('input', { type: 'text', id: 'description', name: 'description', maxlength: 120, autocomplete: 'off' })),
      el('div', { class: 'form__row' }, [
        field('Valor (R$) *', 'principalCents', el('input', { type: 'text', id: 'principalCents', name: 'principalCents', placeholder: '0,00', autocomplete: 'off' })),
        field('Vencimento *', 'dueDate', el('input', { type: 'date', id: 'dueDate', name: 'dueDate', value: todayIso() })),
      ]),
      field('Nº da parcela (vazio = próxima)', 'installmentNumber', el('input', { type: 'number', id: 'installmentNumber', name: 'installmentNumber', min: 1, max: 360 })),
    ],
    submit: (d) => createDebt(user.uid, {
      debtorId: debtor.id, description: d.get('description').trim(), principalCents: d.get('principalCents'),
      dueDate: d.get('dueDate'), installmentNumber: d.get('installmentNumber') || undefined,
    }),
    onDone: async () => { toast('Parcela criada.'); await refresh(); },
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

  const table = debts.length
    ? dataTable({
      columns: [
        { key: 'installmentNumber', label: 'Nº', numeric: true },
        { key: 'description', label: 'Descrição' },
        { key: 'dueDate', label: 'Vencimento', render: (v) => formatDate(v) },
        { key: 'principalCents', label: 'Valor', numeric: true, render: (v) => formatCents(v) },
        { key: 'received', label: 'Recebido', numeric: true, render: (_, d) => formatCents(receivedBy.get(d.id) ?? 0) },
        { key: 'status', label: 'Status', render: (_, d) => STATUS_LABELS[displayDebtStatus(d)] ?? d.status },
      ],
      rows: debts,
      actions: (debt) => {
        if (!isOpen || !['pending', 'late'].includes(debt.status)) return [];
        const acts = [iconButton(`Receber parcela ${debt.installmentNumber}`, 'hand-coins', () => openReceive(debt), 'btn--success')];
        if (!(receivedBy.get(debt.id) > 0)) {
          acts.push(iconButton(`Cancelar parcela ${debt.installmentNumber}`, 'x-circle', () => confirmModal({
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
    : emptyBlock('list-checks', 'Sem parcelas', 'Crie parcelas para acompanhar os vencimentos e registrar recebimentos.');

  // Débitos consolidados por origem (VF-2-03i) + fechamento e detalhamento por mês (VF-2-03j).
  const reopenMonth = (m) => { closeModal(); openDebtorInstallments({ user, debtor, onChange, month: m }); };
  const faturaMonthOf = (p) => statement.invoicesById.get(p.invoiceId)?.referenceMonth ?? (p.purchaseDate ?? '').slice(0, 7);
  const rows = statement.purchases.map((p) => {
    const invoice = statement.invoicesById.get(p.invoiceId);
    return { ...p, referenceMonth: faturaMonthOf(p), invoiceStatus: invoice?.status ?? null };
  }).sort((x, y) => (x.referenceMonth === y.referenceMonth
    ? (x.description + x.installmentNumber).localeCompare(y.description + y.installmentNumber)
    : x.referenceMonth.localeCompare(y.referenceMonth)));
  const months = [...new Set([...rows.map((r) => r.referenceMonth), month])].sort();
  const monthSelect = el('select', { id: 'statement-month', 'aria-label': 'Mês de referência', onChange: (e) => reopenMonth(e.target.value) },
    months.map((m) => el('option', { value: m, selected: m === month }, formatMonth(m))));
  const invoiceLabel = (st) => (st === 'paid' ? 'Paga' : st === 'cancelled' ? 'Cancelada' : 'Pendente');
  const cardRows = rows.filter((r) => r.referenceMonth === month);
  const originTable = rows.length
    ? dataTable({
      columns: [
        { key: 'description', label: 'Compra' },
        { key: 'cardId', label: 'Cartão', render: (v) => cardName.get(v) ?? '—' },
        { key: 'installmentNumber', label: 'Parcela', render: (v, p) => `${v}/${p.installmentsTotal}` },
        { key: 'amountCents', label: 'Valor da parcela', numeric: true, render: (v) => formatCents(v) },
        { key: 'referenceMonth', label: 'Fatura', render: (v) => formatMonth(v) },
        { key: 'invoiceStatus', label: 'Status', render: (v) => invoiceLabel(v) },
      ],
      rows: cardRows,
    })
    : null;
  const closing = el('div', { class: 'card' }, [
    el('p', { class: 'card__label', text: `Total a receber em ${formatMonth(month)}` }),
    el('p', { class: 'card__value', text: isOpen ? formatCents(statement.totalCents) : '—' }),
    el('p', { class: 'card__hint', text: `Cartão ${formatCents(statement.cardCents)} + empréstimo ${formatCents(statement.loanCents)}${statement.capped ? ` — limitado ao pendente do devedor (${formatCents(debtorPendingCents(debtor))})` : ''}.` }),
  ]);
  const overlapNotice = statement.overlapCents > 0
    ? el('p', { class: 'notice', role: 'status', text: `Atenção: as parcelas de empréstimo cadastradas excedem a parte de empréstimo em ${formatCents(statement.overlapCents)}; pode haver duplicidade com compras no cartão (que já somam ao emprestado).` })
    : null;

  openModal({
    title: `Parcelas — ${debtor.name}`,
    body: el('div', {}, [
      el('p', { class: 'card__hint', text: `Emprestado ${formatCents(debtor.lentCents)} · recebido ${formatCents(debtor.receivedCents ?? 0)} · pendente ${formatCents(debtorPendingCents(debtor))}${isOpen ? '' : ' (devedor não está em aberto: somente consulta)'}` }),
      el('p', { class: 'card__hint', text: `Por origem: empréstimo ${formatCents(overview.loanCents)} · cartão de crédito ${formatCents(overview.cardCents)} (${overview.cardCount} parcela(s) vinculada(s)). O recebido é abatido do total, sem atribuição por origem.` }),
      el('div', { class: 'form__field' }, [el('label', { for: 'statement-month', text: 'Mês de referência' }), monthSelect]),
      closing,
      overlapNotice,
      originTable ?? emptyBlock('credit-card', 'Sem compras no cartão', 'Compras vinculadas a este devedor aparecem aqui.'),
      originTable && !cardRows.length ? el('p', { class: 'card__hint', text: `Nenhuma parcela de cartão na fatura de ${formatMonth(month)}.` }) : null,
      isOpen ? el('button', { type: 'button', class: 'btn btn--primary', onClick: openCreate, text: 'Nova parcela' }) : null,
      table,
    ]),
    footer: [el('button', { type: 'button', class: 'btn btn--secondary', onClick: closeModal, text: 'Fechar' })],
  });
  refreshIcons();
}
