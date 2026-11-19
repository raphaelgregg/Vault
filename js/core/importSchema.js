/**
 * Esquema de importação/exportação CSV (VF-2-03u) — PURO (sem DOM/rede). Cada entidade descreve colunas em
 * português, o campo do modelo correspondente e como resolver referências por NOME (conta, categoria, cartão,
 * devedor). `mapImportRow` valida sem gravar (dry-run): conversão exata de dinheiro/data, resolução de
 * referências e `validateEntity` do modelo (os mesmos erros que o service daria). A gravação usa os services.
 */
import { validateEntity } from './model.js';
import { normalizeMoneyText, normalizeDateText, normalizeName } from '../utils/csv.js';

export const MAX_IMPORT_ROWS = 500; // limite de linhas por importação (um lote de gravação)

const col = (name, field, type, extra = {}) => ({ name, field, type, ...extra });
const LIGHT_GREEN = '#1f7a5c';

/**
 * type: text | enum | money | date | int | month | ref:accounts | ref:categories | ref:cards | ref:debtors.
 * `required` = a coluna precisa estar preenchida; `def` = valor quando vazio; `example` = linha do modelo.
 */
export const IMPORT_ENTITIES = Object.freeze({
  contas: {
    label: 'Contas', kind: 'accounts', create: 'createAccount',
    columns: [
      col('instituicao', 'institution', 'text', { required: true, example: 'Nubank' }),
      col('nome', 'name', 'text', { required: true, example: 'Conta Corrente' }),
      col('tipo', 'type', 'enum', { required: true, example: 'checking', help: 'checking|salary|savings|digital|investment|benefit|other' }),
      col('saldo_inicial', 'initialBalanceCents', 'money', { def: '0', example: '1500,00' }),
      col('cor', 'color', 'text', { def: LIGHT_GREEN, example: '#1f7a5c' }),
      col('status', 'status', 'enum', { def: 'active', example: 'active', help: 'active|inactive|archived' }),
    ],
  },
  categorias: {
    label: 'Categorias', kind: 'categories', create: 'createCategory',
    columns: [
      col('nome', 'name', 'text', { required: true, example: 'Mercado' }),
      col('tipo', 'kind', 'enum', { required: true, example: 'expense', help: 'income|expense|both' }),
      col('cor', 'color', 'text', { def: LIGHT_GREEN, example: '#c0392b' }),
    ],
  },
  receitas: {
    label: 'Receitas', kind: 'incomes', create: 'createIncome',
    columns: [
      col('descricao', 'description', 'text', { required: true, example: 'Salário' }),
      col('categoria', 'categoryId', 'ref:categories', { required: true, example: 'Salário' }),
      col('valor', 'amountCents', 'money', { required: true, example: '5000,00' }),
      col('data_prevista', 'expectedDate', 'date', { required: true, example: '2026-12-05' }),
      col('data_recebimento', 'receivedDate', 'date', { example: '' }),
      col('conta', 'accountId', 'ref:accounts', { required: true, example: 'Conta Corrente' }),
      col('status', 'status', 'enum', { def: 'pending', example: 'pending', help: 'pending|received|cancelled' }),
      col('recorrencia', 'recurrence', 'enum', { def: 'none', example: 'none', help: 'none|monthly|weekly|yearly' }),
      col('observacoes', 'notes', 'text', { example: '' }),
    ],
  },
  despesas: {
    label: 'Despesas', kind: 'expenses', create: 'createExpense',
    columns: [
      col('descricao', 'description', 'text', { required: true, example: 'Supermercado' }),
      col('categoria', 'categoryId', 'ref:categories', { required: true, example: 'Mercado' }),
      col('valor', 'amountCents', 'money', { required: true, example: '350,90' }),
      col('data_compra', 'purchaseDate', 'date', { required: true, example: '2026-12-01' }),
      col('vencimento', 'dueDate', 'date', { required: true, example: '2026-12-01' }),
      col('data_pagamento', 'paidDate', 'date', { example: '' }),
      col('conta', 'accountId', 'ref:accounts', { required: true, example: 'Conta Corrente' }),
      col('status', 'status', 'enum', { def: 'pending', example: 'pending', help: 'pending|paid|cancelled' }),
      col('recorrencia', 'recurrence', 'enum', { def: 'none', example: 'none', help: 'none|monthly|weekly|yearly' }),
      col('observacoes', 'notes', 'text', { example: '' }),
    ],
  },
  transferencias: {
    label: 'Transferências', kind: 'transfers', create: 'createTransfer',
    columns: [
      col('origem', 'fromAccountId', 'ref:accounts', { required: true, example: 'Conta Corrente' }),
      col('destino', 'toAccountId', 'ref:accounts', { required: true, example: 'Caixinha' }),
      col('valor', 'amountCents', 'money', { required: true, example: '500,00' }),
      col('data', 'date', 'date', { required: true, example: '2026-12-02' }),
      col('motivo', 'reason', 'text', { required: true, example: 'Reserva' }),
      col('status', 'status', 'enum', { def: 'pending', example: 'confirmed', help: 'pending|confirmed|cancelled' }),
      col('observacoes', 'notes', 'text', { example: '' }),
    ],
  },
  assinaturas: {
    label: 'Assinaturas', kind: 'subscriptions', create: 'createSubscription',
    columns: [
      col('nome', 'name', 'text', { required: true, example: 'Netflix' }),
      col('valor', 'amountCents', 'money', { required: true, example: '55,90' }),
      col('periodicidade', 'periodicity', 'enum', { required: true, example: 'monthly', help: 'monthly|weekly|yearly' }),
      col('proxima_cobranca', 'nextChargeDate', 'date', { required: true, example: '2026-12-10' }),
      col('conta', 'accountId', 'ref:accounts', { required: true, example: 'Conta Corrente' }),
      col('categoria', 'categoryId', 'ref:categories', { required: true, example: 'Assinaturas' }),
      col('cartao', 'cardId', 'ref:cards', { example: '', help: 'opcional: cobrada na fatura do cartão' }),
      col('status', 'status', 'enum', { def: 'active', example: 'active', help: 'active|paused|cancelled' }),
      col('observacoes', 'notes', 'text', { example: '' }),
    ],
  },
  devedores: {
    label: 'Devedores', kind: 'debtors', create: 'createDebtor',
    columns: [
      col('nome', 'name', 'text', { required: true, example: 'Maria' }),
      col('data', 'loanDate', 'date', { required: true, example: '2026-12-01' }),
      col('valor_emprestado', 'lentCents', 'money', { def: '0', example: '0,00', help: 'pode ser 0' }),
      col('observacoes', 'notes', 'text', { example: '' }),
    ],
  },
  dividas: {
    label: 'Dívidas de devedores (à vista/parceladas)', kind: null, create: 'createDebtPlan',
    columns: [
      col('devedor', 'debtorId', 'ref:debtors', { required: true, example: 'Maria' }),
      col('descricao', 'description', 'text', { required: true, example: 'Moto' }),
      col('total', 'totalCents', 'money', { required: true, example: '600,00' }),
      col('parcelas', 'installments', 'int', { def: '1', example: '3', help: '1 = à vista' }),
      col('primeiro_vencimento', 'firstDueDate', 'date', { required: true, example: '2026-12-10' }),
    ],
  },
  metas: {
    label: 'Metas', kind: 'goals', create: 'createGoal',
    columns: [
      col('nome', 'name', 'text', { required: true, example: 'Caixinha' }),
      col('objetivo', 'targetCents', 'money', { required: true, example: '10000,00' }),
      col('prazo', 'deadline', 'date', { example: '2027-12-31' }),
      col('conta', 'accountId', 'ref:accounts', { example: 'Caixinha', help: 'opcional: progresso = saldo da conta' }),
      col('descricao', 'description', 'text', { example: '' }),
    ],
  },
  cartoes: {
    label: 'Cartões', kind: 'creditCards', create: 'createCard',
    columns: [
      col('nome', 'name', 'text', { required: true, example: 'Nubank' }),
      col('bandeira', 'brand', 'text', { required: true, example: 'Mastercard' }),
      col('limite', 'limitCents', 'money', { required: true, example: '5000,00' }),
      col('dia_fechamento', 'closingDay', 'int', { required: true, example: '10' }),
      col('dia_vencimento', 'dueDay', 'int', { required: true, example: '17' }),
      col('conta', 'accountId', 'ref:accounts', { example: '' }),
      col('cor', 'color', 'text', { example: '' }),
    ],
  },
  compras_cartao: {
    label: 'Compras no cartão', kind: 'cardPurchases', create: 'registerCardPurchase',
    columns: [
      col('cartao', 'cardId', 'ref:cards', { required: true, example: 'Nubank' }),
      col('descricao', 'description', 'text', { required: true, example: 'Notebook' }),
      col('valor_total', 'amountCents', 'money', { required: true, example: '3000,00' }),
      col('parcelas', 'installmentsTotal', 'int', { def: '1', example: '3' }),
      col('data_compra', 'purchaseDate', 'date', { required: true, example: '2026-12-01' }),
      col('categoria', 'categoryId', 'ref:categories', { example: '' }),
      col('devedor', 'debtorId', 'ref:debtors', { example: '', help: 'opcional: soma ao emprestado do devedor' }),
      col('observacoes', 'notes', 'text', { example: '' }),
    ],
  },
});

