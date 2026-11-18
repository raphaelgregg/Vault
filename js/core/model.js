/**
 * Fase 3.1 — Modelo financeiro (puro, sem dependência do Firebase).
 *
 * Fonte de verdade: os schemas espelham EXATAMENTE as Security Rules
 * (firestore.rules). Toda mudança aqui exige conferência com as Rules.
 *
 * Dinheiro: SEMPRE em centavos (inteiros). Nada de ponto flutuante em dado
 * gravado. parseMoneyToCents aceita os formatos pt-BR comuns do usuário.
 *
 * Datas: strings ISO "YYYY-MM-DD" (a conversão para Timestamp do Firestore é
 * feita na camada de serviço, porque este módulo é puro e testável em Node).
 */
import {
  ACCOUNT_TYPES,
  RECURRENCES,
  SUBSCRIPTION_PERIODICITIES,
  SUBSCRIPTION_STATUSES,
  DEBTOR_STATUSES,
  DEBT_STATUSES,
  GOAL_STATUSES,
  GOAL_TRANSACTION_TYPES,
} from '../utils/constants.js';
import { parseIsoDate } from '../utils/dates.js';

// Re-exporta as enumerações para os serviços que as consomem via modelo.
export { ACCOUNT_TYPES, RECURRENCES, SUBSCRIPTION_PERIODICITIES, SUBSCRIPTION_STATUSES, DEBTOR_STATUSES, DEBT_STATUSES, GOAL_STATUSES, GOAL_TRANSACTION_TYPES };

// ---------------------------------------------------------------------------
// Dinheiro
// ---------------------------------------------------------------------------

/**
 * Converte entrada do usuário em centavos inteiros.
 * Aceita: 1234 | "1234" | "1234,56" | "1.234,56" | "1234.56" | "R$ 1.234,56".
 * Retorna null quando não é um valor válido.
 */
export function parseMoneyToCents(input) {
  if (typeof input === 'number' && Number.isFinite(input)) {
    return Math.round(input * 100);
  }
  if (typeof input !== 'string') return null;
  let raw = input.trim().replace(/^r\$\s*/i, '').replace(/\s/g, '');
  if (!raw) return null;
  // Formato pt-BR: ponto = milhar, vírgula = decimal.
  if (/,\d{1,2}$/.test(raw)) {
    raw = raw.replace(/\./g, '').replace(',', '.');
  } else if (raw.includes(',') && !raw.includes('.')) {
    raw = raw.replace(',', '.');
  } else if ((raw.match(/\./g) ?? []).length > 1) {
    raw = raw.replace(/\./g, '');
  }
  if (!/^\d+(\.\d+)?$/.test(raw)) return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.round(value * 100);
}

/**
 * Centavos inteiros → string "1234,56" aceita por parseMoneyToCents. Necessário
 * porque o parser trata NÚMEROS como reais (×100): nunca reenvie centavos crus.
 */
export function centsToMoneyString(cents) {
  const value = Number(cents);
  if (!Number.isInteger(value) || value < 0) return null;
  return `${Math.trunc(value / 100)},${String(value % 100).padStart(2, '0')}`;
}

/** Formata centavos para exibição pt-BR: 123456 -> "R$ 1.234,56". */
export function formatCents(cents) {
  if (typeof cents !== 'number' || !Number.isInteger(cents)) return '—';
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const int = Math.trunc(abs / 100).toLocaleString('pt-BR');
  const frac = String(abs % 100).padStart(2, '0');
  return `${negative ? '-' : ''}R$ ${int},${frac}`;
}

// ---------------------------------------------------------------------------
// Schemas — espelham firestore.rules (fonte de verdade)
// ---------------------------------------------------------------------------

const text = (max, required = true) => ({ kind: 'text', max, required });
const date = (required = true) => ({ kind: 'date', required });
const optionalDate = () => ({ kind: 'date', required: false });
const refField = (required = true, kindCompat = null) => ({
  kind: 'ref',
  max: 128,
  required,
  ...(kindCompat ? { kindCompat } : {}),
});
const money = () => ({ kind: 'cents', required: true, positive: true });
const cents0 = () => ({ kind: 'cents', required: true, positive: false });
const centsNonNegative = () => ({ kind: 'cents', required: true, positive: false, nonNegative: true });
const intRange = (min, max) => ({ kind: 'int', required: true, min, max });
const optionalText = (max) => ({ kind: 'text', max, required: false });

