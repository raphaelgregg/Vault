/**
 * Importação/exportação CSV em massa (VF-2-03u). Fluxo em 2 etapas:
 *  1) `dryRunImport` — lê o CSV, resolve referências por nome e valida TUDO sem gravar nada;
 *  2) `applyImport` — grava só as linhas válidas, uma a uma pelos services do app (Rules, centavos inteiros,
 *     auditoria), com log por linha (inclusive `permission-denied` destacado). Máx. `MAX_IMPORT_ROWS` por vez.
 * `io` (list, creators) é injetável nos testes.
 */
import { COLLECTIONS } from '../utils/constants.js';
import { list } from './firestore.js';
import { parseCsv, toCsv } from '../utils/csv.js';
import { makeZip } from '../utils/zip.js';
import { centsToMoneyString } from '../core/model.js';
import { IMPORT_ENTITIES, IMPORT_ENTITY_KEYS, MAX_IMPORT_ROWS, mapImportRow, templateRows } from '../core/importSchema.js';
import { createAccount } from './accounts.js';
import { createCategory } from './categories.js';
import { createIncome } from './incomes.js';
import { createExpense } from './expenses.js';
import { createTransfer } from './transfers.js';
import { createSubscription } from './subscriptions.js';
import { createDebtor } from './debtors.js';
import { createDebtPlan } from './debtPayments.js';
import { createGoal } from './goals.js';
import { createCard, registerCardPurchase } from './creditCards.js';

export { IMPORT_ENTITIES, IMPORT_ENTITY_KEYS, MAX_IMPORT_ROWS };

const CREATORS = {
  contas: (uid, raw) => createAccount(uid, raw),
  categorias: (uid, raw) => createCategory(uid, raw),
  receitas: (uid, raw) => createIncome(uid, raw),
  despesas: (uid, raw) => createExpense(uid, raw),
  transferencias: (uid, raw) => createTransfer(uid, raw),
  assinaturas: (uid, raw) => createSubscription(uid, raw),
  devedores: (uid, raw) => createDebtor(uid, raw),
  dividas: (uid, raw) => createDebtPlan(uid, raw),
  metas: (uid, raw) => createGoal(uid, raw),
  cartoes: (uid, raw) => createCard(uid, raw),
  compras_cartao: (uid, raw) => {
    const { cardId, ...rest } = raw;
    return registerCardPurchase(uid, cardId, rest);
  },
};

/**
 * Modelo CSV VAZIO: só os cabeçalhos (sem dados e sem exemplo). Os registros existentes saem em `exportCsv`.
 * `withExample: true` acrescenta 1 linha de exemplo (uso interno/testes).
 */
export function templateCsv(key, { delimiter = ';', withExample = false } = {}) {
  const { headers, rows } = templateRows(key);
  return toCsv(headers, withExample ? rows : [], { delimiter });
}

/** Referências existentes para resolver nomes (contas, categorias, cartões, devedores). */
export async function loadImportContext(uid, io = {}) {
  const fetchList = io.list ?? list;
  const [accounts, categories, cards, debtors] = await Promise.all([
    fetchList(uid, COLLECTIONS.accounts, {}),
    fetchList(uid, COLLECTIONS.categories, {}),
    fetchList(uid, COLLECTIONS.creditCards, {}),
    fetchList(uid, COLLECTIONS.debtors, {}),
  ]);
  return { accounts, categories, cards, debtors };
}

/**
 * Pré-validação (dry-run, NÃO grava). Retorna
 * { key, delimiter, fileErrors, missingColumns, rows: [{ line, ok, errors, warnings, raw }], total, valid, invalid, warnings, truncated }.
 */