export const IMPORT_ENTITY_KEYS = Object.freeze(Object.keys(IMPORT_ENTITIES));

/** Cabeçalho + 1 linha de exemplo, para o template baixável. */
export function templateRows(key) {
  const def = IMPORT_ENTITIES[key];
  return { headers: def.columns.map((c) => c.name), rows: [def.columns.map((c) => c.example ?? '')] };
}

/** Resolve nome/identificador de conta/categoria/cartão/devedor. Retorna { id } | { error }. */
export function resolveRef(refType, value, ctx) {
  const list = ctx?.[refType] ?? [];
  const wanted = normalizeName(value);
  const labels = (item) => {
    const base = [item.name];
    if (item.institution) base.push(`${item.institution} — ${item.name}`, `${item.institution} - ${item.name}`);
    return base.map(normalizeName);
  };
  const byId = list.filter((i) => i.id === value);
  const hits = byId.length ? byId : list.filter((i) => labels(i).includes(wanted));
  if (hits.length === 1) return { id: hits[0].id };
  if (hits.length > 1) return { error: `"${value}" é ambíguo (${hits.length} registros com esse nome); use o identificador.` };
  return { error: `"${value}" não encontrado(a).` };
}

const REF_TYPES = { 'ref:accounts': 'accounts', 'ref:categories': 'categories', 'ref:cards': 'cards', 'ref:debtors': 'debtors' };