export const SCHEMAS = Object.freeze({
  accounts: {
    dateFields: [],
    fields: {
      institution: text(80),
      name: text(80),
      type: { kind: 'enum', required: true, values: ACCOUNT_TYPES.map((t) => t.value) },
      initialBalanceCents: cents0(),
      color: text(32),
      status: { kind: 'enum', required: true, values: ['active', 'inactive', 'archived'] },
    },
  },
  categories: {
    dateFields: [],
    fields: {
      name: text(60),
      kind: { kind: 'enum', required: true, values: ['income', 'expense', 'both'] },
      color: text(32),
    },
  },
  incomes: {
    dateFields: ['expectedDate', 'receivedDate'],
    fields: {
      description: text(120),
      // Receitas só aceitam categoria de receita ou "ambos".
      categoryId: refField(true, ['income', 'both']),
      amountCents: money(),
      expectedDate: date(),
      receivedDate: optionalDate(),
      accountId: refField(),
      status: { kind: 'enum', required: true, values: ['pending', 'received', 'cancelled'] },
      recurrence: { kind: 'enum', required: true, values: RECURRENCES.map((r) => r.value) },
      notes: optionalText(500),
    },
  },
  expenses: {
    dateFields: ['purchaseDate', 'dueDate', 'paidDate'],
    fields: {
      description: text(120),
      // Despesas só aceitam categoria de despesa ou "ambos".
      categoryId: refField(true, ['expense', 'both']),
      amountCents: money(),
      accountId: refField(),
      purchaseDate: date(),
      dueDate: date(),
      paidDate: optionalDate(),
      status: { kind: 'enum', required: true, values: ['pending', 'paid', 'cancelled'] },
      recurrence: { kind: 'enum', required: true, values: RECURRENCES.map((r) => r.value) },
      notes: optionalText(500),
      installmentGroupId: optionalText(128),
    },
  },
  transfers: {
    dateFields: ['date'],
    fields: {
      fromAccountId: refField(),
      toAccountId: refField(),
      amountCents: money(),
      date: date(),
      reason: text(120),
      notes: optionalText(500),
      status: { kind: 'enum', required: true, values: ['pending', 'confirmed', 'cancelled'] },
    },
  },
  subscriptions: {
    dateFields: ['nextChargeDate'],
    fields: {
      name: text(80),
      amountCents: money(),
      periodicity: { kind: 'enum', required: true, values: SUBSCRIPTION_PERIODICITIES.map((p) => p.value) },
      nextChargeDate: date(),
      accountId: refField(),
      // Assinaturas são cobradas como despesa: categoria de despesa ou "ambos".
      categoryId: refField(true, ['expense', 'both']),
      status: { kind: 'enum', required: true, values: SUBSCRIPTION_STATUSES.map((s) => s.value) },
      notes: optionalText(500),
    },
  },
  debtors: {
    dateFields: ['loanDate'],
    fields: {
      name: text(80),
      loanDate: date(),
      lentCents: money(),
      // Gravado pelo service (começa em 0); a Rule exige 0 <= receivedCents <= lentCents.
      receivedCents: centsNonNegative(),
      status: { kind: 'enum', required: true, values: DEBTOR_STATUSES.map((s) => s.value) },
      notes: optionalText(500),
    },
  },
  // Parcelas de devedores (VF-2-03b2) — espelha firestore.rules `debts`.
  debts: {
    dateFields: ['dueDate'],
    fields: {
      debtorId: refField(),
      description: text(120),
      principalCents: money(),
      dueDate: date(),
      installmentNumber: intRange(1, 360),
      status: { kind: 'enum', required: true, values: DEBT_STATUSES.map((s) => s.value) },
    },
  },
  // Metas (VF-2-03c) — espelha firestore.rules `goals`. Valor guardado é derivado.
  goals: {
    dateFields: ['deadline'],
    fields: {
      name: text(80),
      description: optionalText(300),
      targetCents: money(),
      deadline: optionalDate(),
      accountId: refField(false),
      status: { kind: 'enum', required: true, values: GOAL_STATUSES.map((s) => s.value) },
    },
  },
  // Movimentações de metas — espelha firestore.rules `goalTransactions`.
  goalTransactions: {
    dateFields: ['date'],
    fields: {
      goalId: refField(),
      type: { kind: 'enum', required: true, values: GOAL_TRANSACTION_TYPES.map((t) => t.value) },
      amountCents: money(),
      date: date(),
      accountId: refField(),
      notes: optionalText(300),
    },
  },
  // Recebimentos — espelha firestore.rules `debtPayments`.
  debtPayments: {
    dateFields: ['date'],
    fields: {
      debtId: refField(),
      debtorId: refField(),
      amountCents: money(),
      date: date(),
      accountId: refField(),
      notes: optionalText(500),
    },
  },
});

