/**
 * Metas — VF-2-03c (UI). Valor guardado, progresso e restante são derivados das movimentações
 * (aportes − resgates); só o alvo/prazo/status da meta são gravados. Aportar/resgatar é atômico.
 */
import { el, toast, refreshIcons } from '../core/ui.js';
import {
  field, iconButton, statCard, panelHeader, emptyBlock, dataTable, progressBar,
  confirmModal, formModal, formatCentsInput, formatDate, optionLabel, selectOptions, todayIso,
} from '../components/form-kit.js';
import {
  listGoals, createGoal, updateGoal, deleteGoal, cancelGoal, reopenGoal,
  depositToGoal, withdrawFromGoal, listGoalTransactions, getGoalStatusOptions,
  goalSavedCents, goalProgressPercent, formatCents,
} from '../services/goals.js';
import { listAccounts } from '../services/accounts.js';

export const meta = { title: 'Metas', icon: 'target' };

let user = null;
let container = null;
let goals = [];
let saved = new Map();
let accounts = [];

export async function render(target, ctx) {
  user = ctx.user;
  container = target;
  accounts = await listAccounts(user.uid);
  await reload();
}

async function reload() {
  goals = await listGoals(user.uid);
  const entries = await Promise.all(goals.map(async (g) => [g.id, goalSavedCents(await listGoalTransactions(user.uid, g.id))]));
  saved = new Map(entries);
  renderPage();
}

const accountLabel = (id) => {
  const a = accounts.find((x) => x.id === id);
  return a ? `${a.institution} — ${a.name}` : '—';
};
const savedOf = (g) => saved.get(g.id) ?? 0;

function renderPage() {
  const live = goals.filter((g) => g.status !== 'cancelled');
  const total = live.reduce((t, g) => t + savedOf(g), 0);
  const header = panelHeader({
    icon: 'target', title: 'Metas financeiras', hint: 'Objetivos, aportes, resgates e progresso.',
    actionLabel: 'Nova meta', onAction: () => openGoalModal(),
  });
  const stats = el('div', { class: 'grid grid--cards' }, [
    statCard('Total acumulado', formatCents(total), 'piggy-bank', 'Aportes − resgates (metas não canceladas)'),
    statCard('Metas ativas', String(goals.filter((g) => g.status === 'active').length), 'target', 'Em andamento'),
    statCard('Concluídas', String(goals.filter((g) => g.status === 'completed').length), 'check-circle-2', 'Alvo atingido'),
  ]);
  const table = goals.length
    ? dataTable({
      columns: [
        { key: 'name', label: 'Meta' },
        { key: 'targetCents', label: 'Objetivo', numeric: true, render: (v) => formatCents(v) },
        { key: 'saved', label: 'Acumulado', numeric: true, render: (_, g) => formatCents(savedOf(g)) },
        { key: 'progress', label: 'Progresso', render: (_, g) => progressBar(goalProgressPercent(savedOf(g), g.targetCents), 'ok', `Progresso de ${g.name}`) },
        { key: 'percent', label: '%', numeric: true, render: (_, g) => `${goalProgressPercent(savedOf(g), g.targetCents)}%` },
        { key: 'deadline', label: 'Prazo', render: (v) => formatDate(v) },
        { key: 'status', label: 'Status', render: (v) => optionLabel(getGoalStatusOptions(), v) },
      ],
      rows: goals,
      actions: goalActions,
    })
    : emptyBlock('target', 'Nenhuma meta criada', 'Crie reserva de emergência, viagem ou qualquer objetivo e acompanhe o progresso.');
  container.replaceChildren(header, stats, el('section', { class: 'panel' }, [
    el('div', { class: 'panel__header' }, [el('h2', { text: 'Minhas metas' })]),
    el('div', { class: 'panel__body panel__body--flush' }, [table]),
  ]));
  refreshIcons();
}

function goalActions(goal) {
  const acts = [];
  if (goal.status === 'active') acts.push(iconButton(`Aportar em ${goal.name}`, 'plus-circle', () => openMovementModal(goal, 'deposit'), 'btn--success'));
  if ((goal.status === 'active' || goal.status === 'completed') && savedOf(goal) > 0) {
    acts.push(iconButton(`Resgatar de ${goal.name}`, 'minus-circle', () => openMovementModal(goal, 'withdraw')));
  }
  if (goal.status === 'active') acts.push(iconButton(`Editar ${goal.name}`, 'edit-2', () => openGoalModal(goal)));
  if (goal.status === 'active') {
    acts.push(iconButton(`Cancelar ${goal.name}`, 'x-circle', () => changeStatus(goal, cancelGoal, 'Meta cancelada.'), 'btn--danger'));
  }
  if (goal.status === 'cancelled') acts.push(iconButton(`Reabrir ${goal.name}`, 'rotate-ccw', () => changeStatus(goal, reopenGoal, 'Meta reaberta.'), 'btn--success'));
  acts.push(iconButton(`Excluir ${goal.name}`, 'trash-2', () => confirmModal({
    title: 'Excluir meta', message: `Excluir "${goal.name}"?`,
    hint: 'Só é possível sem movimentações; para manter o histórico, cancele.', confirmLabel: 'Excluir',
    onConfirm: async () => {
      const r = await deleteGoal(user.uid, goal.id);
      if (r.ok) { toast('Meta excluída.'); await reload(); } else toast(r.errors._form, 6000);
    },
  }), 'btn--danger'));
  return acts;
}