/**
 * Valida UMA linha sem gravar. `ctx`: { accounts, categories, cards, debtors } com { id, name[, institution] }.
 * Retorna { ok, raw, errors: { coluna: msg }, warnings: [msg] }. `raw` já usa os nomes de campo do modelo.
 */
export function mapImportRow(key, values, ctx) {
  const def = IMPORT_ENTITIES[key];
  const errors = {};
  const warnings = [];
  const raw = {};
  const colOfField = {};
  const known = new Set(def.columns.map((c) => c.name));
  for (const name of Object.keys(values)) if (!known.has(name)) warnings.push(`Coluna desconhecida ignorada: "${name}".`);

  for (const c of def.columns) {
    colOfField[c.field] = c.name;
    let text = String(values[c.name] ?? '').trim();
    if (text === '' && c.def !== undefined) text = c.def;
    if (text === '') {
      if (c.required) errors[c.name] = 'Campo obrigatório.';
      continue;
    }
    if (c.type === 'money') {
      const normalized = normalizeMoneyText(text);
      if (normalized === null) errors[c.name] = `Valor monetário inválido ou ambíguo: "${text}" (use 1234,56).`;
      else raw[c.field] = normalized;
    } else if (c.type === 'date') {
      const date = normalizeDateText(text);
      if (date === null) errors[c.name] = `Data inválida: "${text}" (use AAAA-MM-DD).`;
      else raw[c.field] = date;
    } else if (c.type === 'int') {
      if (/^\d+$/.test(text)) raw[c.field] = Number(text);
      else errors[c.name] = `Número inteiro inválido: "${text}".`;
    } else if (c.type === 'enum') {
      raw[c.field] = text.toLowerCase();
    } else if (REF_TYPES[c.type]) {
      const r = resolveRef(REF_TYPES[c.type], text, ctx);
      if (r.error) errors[c.name] = r.error;
      else raw[c.field] = r.id;
    } else {
      raw[c.field] = text;
    }
  }

  // Validação do modelo (mesmas regras dos services), só dos campos sem erro de formato/referência.
  if (!Object.keys(errors).length) {
    let check;
    if (def.kind === 'cardPurchases') check = validateEntity('cardPurchases', { ...raw, installmentsTotal: raw.installmentsTotal ?? 1, installmentNumber: 1 });
    else if (def.kind) check = validateEntity(def.kind, withModelDefaults(key, raw));
    else check = validatePlan(raw);
    for (const [field, message] of Object.entries(check.errors ?? {})) errors[colOfField[field] ?? field] = message;
  }

  // Avisos (não impedem): nome repetido de conta/categoria/cartão já existente.
  const dupType = { contas: 'accounts', categorias: 'categories', cartoes: 'cards' }[key];
  if (dupType && raw.name && (ctx?.[dupType] ?? []).some((i) => normalizeName(i.name) === normalizeName(raw.name))) {
    warnings.push(`Já existe registro com o nome "${raw.name}"; será criado outro (referências por nome ficarão ambíguas).`);
  }
  return { ok: Object.keys(errors).length === 0, raw, errors, warnings };
}

/** Campos que os services forçam/definem (status etc.) e o schema exige para validar. */
function withModelDefaults(key, raw) {
  if (key === 'devedores') return { ...raw, receivedCents: 0, status: 'open' };
  if (key === 'metas') return { ...raw, status: 'active' };
  if (key === 'cartoes') return { ...raw, status: 'active' };
  return raw;
}

function validatePlan(raw) {
  const errors = {};
  if (!Number.isInteger(raw.installments) || raw.installments < 1 || raw.installments > 120) errors.installments = 'Informe de 1 a 120 parcelas.';
  return { errors };
}
