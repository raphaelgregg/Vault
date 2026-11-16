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
import { ACCOUNT_TYPES, RECURRENCES } from '../utils/constants.js';

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
const refField = (required = true) => ({ kind: 'ref', max: 128, required });
const money = () => ({ kind: 'cents', required: true, positive: true });
const cents0 = () => ({ kind: 'cents', required: true, positive: false });
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
      categoryId: refField(),
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
      categoryId: refField(),
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
});

/** Campos de referência por schema (IDs de docs da própria árvore). */
export const REF_FIELDS = Object.freeze({
  accounts: [],
  categories: [],
  incomes: ['categoryId', 'accountId'],
  expenses: ['categoryId', 'accountId'],
  transfers: ['fromAccountId', 'toAccountId'],
});

// ---------------------------------------------------------------------------
// Validação e normalização
// ---------------------------------------------------------------------------

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** true quando a string é uma data de calendário real em "YYYY-MM-DD". */
export function isValidIsoDate(value) {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
}

/**
 * Valida os dados de uma entidade (sem createdAt/updatedAt — o serviço os grava).
 * Retorna { ok, errors } com mensagens em pt-BR por campo.
 */
export function validateEntity(kind, data) {
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
    } else if (rule.kind === 'date') {
      if (!isValidIsoDate(value)) errors[field] = 'Data inválida (use AAAA-MM-DD).';
    } else if (rule.kind === 'ref') {
      if (typeof value !== 'string' || value.trim().length === 0 || value.length > rule.max) {
        errors[field] = 'Referência inválida.';
      }
    }
  }

  if (kind === 'transfers' && data.fromAccountId && data.toAccountId
    && data.fromAccountId === data.toAccountId) {
    errors.toAccountId = 'A conta de destino deve ser diferente da conta de origem.';
  }

  return { ok: Object.keys(errors).length === 0, errors };
}

/**
 * Normaliza os dados validados para gravação: texto aparado, dinheiro em
 * centavos inteiros, datas mantidas em "YYYY-MM-DD". Retorna { ok, data, errors }.
 */
export function buildEntity(kind, data) {
  const check = validateEntity(kind, data);
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
    } else {
      out[field] = value;
    }
  }
  return { ok: true, data: out, errors: {} };
}

// ---------------------------------------------------------------------------
// Derivações financeiras (nada de saldo gravado: sempre calculado)
// ---------------------------------------------------------------------------

/**
 * Saldo atual de cada conta, derivado dos movimentos:
 *   saldo = saldo inicial
 *         + receitas recebidas (status received)
 *         - despesas pagas (status paid)
 *         + transferências confirmadas recebidas - confirmadas enviadas.
 * Transferências pendentes/canceladas não movem dinheiro.
 */
export function accountBalances(accounts, { incomes = [], expenses = [], transfers = [] } = {}) {
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