async function changeStatus(goal, fn, okMessage) {
  const r = await fn(user.uid, goal.id);
  if (r.ok) { toast(okMessage); await reload(); } else toast(r.errors._form, 6000);
}

function openGoalModal(goal = null) {
  const isEdit = !!goal;
  const activeAccounts = accounts.filter((a) => a.status === 'active').map((a) => ({ value: a.id, label: accountLabel(a.id) }));
  formModal({
    title: isEdit ? `Editar meta: ${goal.name}` : 'Nova meta',
    formId: 'goal-form',
    submitLabel: isEdit ? 'Salvar alterações' : 'Criar meta',
    focusId: 'name',
    fields: [
      field('Nome *', 'name', el('input', { type: 'text', id: 'name', name: 'name', maxlength: 80, value: goal?.name ?? '', autocomplete: 'off' })),
      el('div', { class: 'form__row' }, [
        field('Objetivo (R$) *', 'targetCents', el('input', { type: 'text', id: 'targetCents', name: 'targetCents', placeholder: '0,00', value: goal ? formatCentsInput(goal.targetCents) : '', autocomplete: 'off' })),
        field('Prazo', 'deadline', el('input', { type: 'date', id: 'deadline', name: 'deadline', value: goal?.deadline ?? '' })),
      ]),
      field('Conta vinculada', 'accountId', el('select', { id: 'accountId', name: 'accountId' }, [el('option', { value: '' }, 'Nenhuma'), ...selectOptions(activeAccounts, goal?.accountId)])),
      field('Descrição', 'description', el('textarea', { id: 'description', name: 'description', maxlength: 300, rows: 2, value: goal?.description ?? '' })),
    ],
    submit: (d) => {
      const raw = {
        name: d.get('name').trim(), targetCents: d.get('targetCents'), deadline: d.get('deadline') || undefined,
        accountId: d.get('accountId') || undefined, description: d.get('description').trim() || undefined,
      };
      return isEdit ? updateGoal(user.uid, goal.id, raw) : createGoal(user.uid, raw);
    },
    onDone: async () => { toast(isEdit ? 'Meta atualizada.' : 'Meta criada.'); await reload(); },
  });
}

function openMovementModal(goal, type) {
  const isDeposit = type === 'deposit';
  const activeAccounts = accounts.filter((a) => a.status === 'active').map((a) => ({ value: a.id, label: accountLabel(a.id) }));
  formModal({
    title: `${isDeposit ? 'Aportar em' : 'Resgatar de'} ${goal.name}`,
    formId: 'goal-move-form',
    submitLabel: isDeposit ? 'Aportar' : 'Resgatar',
    focusId: 'amountCents',
    fields: [
      el('p', { class: 'card__hint', text: `Guardado: ${formatCents(savedOf(goal))} de ${formatCents(goal.targetCents)}.` }),
      field('Valor (R$) *', 'amountCents', el('input', { type: 'text', id: 'amountCents', name: 'amountCents', placeholder: '0,00', autocomplete: 'off' })),
      field('Data *', 'date', el('input', { type: 'date', id: 'date', name: 'date', value: todayIso() })),
      field(isDeposit ? 'Conta de origem *' : 'Conta de destino *', 'accountId', el('select', { id: 'accountId', name: 'accountId' },
        selectOptions(activeAccounts, goal.accountId, { placeholder: 'Selecione uma conta' }))),
      field('Observações', 'notes', el('textarea', { id: 'notes', name: 'notes', maxlength: 300, rows: 2 })),
    ],
    submit: (d) => (isDeposit ? depositToGoal : withdrawFromGoal)(user.uid, goal.id, {
      amountCents: d.get('amountCents'), date: d.get('date'), accountId: d.get('accountId'), notes: d.get('notes').trim() || undefined,
    }),
    onDone: async (r) => {
      toast(r.status === 'completed' && isDeposit ? 'Aporte registrado — meta concluída!' : (isDeposit ? 'Aporte registrado.' : 'Resgate registrado.'));
      await reload();
    },
  });
}