export function dryRunImport(key, text, ctx) {
  const def = IMPORT_ENTITIES[key];
  if (!def) return { key, fileErrors: [{ line: 0, message: 'Entidade desconhecida.' }], rows: [], total: 0, valid: 0, invalid: 0, warnings: 0, missingColumns: [], truncated: false };
  const parsed = parseCsv(text);
  const fileErrors = [...parsed.errors];
  const required = def.columns.filter((c) => c.required).map((c) => c.name);
  const missingColumns = required.filter((name) => !parsed.headers.includes(name));
  if (missingColumns.length) fileErrors.push({ line: 1, message: `Colunas obrigatórias ausentes: ${missingColumns.join(', ')}.` });
  const truncated = parsed.rows.length > MAX_IMPORT_ROWS;
  if (truncated) fileErrors.push({ line: 0, message: `Máximo de ${MAX_IMPORT_ROWS} linhas por importação; divida o arquivo (as ${parsed.rows.length - MAX_IMPORT_ROWS} excedentes foram ignoradas).` });
  const rows = missingColumns.length
    ? []
    : parsed.rows.slice(0, MAX_IMPORT_ROWS).map((r) => ({ line: r.line, ...mapImportRow(key, r.values, ctx) }));
  const valid = rows.filter((r) => r.ok).length;
  return {
    key, delimiter: parsed.delimiter, fileErrors, missingColumns, rows, truncated,
    total: parsed.rows.length, valid, invalid: rows.length - valid, warnings: rows.reduce((t, r) => t + r.warnings.length, 0),
  };
}

const describeFailure = (error) => {
  const code = String(error?.code ?? '');
  return { message: code ? `${code}: ${error?.message ?? ''}`.trim() : (error?.message ?? String(error)), permissionDenied: code.includes('permission-denied') };
};

/**
 * Efetiva SOMENTE as linhas válidas do dry-run (sequencial, pelos services). `onLog(entry)` recebe
 * { line, ok, id?, message?, permissionDenied? } a cada linha. Retorna { created, failed, permissionDenied, entries }.
 */
export async function applyImport(uid, plan, { onLog, io = {} } = {}) {
  const create = (io.creators ?? CREATORS)[plan.key];
  if (!create) throw new Error('Entidade desconhecida.');
  const entries = [];
  const push = (entry) => { entries.push(entry); onLog?.(entry); };
  for (const row of plan.rows.filter((r) => r.ok)) {
    try {
      const r = await create(uid, row.raw);
      if (r?.ok === false) {
        push({ line: row.line, ok: false, message: Object.values(r.errors ?? {}).join(' · ') || 'Rejeitada pelo service.' });
      } else {
        push({ line: row.line, ok: true, id: r?.id ?? r?.ids?.[0] ?? null });
      }
    } catch (error) {
      const f = describeFailure(error);
      push({ line: row.line, ok: false, message: f.message, permissionDenied: f.permissionDenied });
    }
  }
  return {
    created: entries.filter((e) => e.ok).length,
    failed: entries.filter((e) => !e.ok).length,
    permissionDenied: entries.filter((e) => e.permissionDenied).length,
    entries,
  };
}

// ---------------------------------------------------------------------------
// Exportação
// ---------------------------------------------------------------------------

const EXPORT_COLLECTION = {
  contas: COLLECTIONS.accounts, categorias: COLLECTIONS.categories, receitas: COLLECTIONS.incomes, despesas: COLLECTIONS.expenses,
  transferencias: COLLECTIONS.transfers, assinaturas: COLLECTIONS.subscriptions, devedores: COLLECTIONS.debtors,
  dividas: COLLECTIONS.debts, metas: COLLECTIONS.goals, cartoes: COLLECTIONS.creditCards, compras_cartao: COLLECTIONS.cardPurchases,
};
const REF_COLLECTION = { 'ref:accounts': 'accounts', 'ref:categories': 'categories', 'ref:cards': 'cards', 'ref:debtors': 'debtors' };

/** Nome legível da referência (conta = "Instituição — Nome"). */
const refLabel = (item) => (item.institution ? `${item.institution} — ${item.name}` : item.name);