/** Campos de referência por schema (IDs de docs da própria árvore). */
export const REF_FIELDS = Object.freeze({
  accounts: [],
  categories: [],
  incomes: ['categoryId', 'accountId'],
  expenses: ['categoryId', 'accountId'],
  transfers: ['fromAccountId', 'toAccountId'],
  subscriptions: ['accountId', 'categoryId'],
  debtors: [],
  goals: ['accountId'],
  goalTransactions: ['goalId', 'accountId'],
  debts: ['debtorId'],
  debtPayments: ['debtId', 'debtorId', 'accountId'],
});

// ---------------------------------------------------------------------------
// Validação e normalização
// ---------------------------------------------------------------------------

/** Mensagem única de incompatibilidade entre tipo de categoria e movimentação. */
export const CATEGORY_KIND_ERROR = 'Categoria incompatível com este tipo de movimentação.';

/**
 * Verifica se uma categoria pode ser usada por uma movimentação.
 * Puro e reutilizável: a categoria deve vir do Firestore, nunca do formulário.
 * Retorna { ok, errors } no padrão dos serviços.
 */
export function checkCategoryForMovement(category, allowedKinds) {
  if (!category) {
    return { ok: false, errors: { categoryId: 'Categoria não encontrada.' } };
  }
  if (!isKindCompatible(category.kind, allowedKinds)) {
    return { ok: false, errors: { categoryId: CATEGORY_KIND_ERROR } };
  }
  return { ok: true, errors: {} };
}

/** true quando `categoryKind` está na lista de tipos aceitos. */
export function isKindCompatible(categoryKind, allowedKinds) {
  return Array.isArray(allowedKinds) && allowedKinds.includes(categoryKind);
}

/**
 * Resolve o tipo de uma categoria no contexto de validação.
 * Aceita função (id) => kind, Map id → kind ou objeto { id: kind }.
 * Retorna undefined quando o contexto não traz o lookup ou não conhece o id.
 */
function lookupCategoryKind(categoryKinds, categoryId) {
  if (!categoryKinds) return undefined;
  if (typeof categoryKinds === 'function') return categoryKinds(categoryId);
  if (categoryKinds instanceof Map) return categoryKinds.get(categoryId);
  if (typeof categoryKinds === 'object') return categoryKinds[categoryId];
  return undefined;
}

/** true quando a string é uma data de calendário real em "YYYY-MM-DD". */
export function isValidIsoDate(value) {
  return parseIsoDate(value) !== null;
}

/**
 * Valida os dados de uma entidade (sem createdAt/updatedAt — o serviço os grava).
 * Retorna { ok, errors } com mensagens em pt-BR por campo.
 *
 * `context` é opcional e retrocompatível. Hoje aceita:
 *  - categoryKinds: função ou Map categoryId → kind. Quando presente, campos com
 *    `kindCompat` (ex.: categoryId de incomes/expenses) também são validados
 *    contra o tipo da categoria.
 *
 * AUSÊNCIA DE CONTEXTO = a checagem de compatibilidade de tipo NÃO é executada;
 * apenas a referência (string/limite) é validada, como antes. A existência e o
 * tipo reais da categoria devem ser conferidos na camada de serviço, que lê o
 * Firestore. Não passe o kind do formulário: ele não é fonte de verdade.
 */
