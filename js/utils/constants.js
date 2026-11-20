/**
 * Constantes do domínio: coleções por usuário, rótulos e listas fechadas.
 * Fonte única de verdade dos nomes usados pelo cliente e pelas Security Rules.
 */

/** Coleções sob users/{userId}/ */
export const COLLECTIONS = Object.freeze({
  profile: 'profile',
  accounts: 'accounts',
  categories: 'categories',
  incomes: 'incomes',
  expenses: 'expenses',
  transfers: 'transfers',
  subscriptions: 'subscriptions',
  debtors: 'debtors',
  debts: 'debts',
  debtPayments: 'debtPayments',
  reversals: 'reversals',
  operations: 'operations',
  batches: 'batches',
  goals: 'goals',
  goalTransactions: 'goalTransactions',
  creditCards: 'creditCards',
  cardPurchases: 'cardPurchases',
  invoices: 'invoices',
  budgets: 'budgets',
  settings: 'settings',
  auditLog: 'auditLog',
});

/** Coleções de documento único (não são listas) */
export const SINGLETON_COLLECTIONS = Object.freeze(['profile', 'settings']);

export const ACCOUNT_TYPES = Object.freeze([
  { value: 'checking', label: 'Conta corrente' },
  { value: 'salary', label: 'Conta salário' },
  { value: 'savings', label: 'Conta poupança' },
  { value: 'digital', label: 'Carteira digital' },
  { value: 'investment', label: 'Investimento' },
  { value: 'benefit', label: 'Benefício' },
  { value: 'other', label: 'Outros' },
]);

export const RECURRENCES = Object.freeze([
  { value: 'none', label: 'Sem recorrência' },
  { value: 'monthly', label: 'Mensal' },
  { value: 'weekly', label: 'Semanal' },
  { value: 'yearly', label: 'Anual' },
]);

export const SUBSCRIPTION_PERIODICITIES = Object.freeze([
  { value: 'monthly', label: 'Mensal' },
  { value: 'weekly', label: 'Semanal' },
  { value: 'yearly', label: 'Anual' },
]);

export const SUBSCRIPTION_STATUSES = Object.freeze([
  { value: 'active', label: 'Ativa' },
  { value: 'paused', label: 'Pausada' },
  { value: 'cancelled', label: 'Cancelada' },
]);

export const DEBTOR_STATUSES = Object.freeze([
  { value: 'open', label: 'Em aberto' },
  { value: 'paid', label: 'Quitado' },
  { value: 'cancelled', label: 'Cancelado' },
]);

export const DEBT_STATUSES = Object.freeze([
  { value: 'pending', label: 'Pendente' },
  { value: 'paid', label: 'Paga' },
  { value: 'late', label: 'Atrasada' },
  { value: 'cancelled', label: 'Cancelada' },
]);

export const GOAL_STATUSES = Object.freeze([
  { value: 'active', label: 'Ativa' },
  { value: 'completed', label: 'Concluída' },
  { value: 'cancelled', label: 'Cancelada' },
]);

export const GOAL_TRANSACTION_TYPES = Object.freeze([
  { value: 'deposit', label: 'Aporte' },
  { value: 'withdraw', label: 'Resgate' },
]);

export const CARD_STATUSES = Object.freeze([
  { value: 'active', label: 'Ativo' },
  { value: 'blocked', label: 'Bloqueado' },
  { value: 'cancelled', label: 'Cancelado' },
]);

export const INVOICE_STATUSES = Object.freeze([
  { value: 'open', label: 'Aberta' },
  { value: 'closed', label: 'Fechada' },
  { value: 'paid', label: 'Paga' },
  { value: 'cancelled', label: 'Cancelada' },
]);

export const DOC_STATUS = Object.freeze({
  active: 'active',
  inactive: 'inactive',
  cancelled: 'cancelled',
  pending: 'pending',
  paid: 'paid',
  received: 'received',
  open: 'open',
  closed: 'closed',
  archived: 'archived',
});

export const CURRENCY = 'BRL';
export const LOCALE = 'pt-BR';
export const TIMEZONE = 'America/Sao_Paulo';

/** Nome do documento único de perfil e de configurações */
export const PROFILE_DOC_ID = 'main';
export const SETTINGS_DOC_ID = 'main';