/** Agrupa parcelas em dívidas/compras (uma linha por dívida/compra, como na importação). */
function groupRows(key, docs) {
  if (key === 'dividas') {
    const groups = new Map();
    for (const d of docs.filter((x) => x.status !== 'cancelled')) {
      const id = d.debtGroupId ?? d.id;
      const g = groups.get(id) ?? { debtorId: d.debtorId, description: d.description, totalCents: 0, count: 0, installments: d.installmentsTotal, firstDueDate: d.dueDate };
      g.totalCents += Number(d.principalCents) || 0;
      g.count += 1;
      if (d.dueDate < g.firstDueDate) g.firstDueDate = d.dueDate;
      groups.set(id, g);
    }
    return [...groups.values()].map((g) => ({ debtorId: g.debtorId, description: g.description, totalCents: g.totalCents, installments: g.installments ?? g.count, firstDueDate: g.firstDueDate }));
  }
  if (key === 'compras_cartao') {
    const groups = new Map();
    for (const p of docs) {
      const id = `${p.cardId}|${p.description}|${p.purchaseDate}|${p.installmentsTotal}|${p.debtorId ?? ''}`;
      const g = groups.get(id) ?? { ...p, amountCents: 0 };
      g.amountCents += Number(p.amountCents) || 0;
      groups.set(id, g);
    }
    return [...groups.values()];
  }
  return docs;
}

/** CSV da base atual (mesmas colunas do modelo, referências por nome). Retorna { filename, text, rowCount }. */
export async function exportCsv(uid, key, { delimiter = ';', io = {}, ctx: sharedCtx = null } = {}) {
  const def = IMPORT_ENTITIES[key];
  if (!def) throw new Error('Entidade desconhecida.');
  const fetchList = io.list ?? list;
  const [docs, ctx] = await Promise.all([fetchList(uid, EXPORT_COLLECTION[key], {}), sharedCtx ?? loadImportContext(uid, io)]);
  const rows = groupRows(key, docs).map((doc) => def.columns.map((c) => {
    const value = doc[c.field];
    if (value === undefined || value === null) return '';
    if (c.type === 'money') return centsToMoneyString(Number(value));
    const refType = REF_COLLECTION[c.type];
    if (refType) return refLabel((ctx[refType] ?? []).find((i) => i.id === value) ?? { name: value });
    return value;
  }));
  return { filename: `vault-${key}.csv`, text: toCsv(def.columns.map((c) => c.name), rows, { delimiter }), rowCount: rows.length };
}

/**
 * Exporta TODAS as entidades (VF-2-03v): lê cada uma isoladamente — falha de leitura de uma (ex.:
 * `permission-denied`) não interrompe as demais. Reúne os CSVs num único .zip (+ `_resumo.txt`).
 * `onLog({ key, label, ok, rowCount?, filename?, error?, permissionDenied? })` por entidade.
 * Retorna { filename, zip (Uint8Array), results, exported, failed, totalRows }.
 */
export async function exportAllCsv(uid, { delimiter = ';', onLog, io = {}, now = new Date() } = {}) {
  const results = [];
  const files = [];
  // Referências (nomes de conta/categoria/cartão/devedor) lidas UMA vez; se falhar, cada entidade tenta por conta própria.
  const ctx = await loadImportContext(uid, io).catch(() => null);
  for (const key of IMPORT_ENTITY_KEYS) {
    const label = IMPORT_ENTITIES[key].label;
    try {
      const r = await exportCsv(uid, key, { delimiter, io, ctx });
      files.push({ name: r.filename, data: r.text });
      results.push({ key, label, ok: true, rowCount: r.rowCount, filename: r.filename });
    } catch (error) {
      results.push({ key, label, ok: false, error: `${error?.code ? `${error.code}: ` : ''}${error?.message ?? error}`, permissionDenied: String(error?.code ?? '').includes('permission-denied') });
    }
    onLog?.(results.at(-1));
  }
  const exported = results.filter((r) => r.ok).length;
  const totalRows = results.reduce((t, r) => t + (r.rowCount ?? 0), 0);
  const summary = [
    `Exportação completa — ${now.toISOString()}`,
    `Delimitador: "${delimiter}" · UTF-8 com BOM`,
    ...results.map((r) => (r.ok ? `OK     ${r.filename} — ${r.rowCount} linha(s) (${r.label})` : `FALHA  ${r.key} — ${r.error} (${r.label})`)),
    `Total: ${exported}/${results.length} entidade(s), ${totalRows} linha(s).`,
  ].join('\r\n');
  files.push({ name: '_resumo.txt', data: `${summary}\r\n` });
  const stamp = now.toISOString().slice(0, 10);
  return { filename: `vault-exportacao-completa-${stamp}.zip`, zip: makeZip(files, { now }), results, exported, failed: results.length - exported, totalRows };
}