export function validateEntity(kind, data, context = {}) {
  const schema = SCHEMAS[kind];
  if (!schema) return { ok: false, errors: { _form: 'Entidade desconhecida.' } };
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { ok: false, errors: { _form: 'Dados inválidos.' } };
  }

  const errors = {};
  const allowedKeys = Object.keys(schema.fields);

  for (const key of Object.keys(data)) {
    if (!allowedKeys.includes(key)) errors[key] = 'Campo não permitido.';
  }

  for (const [field, rule] of Object.entries(schema.fields)) {
    const value = data[field];
    const missing = value === undefined || value === null || value === '';

    if (missing) {
      if (rule.required) errors[field] = 'Campo obrigatório.';
      continue;
    }

    if (rule.kind === 'text') {
      if (typeof value !== 'string') errors[field] = 'Valor inválido.';
      else if (value.trim().length === 0) errors[field] = 'Campo obrigatório.';
      else if (value.trim().length > rule.max) errors[field] = `Máximo de ${rule.max} caracteres.`;
    } else if (rule.kind === 'enum') {
      if (typeof value !== 'string' || !rule.values.includes(value)) {
        errors[field] = 'Valor inválido.';
      }
    } else if (rule.kind === 'cents') {
      const parsed = parseMoneyToCents(value);
      if (parsed === null) errors[field] = 'Valor monetário inválido.';
      else if (rule.positive && parsed <= 0) errors[field] = 'O valor deve ser maior que zero.';
      else if (rule.nonNegative && parsed < 0) errors[field] = 'O valor não pode ser negativo.';
    } else if (rule.kind === 'int') {
      const n = typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : value;
      if (!Number.isInteger(n) || n < rule.min || n > rule.max) {
        errors[field] = `Informe um número inteiro entre ${rule.min} e ${rule.max}.`;
      }
    } else if (rule.kind === 'date') {
      if (!isValidIsoDate(value)) errors[field] = 'Data inválida (use AAAA-MM-DD).';
    } else if (rule.kind === 'ref') {
      if (typeof value !== 'string' || value.trim().length === 0 || value.length > rule.max) {
        errors[field] = 'Referência inválida.';
      } else if (rule.kindCompat) {
        // Checagem declarativa: só roda se o contexto trouxer o lookup do kind.
        const categoryKind = lookupCategoryKind(context?.categoryKinds, value);
        if (typeof categoryKind === 'string' && !isKindCompatible(categoryKind, rule.kindCompat)) {
          errors[field] = CATEGORY_KIND_ERROR;
        }
      }
    }
  }

  if (kind === 'transfers' && data.fromAccountId && data.toAccountId
    && data.fromAccountId === data.toAccountId) {
    errors.toAccountId = 'A conta de destino deve ser diferente da conta de origem.';
  }

  if (kind === 'debtors' && !errors.lentCents && !errors.receivedCents
    && data.lentCents !== undefined && data.receivedCents !== undefined) {
    if (parseMoneyToCents(data.receivedCents) > parseMoneyToCents(data.lentCents)) {
      errors.receivedCents = 'O valor recebido não pode exceder o valor emprestado.';
    }
  }

  return { ok: Object.keys(errors).length === 0, errors };
}

/**
 * Normaliza os dados validados para gravação: texto aparado, dinheiro em
 * centavos inteiros, datas mantidas em "YYYY-MM-DD". Retorna { ok, data, errors }.
 * `context` é repassado a validateEntity; sem ele, a checagem de kindCompat
 * não é executada (comportamento retrocompatível).
 */
export function buildEntity(kind, data, context = {}) {
  const check = validateEntity(kind, data, context);
  if (!check.ok) return check;

  const schema = SCHEMAS[kind];
  const out = {};
  for (const [field, rule] of Object.entries(schema.fields)) {
    const value = data[field];
    if (value === undefined || value === null || value === '') continue;
    if (rule.kind === 'text' || rule.kind === 'enum' || rule.kind === 'ref') {
      out[field] = typeof value === 'string' ? value.trim() : value;
    } else if (rule.kind === 'cents') {
      out[field] = parseMoneyToCents(value);
    } else if (rule.kind === 'int') {
      out[field] = Number(value);
    } else {
      out[field] = value;
    }
  }
  return { ok: true, data: out, errors: {} };
}

// ---------------------------------------------------------------------------
// Filtros de listagem (puros, usados pela interface)
// ---------------------------------------------------------------------------

/**
 * Filtra movimentações por status, mês e categoria.
 *
 * IMPORTANTE (limitação conhecida): o filtro é client-side sobre a lista já
 * carregada. Vale enquanto a listagem não for paginada; com paginação futura,
 * migrar para options.where no serviço (campos únicos, sem índice composto novo).
 *
 * @param {Array} items movimentações (incomes/expenses)
 * @param {object} filters { status: 'all'|valor, month: 'YYYY-MM'|null, categoryId: id|null }
 * @param {object} options { dateField } campo de data usado pelo filtro de mês
 */
