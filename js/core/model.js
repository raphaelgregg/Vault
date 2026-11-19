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
  CARD_STATUSES,
  INVOICE_STATUSES,
} from '../utils/constants.js';
import { parseIsoDate } from '../utils/dates.js';

// Re-exporta as enumerações para os serviços que as consomem via modelo.
export { ACCOUNT_TYPES, RECURRENCES, SUBSCRIPTION_PERIODICITIES, SUBSCRIPTION_STATUSES, DEBTOR_STATUSES, DEBT_STATUSES, GOAL_STATUSES, GOAL_TRANSACTION_TYPES, CARD_STATUSES, INVOICE_STATUSES };

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
const monthKey = () => ({ kind: 'month', required: true });
const optionalCentsNonNegative = () => ({ kind: 'cents', required: false, positive: false, nonNegative: true });
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
      // Pode ser 0 (VF-2-03l): devedor sem empréstimo inicial, ex.: só compras no cartão (que somam aqui).
      lentCents: centsNonNegative(),
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
      // Dívida à vista (1) ou parcelada (N) e agrupamento das parcelas (VF-2-03m); ausentes em parcelas legadas.
      installmentsTotal: { kind: 'int', required: false, min: 1, max: 360 },
      debtGroupId: optionalText(128),
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
  // Orçamentos (VF-2-03e) — espelha firestore.rules `budgets`. Gasto/restante são derivados.
  budgets: {
    dateFields: [],
    fields: {
      categoryId: refField(true, ['expense', 'both']),
      month: monthKey(),
      limitCents: money(),
    },
  },
  // Cartões (VF-2-03d) — espelha firestore.rules `creditCards`.
  creditCards: {
    dateFields: [],
    fields: {
      name: text(80),
      brand: text(40),
      limitCents: money(),
      closingDay: intRange(1, 31),
      dueDay: intRange(1, 31),
      accountId: refField(false),
      color: optionalText(32),
      status: { kind: 'enum', required: true, values: CARD_STATUSES.map((s) => s.value) },
    },
  },
  // Compras no cartão (cada parcela é um documento) — espelha `cardPurchases`.
  cardPurchases: {
    dateFields: ['purchaseDate'],
    fields: {
      cardId: refField(),
      description: text(120),
      amountCents: money(),
      purchaseDate: date(),
      installmentsTotal: intRange(1, 48),
      installmentNumber: intRange(1, 48),
      categoryId: refField(false, ['expense', 'both']),
      invoiceId: refField(false),
      // Compra de cartão feita para um devedor (VF-2-03i): soma ao valor emprestado dele.
      debtorId: refField(false),
      notes: optionalText(300),
    },
  },
  // Faturas — espelha `invoices`. totalCents/paidCents só são gravados no fechamento/pagamento.
  invoices: {
    dateFields: ['closingDate', 'dueDate'],
    fields: {
      cardId: refField(),
      referenceMonth: monthKey(),
      closingDate: optionalDate(),
      dueDate: date(),
      totalCents: optionalCentsNonNegative(),
      paidCents: optionalCentsNonNegative(),
      status: { kind: 'enum', required: true, values: INVOICE_STATUSES.map((s) => s.value) },
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
  budgets: ['categoryId'],
  creditCards: ['accountId'],
  cardPurchases: ['cardId', 'categoryId', 'invoiceId', 'debtorId'],
  invoices: ['cardId'],
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
    } else if (rule.kind === 'month') {
      if (typeof value !== 'string' || !/^[0-9]{4}-(0[1-9]|1[0-2])$/.test(value)) {
        errors[field] = 'Mês inválido (use AAAA-MM).';
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

  if (kind === 'cardPurchases' && !errors.installmentNumber && !errors.installmentsTotal
    && data.installmentNumber !== undefined && data.installmentsTotal !== undefined
    && Number(data.installmentNumber) > Number(data.installmentsTotal)) {
    errors.installmentNumber = 'A parcela não pode ser maior que o total de parcelas.';
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

/**
 * Próxima data de cobrança a partir de "YYYY-MM-DD" (puro, UTC, meio-dia).
 * weekly +7 dias; monthly/yearly mantêm o dia e fazem clamp ao último dia do mês
 * destino (31/01 → 28/02; 29/02 → 28/02). O clamp não "lembra" o dia original
 * (31/01 → 28/02 → 28/03). Retorna null para data/periodicidade inválidas.
 */
export function advanceChargeDate(isoDate, periodicity) {
  const base = parseIsoDate(isoDate);
  if (!base || !CHARGES_PER_YEAR[periodicity]) return null;
  if (periodicity === 'weekly') {
    return new Date(base.getTime() + 7 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  }
  const months = periodicity === 'monthly' ? 1 : 12;
  const y = base.getUTCFullYear();
  const m = base.getUTCMonth() + months;
  const lastDay = new Date(Date.UTC(y, m + 1, 0, 12)).getUTCDate();
  const day = Math.min(base.getUTCDate(), lastDay);
  return new Date(Date.UTC(y, m, day, 12)).toISOString().slice(0, 10);
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
 * Visão consolidada de um devedor por origem (VF-2-03i). `lentCents` já inclui as compras de
 * cartão vinculadas (o service soma ao lançar); aqui só se separa: cartão = soma das parcelas
 * vinculadas (limitada ao emprestado), empréstimo = restante. O recebido não é atribuído por origem.
 * Retorna { lentCents, receivedCents, pendingCents, cardCents, loanCents, cardCount }.
 */
export function debtorOverview(debtor, cardPurchases = []) {
  const lentCents = Number(debtor?.lentCents) || 0;
  const receivedCents = Number(debtor?.receivedCents) || 0;
  let cardCents = 0;
  for (const p of cardPurchases) cardCents += Number(p?.amountCents) || 0;
  cardCents = Math.min(cardCents, lentCents);
  return {
    lentCents,
    receivedCents,
    pendingCents: debtorPendingCents(debtor),
    cardCents,
    loanCents: lentCents - cardCents,
    cardCount: cardPurchases.length,
  };
}

/**
 * Fechamento do mês de um devedor (VF-2-03j) — puro. Soma, para `month` ("YYYY-MM"):
 *  - parcelas de compras no cartão vinculadas (`cardPurchases.debtorId`) cuja FATURA (`invoices.referenceMonth`,
 *    ou o mês da compra se ainda sem fatura) é o mês;
 *  - parcelas de empréstimo (`debts`) pendentes com vencimento no mês, pelo restante (principal − recebido).
 * Sem dupla contagem: `lentCents` já inclui o cartão, mas aqui cada origem vem da SUA coleção e o total do
 * mês é limitado ao pendente do devedor (nunca cobra mais do que ele deve). Devedor não aberto → 0.
 * Retorna { month, card: itens, loan: itens, cardCents, loanCents, rawCents, totalCents, capped }.
 */
export function debtorMonthStatement({ debtor, month, purchases = [], invoicesById = new Map(), debts = [], receivedByDebt = new Map() } = {}) {
  const card = [];
  for (const p of purchases) {
    const invoice = p.invoiceId ? invoicesById.get(p.invoiceId) : null;
    const referenceMonth = invoice?.referenceMonth ?? (typeof p.purchaseDate === 'string' ? p.purchaseDate.slice(0, 7) : null);
    if (referenceMonth !== month) continue;
    card.push({ ...p, referenceMonth, invoiceStatus: invoice?.status ?? null });
  }
  const loan = [];
  for (const d of debts) {
    if (d.status === 'cancelled') continue;
    if (d.status === 'paid' || typeof d.dueDate !== 'string' || d.dueDate.slice(0, 7) !== month) continue;
    const remainingCents = (Number(d.principalCents) || 0) - (receivedByDebt.get(d.id) ?? 0);
    if (remainingCents > 0) loan.push({ ...d, remainingCents });
  }
  const cardCents = card.reduce((t, p) => t + (Number(p.amountCents) || 0), 0);
  const loanCents = loan.reduce((t, d) => t + d.remainingCents, 0);
  const rawCents = cardCents + loanCents;
  const open = debtor?.status === 'open';
  const pending = debtorPendingCents(debtor);
  const totalCents = open ? Math.min(rawCents, pending) : 0;
  return {
    month, card, loan, cardCents, loanCents, rawCents, totalCents,
    capped: open && rawCents > pending,
  };
}

/**
 * Dívidas do devedor em lista única (VF-2-03m) — puro. Cada obrigação é independente:
 *  - `cash`: dívida à vista (`debts` com installmentsTotal 1);
 *  - `installment`: dívida parcelada (`debts` com installmentsTotal N, agrupadas por `debtGroupId`);
 *  - `legacy`: parcela antiga de empréstimo (sem installmentsTotal);
 *  - `card`: parcela de compra no cartão (`cardPurchases.debtorId`), com cartão, fatura e status da fatura.
 * Totais: `openCents` = pendente do devedor (valor emprestado − recebido, mantido pelos services; é o que
 * os recebimentos abatem); `listedCents` = restante das obrigações listadas, limitado a `openCents`;
 * `unlistedCents` = parte em aberto sem obrigação detalhada (ex.: valor inicial informado sem parcelas) —
 * informativo, nunca alerta. Não há mais teste de "duplicidade": várias obrigações legítimas coexistem.
 */
export function debtorObligations({ debtor, debts = [], receivedByDebt = new Map(), purchases = [], invoicesById = new Map(), cardsById = new Map() } = {}) {
  const items = [];
  for (const d of debts) {
    if (d.status === 'cancelled') continue;
    const received = receivedByDebt.get(d.id) ?? 0;
    const total = Number(d.installmentsTotal) || null;
    items.push({
      source: 'debt', id: d.id, groupId: d.debtGroupId ?? d.id,
      kind: total === 1 ? 'cash' : total ? 'installment' : 'legacy',
      description: d.description, installmentNumber: d.installmentNumber, installmentsTotal: total,
      amountCents: Number(d.principalCents) || 0, receivedCents: received,
      remainingCents: d.status === 'paid' ? 0 : Math.max(0, (Number(d.principalCents) || 0) - received),
      dueDate: d.dueDate, referenceMonth: typeof d.dueDate === 'string' ? d.dueDate.slice(0, 7) : null,
      status: d.status === 'paid' || (Number(d.principalCents) || 0) - received <= 0 ? 'paid' : 'pending',
    });
  }
  for (const p of purchases) {
    const invoice = p.invoiceId ? invoicesById.get(p.invoiceId) : null;
    const amount = Number(p.amountCents) || 0;
    items.push({
      source: 'card', id: p.id, groupId: p.purchaseGroup ?? `${p.cardId}:${p.description}:${p.purchaseDate}`, kind: 'card',
      description: p.description, cardName: cardsById.get(p.cardId) ?? null,
      installmentNumber: p.installmentNumber, installmentsTotal: p.installmentsTotal,
      amountCents: amount, receivedCents: 0, remainingCents: invoice?.status === 'cancelled' ? 0 : amount,
      dueDate: invoice?.dueDate ?? null,
      referenceMonth: invoice?.referenceMonth ?? (typeof p.purchaseDate === 'string' ? p.purchaseDate.slice(0, 7) : null),
      invoiceStatus: invoice?.status ?? null,
      status: invoice?.status === 'paid' ? 'paid' : invoice?.status === 'cancelled' ? 'cancelled' : 'pending',
    });
  }
  items.sort((a, b) => String(a.referenceMonth).localeCompare(String(b.referenceMonth))
    || String(a.description).localeCompare(String(b.description)) || (a.installmentNumber - b.installmentNumber));
  const openCents = debtorPendingCents(debtor);
  const listedCents = Math.min(openCents, items.reduce((t, i) => t + i.remainingCents, 0));
  return { items, openCents, listedCents, unlistedCents: openCents - listedCents };
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

// ---------------------------------------------------------------------------
// Cartões e faturas (VF-2-03d) — puros
// ---------------------------------------------------------------------------

const MONTH_KEY = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** "YYYY-MM" + n meses → "YYYY-MM" (n pode ser negativo); null se inválido. */
export function addMonths(month, n) {
  const m = MONTH_KEY.exec(month ?? '');
  if (!m || !Number.isInteger(n)) return null;
  const index = Number(m[1]) * 12 + (Number(m[2]) - 1) + n;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;
}

/** Dia `day` do mês "YYYY-MM" com clamp ao último dia (31 em fevereiro → 28/29). */
export function clampDayInMonth(month, day) {
  const m = MONTH_KEY.exec(month ?? '');
  if (!m || !Number.isInteger(day) || day < 1) return null;
  const last = new Date(Date.UTC(Number(m[1]), Number(m[2]), 0, 12)).getUTCDate();
  return `${month}-${String(Math.min(day, last)).padStart(2, '0')}`;
}

/**
 * Fechamento e vencimento da fatura do mês de referência. Vence no mesmo mês se
 * dueDay > closingDay; senão, no mês seguinte.
 */
export function invoiceDatesFor(card, referenceMonth) {
  const closingDate = clampDayInMonth(referenceMonth, Number(card?.closingDay));
  const dueMonth = Number(card?.dueDay) > Number(card?.closingDay) ? referenceMonth : addMonths(referenceMonth, 1);
  const dueDate = clampDayInMonth(dueMonth, Number(card?.dueDay));
  return closingDate && dueDate ? { closingDate, dueDate } : null;
}

/** Mês da fatura que recebe uma compra: após o fechamento do mês, vai para o seguinte. */
export function invoiceMonthForPurchase(card, purchaseDate) {
  if (!isValidIsoDate(purchaseDate)) return null;
  const month = purchaseDate.slice(0, 7);
  const closing = clampDayInMonth(month, Number(card?.closingDay));
  if (!closing) return null;
  return purchaseDate > closing ? addMonths(month, 1) : month;
}

/** Divide o total em n parcelas inteiras; o resto vai para a primeira. null se total < n. */
export function splitInstallments(totalCents, n) {
  if (!Number.isInteger(totalCents) || !Number.isInteger(n) || n < 1 || totalCents < n) return null;
  const base = Math.floor(totalCents / n);
  const parts = Array(n).fill(base);
  parts[0] += totalCents - base * n;
  return parts;
}

/**
 * Limite usado = compras de faturas ainda não pagas/canceladas (ou sem fatura).
 * Retorna { usedCents, availableCents } (disponível nunca negativo). Derivado, não gravado.
 */
export function cardLimitUsage(card, purchases = [], invoices = []) {
  const settled = new Set(invoices.filter((i) => i.status === 'paid' || i.status === 'cancelled').map((i) => i.id));
  const usedCents = purchases.reduce(
    (total, p) => (p.invoiceId && settled.has(p.invoiceId) ? total : total + (Number(p.amountCents) || 0)), 0);
  return { usedCents, availableCents: Math.max(0, (Number(card?.limitCents) || 0) - usedCents) };
}

/** Total derivado de uma fatura aberta (soma das parcelas vinculadas). */
export function invoiceTotalCents(purchases = []) {
  return purchases.reduce((total, p) => total + (Number(p?.amountCents) || 0), 0);
}