export function filterMovements(items, filters = {}, { dateField } = {}) {
  const { status = 'all', month = null, categoryId = null } = filters ?? {};
  return (items ?? []).filter((item) => {
    if (status !== 'all' && item.status !== status) return false;
    if (month) {
      const value = dateField ? item?.[dateField] : null;
      if (typeof value !== 'string' || !value.startsWith(month)) return false;
    }
    if (categoryId && item.categoryId !== categoryId) return false;
    return true;
  });
}

// ---------------------------------------------------------------------------
// Derivações financeiras (nada de saldo gravado: sempre calculado)
// ---------------------------------------------------------------------------

/**
 * Saldo atual de cada conta, derivado dos movimentos:
 *   saldo = saldo inicial
 *         + receitas recebidas (status received)
 *         - despesas pagas (status paid)
 *         + transferências confirmadas recebidas - confirmadas enviadas
         + recebimentos de devedores (debtPayments)
         - aportes em metas + resgates (goalTransactions).
 * Transferências pendentes/canceladas não movem dinheiro.
 */
export function accountBalances(accounts, { incomes = [], expenses = [], transfers = [], debtPayments = [], goalTransactions = [] } = {}) {
  const balances = new Map();
  for (const account of accounts) {
    balances.set(account.id, Number(account.initialBalanceCents) || 0);
  }
  const bump = (id, delta) => {
    if (balances.has(id)) balances.set(id, balances.get(id) + delta);
  };

  for (const income of incomes) {
    if (income.status === 'received') bump(income.accountId, income.amountCents);
  }
  for (const expense of expenses) {
    if (expense.status === 'paid') bump(expense.accountId, -expense.amountCents);
  }
  // Recebimentos de devedores entram na conta de destino (existir já = dinheiro recebido).
  for (const payment of debtPayments) bump(payment.accountId, payment.amountCents);
  // Aporte em meta tira dinheiro da conta; resgate devolve.
  for (const t of goalTransactions) bump(t.accountId, t.type === 'deposit' ? -t.amountCents : t.amountCents);
  for (const transfer of transfers) {
    if (transfer.status !== 'confirmed') continue;
    bump(transfer.fromAccountId, -transfer.amountCents);
    bump(transfer.toAccountId, transfer.amountCents);
  }
  return balances;
}

/** Soma de amountCents dos itens com o status pedido. */
export function sumAmounts(items, status) {
  return items
    .filter((item) => (status ? item.status === status : true))
    .reduce((total, item) => total + (Number(item.amountCents) || 0), 0);
}

// ---------------------------------------------------------------------------
// Assinaturas (VF-2-03a) — cálculos puros
// ---------------------------------------------------------------------------

/** Cobranças por ano de cada periodicidade (semana = 52, mês = 12). */
const CHARGES_PER_YEAR = Object.freeze({ weekly: 52, monthly: 12, yearly: 1 });

/** Custo anual em centavos inteiros (valor × cobranças por ano). */
export function subscriptionAnnualCents(amountCents, periodicity) {
  const perYear = CHARGES_PER_YEAR[periodicity];
  const amount = Number(amountCents);
  if (!perYear || !Number.isInteger(amount)) return 0;
  return amount * perYear;
}

/** Equivalente mensal em centavos inteiros (anual ÷ 12, arredondado). */
export function subscriptionMonthlyCents(amountCents, periodicity) {
  return Math.round(subscriptionAnnualCents(amountCents, periodicity) / 12);
}

/**
 * Totais das assinaturas ATIVAS: pausadas e canceladas não entram.
 * Retorna { activeCount, monthlyCents, annualCents }. A projeção anual soma os
 * valores anuais exatos (não monthlyCents × 12), evitando acumular arredondamento.
 */
export function summarizeSubscriptions(items = []) {
  let activeCount = 0;
  let annualCents = 0;
  for (const item of items) {
    if (item?.status !== 'active') continue;
    activeCount += 1;
    annualCents += subscriptionAnnualCents(item.amountCents, item.periodicity);
  }
  return { activeCount, monthlyCents: Math.round(annualCents / 12), annualCents };
}

// ---------------------------------------------------------------------------
// Devedores (VF-2-03b) — cálculos puros
// ---------------------------------------------------------------------------

/** Saldo pendente de um devedor (emprestado − recebido), nunca negativo. Não é gravado. */
export function debtorPendingCents(debtor) {
  const lent = Number(debtor?.lentCents);
  const received = Number(debtor?.receivedCents) || 0;
  if (!Number.isInteger(lent)) return 0;
  return Math.max(0, lent - received);
}

/**
 * Totais dos devedores EM ABERTO (cancelados e quitados não entram em "a receber").
 * Retorna { openCount, pendingCents, receivedCents }; recebido soma os não cancelados.
 */
export function summarizeDebtors(items = []) {
  let openCount = 0;
  let pendingCents = 0;
  let receivedCents = 0;
  for (const item of items) {
    if (item?.status === 'cancelled') continue;
    receivedCents += Number(item?.receivedCents) || 0;
    if (item?.status !== 'open') continue;
    openCount += 1;
    pendingCents += debtorPendingCents(item);
  }
  return { openCount, pendingCents, receivedCents };
}

// ---------------------------------------------------------------------------
// Parcelas e recebimentos (VF-2-03b2) — puros
// ---------------------------------------------------------------------------

/**
 * Aplica um recebimento ao devedor. Retorna { ok, receivedCents, status, error }.
 * Rejeita devedor não aberto, valor inválido e valor acima do pendente; quita
 * (status paid) quando o pendente zera. Nada é gravado aqui.
 */
export function applyPaymentToDebtor(debtor, amountCents) {
  if (debtor?.status !== 'open') return { ok: false, error: 'Só é possível registrar recebimento de devedor em aberto.' };
  if (!Number.isInteger(amountCents) || amountCents <= 0) return { ok: false, error: 'O valor deve ser maior que zero.' };
  const pending = debtorPendingCents(debtor);
  if (amountCents > pending) return { ok: false, error: 'O valor excede o saldo pendente do devedor.' };
  const receivedCents = (Number(debtor.receivedCents) || 0) + amountCents;
  return { ok: true, receivedCents, status: receivedCents >= debtor.lentCents ? 'paid' : 'open' };
}

// ---------------------------------------------------------------------------
// Metas (VF-2-03c) — puros
// ---------------------------------------------------------------------------

/** Valor guardado da meta (aportes − resgates), derivado; nunca gravado. */
export function goalSavedCents(transactions = []) {
  return transactions.reduce((total, t) => {
    const amount = Number(t?.amountCents) || 0;
    return total + (t?.type === 'deposit' ? amount : t?.type === 'withdraw' ? -amount : 0);
  }, 0);
}

/** Progresso 0..100 (inteiro, truncado) do guardado sobre a meta. */
export function goalProgressPercent(savedCents, targetCents) {
  if (!Number.isInteger(targetCents) || targetCents <= 0) return 0;
  return Math.min(100, Math.max(0, Math.floor((savedCents * 100) / targetCents)));
}

/**
 * Aplica aporte/resgate. Retorna { ok, savedCents, status, error }.
 * Aporte só em meta ativa; resgate em ativa ou concluída e nunca acima do guardado.
 * Atingir a meta conclui; resgatar de meta concluída abaixo da meta reativa.
 */
export function applyGoalTransaction(goal, savedCents, type, amountCents) {
  if (!Number.isInteger(amountCents) || amountCents <= 0) return { ok: false, error: 'O valor deve ser maior que zero.' };
  if (type === 'deposit') {
    if (goal?.status !== 'active') return { ok: false, error: 'Só é possível aportar em metas ativas.' };
    const next = savedCents + amountCents;
    return { ok: true, savedCents: next, status: next >= goal.targetCents ? 'completed' : 'active' };
  }
  if (type === 'withdraw') {
    if (!['active', 'completed'].includes(goal?.status)) return { ok: false, error: 'Só é possível resgatar de metas ativas ou concluídas.' };
    if (amountCents > savedCents) return { ok: false, error: 'O resgate excede o valor guardado na meta.' };
    const next = savedCents - amountCents;
    return { ok: true, savedCents: next, status: next >= goal.targetCents ? 'completed' : 'active' };
  }
  return { ok: false, error: 'Tipo de movimentação inválido.' };
}
