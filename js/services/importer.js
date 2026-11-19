/**
 * Importação/exportação CSV em massa (VF-2-03u/03ac). Fluxo em 2 etapas:
 *  1) `dryRunImport` — lê o CSV (uma entidade OU o CSV unificado `todas`), resolve referências por nome e valida
 *     TUDO sem gravar nada, classificando cada linha: nova (`create`), a mesclar (`merge`), duplicada (`duplicate`)
 *     ou com erro. Entidades são processadas na ORDEM DE DEPENDÊNCIA (contas → categorias → cartões → devedores →
 *     demais), então o arquivo pode vir fora de ordem e referenciar registros criados no próprio arquivo;
 *  2) `applyImport` — grava pelos services do app (Rules, centavos inteiros, auditoria), grupo a grupo, relendo a
 *     base antes de cada grupo; é IDEMPOTENTE: chave determinística por entidade (`IMPORT_IDENTITY`) evita duplicar
 *     ao reimportar (criados / atualizados / ignorados / falhas no relatório).
 *
 * ISOLAMENTO POR USUÁRIO: toda leitura/gravação é `users/{uid}/…` do `uid` recebido — que a interface sempre passa como
 * o `uid` AUTENTICADO. Este módulo nunca usa consulta de grupo nem privilégio de administrador: mesmo com a claim
 * `admin`, só exporta/importa dados do próprio uid (um teste proíbe `collectionGroup`/`listGroup` aqui).
 * `io` (list, loadData, creators, updaters) é injetável nos testes.
 */
import { COLLECTIONS } from '../utils/constants.js';
import { list } from './firestore.js';
import { parseCsv, toCsv } from '../utils/csv.js';
import { makeZip } from '../utils/zip.js';
import { centsToMoneyString } from '../core/model.js';
import {
  IMPORT_ENTITIES, IMPORT_ENTITY_KEYS, MAX_IMPORT_ROWS, IMPORT_ORDER, IMPORT_IDENTITY, UNIFIED_KEY, UNIFIED_COLUMN,
  mapImportRow, templateRows, unifiedHeaders, unifiedTemplateRows, resolveEntityKey, mergeDiff, filledFields, buildMergeRaw,
} from '../core/importSchema.js';
import { createAccount, updateAccount } from './accounts.js';
import { createCategory, updateCategory } from './categories.js';
import { createIncome } from './incomes.js';
import { createExpense } from './expenses.js';
import { createTransfer } from './transfers.js';
import { createSubscription } from './subscriptions.js';
import { createDebtor, updateDebtor } from './debtors.js';
import { createDebtPlan } from './debtPayments.js';
import { createGoal, updateGoal } from './goals.js';
import { createCard, updateCard, registerCardPurchase } from './creditCards.js';

export { IMPORT_ENTITIES, IMPORT_ENTITY_KEYS, MAX_IMPORT_ROWS, IMPORT_ORDER, UNIFIED_KEY, UNIFIED_COLUMN };

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

const UPDATERS = {
  contas: (uid, id, raw) => updateAccount(uid, id, raw),
  categorias: (uid, id, raw) => updateCategory(uid, id, raw),
  cartoes: (uid, id, raw) => updateCard(uid, id, raw),
  devedores: (uid, id, raw) => updateDebtor(uid, id, raw),
  metas: (uid, id, raw) => updateGoal(uid, id, raw),
};

/**
 * Modelo CSV VAZIO: só os cabeçalhos (sem dados e sem exemplo). Os registros existentes saem em `exportCsv`.
 * `withExample: true` acrescenta 1 linha de exemplo (uso interno/testes).
 */
export function templateCsv(key, { delimiter = ';', withExample = false } = {}) {
  const { headers, rows } = templateRows(key);
  return toCsv(headers, withExample ? rows : [], { delimiter });
}

/** Modelo do CSV UNIFICADO: cabeçalho (`entidade` + colunas) e 1 linha-modelo por entidade, na ordem de dependência. */
export function unifiedTemplateCsv({ delimiter = ';' } = {}) {
  const { headers, rows } = unifiedTemplateRows();
  return toCsv(headers, rows, { delimiter });
}

const COLLECTION_OF = {
  accounts: COLLECTIONS.accounts, categories: COLLECTIONS.categories, creditCards: COLLECTIONS.creditCards, debtors: COLLECTIONS.debtors,
  incomes: COLLECTIONS.incomes, expenses: COLLECTIONS.expenses, transfers: COLLECTIONS.transfers, subscriptions: COLLECTIONS.subscriptions,
  goals: COLLECTIONS.goals, debts: COLLECTIONS.debts, cardPurchases: COLLECTIONS.cardPurchases,
};

/**
 * Lê as 11 coleções DO uid informado (nunca outro). Retorna { accounts, categories, cards, debtors, records, errors }:
 * as 4 listas de referência (resolução por nome), `records[entidade]` (registros existentes; dívidas e compras já
 * AGRUPADAS como na importação) e `errors` ({ coleção: mensagem }) — leitura isolada por coleção.
 */
export async function loadImportData(uid, io = {}) {
  const fetchList = io.list ?? list;
  const errors = {};
  const read = async (name) => {
    try {
      return await fetchList(uid, COLLECTION_OF[name], {});
    } catch (error) {
      errors[COLLECTION_OF[name]] = `${error?.code ? `${error.code}: ` : ''}${error?.message ?? error}`;
      return [];
    }
  };
  const names = Object.keys(COLLECTION_OF);
  const lists = Object.fromEntries(await Promise.all(names.map(async (n) => [n, await read(n)])));
  return {
    accounts: lists.accounts, categories: lists.categories, cards: lists.creditCards, debtors: lists.debtors,
    records: {
      contas: lists.accounts, categorias: lists.categories, cartoes: lists.creditCards, devedores: lists.debtors, receitas: lists.incomes,
      despesas: lists.expenses, transferencias: lists.transfers, assinaturas: lists.subscriptions, metas: lists.goals,
      dividas: groupRows('dividas', lists.debts), compras_cartao: groupRows('compras_cartao', lists.cardPurchases),
    },
    errors,
  };
}

/** Só as 4 listas de referência (nomes de conta/categoria/cartão/devedor) DO uid — leitura enxuta para exportar. */
export async function loadImportContext(uid, io = {}) {
  const fetchList = io.list ?? list;
  const [accounts, categories, cards, debtors] = await Promise.all([
    fetchList(uid, COLLECTIONS.accounts, {}), fetchList(uid, COLLECTIONS.categories, {}),
    fetchList(uid, COLLECTIONS.creditCards, {}), fetchList(uid, COLLECTIONS.debtors, {}),
  ]);
  return { accounts, categories, cards, debtors };
}

/** Mapa chave → registro existente, por entidade. */
function existingIndex(entity, records) {
  const index = new Map();
  for (const record of records?.[entity] ?? []) {
    try { index.set(IMPORT_IDENTITY[entity].key(record), record); } catch { /* registro fora do padrão: ignorado */ }
  }
  return index;
}

/** Referências "planejadas": o que o arquivo vai criar já pode ser citado por linhas de entidades posteriores. */
function addPlanned(ctx, entity, raw, n) {
  const id = `planned:${entity}:${n}`;
  if (entity === 'contas') ctx.accounts.push({ id, institution: raw.institution, name: raw.name });
  else if (entity === 'categorias') ctx.categories.push({ id, name: raw.name, kind: raw.kind });
  else if (entity === 'cartoes') ctx.cards.push({ id, name: raw.name });
  else if (entity === 'devedores') ctx.debtors.push({ id, name: raw.name });
}

/**
 * Classifica uma linha já mapeada contra a base existente e as chaves já vistas. Retorna
 * { action: 'create'|'merge'|'duplicate', key, existing?, changed? }.
 */
function classify(entity, mapped, values, index, seen) {
  const key = IMPORT_IDENTITY[entity].key(mapped.raw);
  if (seen.has(key)) return { action: 'duplicate', key, reason: 'repetida no próprio arquivo' };
  seen.add(key);
  const existing = index.get(key);
  if (!existing) return { action: 'create', key };
  const changed = mergeDiff(entity, mapped.raw, existing, filledFields(entity, values));
  return changed.length ? { action: 'merge', key, existing, changed } : { action: 'duplicate', key, existing, reason: 'já existe' };
}

/**
 * Pré-validação (dry-run, NÃO grava). `data` = resultado de `loadImportData` (referências + registros existentes).
 * `key`: uma entidade ou `UNIFIED_KEY` ('todas', CSV unificado com a coluna `entidade`). Retorna
 * { key, delimiter, fileErrors, missingColumns, rows, total, valid, invalid, warnings, truncated, counts }, em que cada
 * linha tem `action` (create|merge|duplicate|error), `entity`, `values`, `raw`, `errors`, `warnings`.
 */
export function dryRunImport(key, text, data) {
  const unified = key === UNIFIED_KEY;
  const def = IMPORT_ENTITIES[key];
  const empty = (fileErrors) => ({ key, fileErrors, rows: [], total: 0, valid: 0, invalid: 0, warnings: 0, missingColumns: [], truncated: false, counts: { create: 0, merge: 0, duplicate: 0, error: 0 } });
  if (!unified && !def) return empty([{ line: 0, message: 'Entidade desconhecida.' }]);
  const readErrors = Object.entries(data?.errors ?? {});
  if (readErrors.length) {
    return empty(readErrors.map(([c, m]) => ({ line: 0, message: `Falha ao ler "${c}" (${m}). Importar sem conhecer os registros existentes poderia duplicar dados.` })));
  }
  const parsed = parseCsv(text);
  const fileErrors = [...parsed.errors];
  let missingColumns = [];
  if (unified) {
    if (!parsed.headers.includes(UNIFIED_COLUMN)) { missingColumns = [UNIFIED_COLUMN]; fileErrors.push({ line: 1, message: `CSV unificado exige a coluna "${UNIFIED_COLUMN}".` }); }
  } else {
    missingColumns = def.columns.filter((c) => c.required).map((c) => c.name).filter((name) => !parsed.headers.includes(name));
    if (missingColumns.length) fileErrors.push({ line: 1, message: `Colunas obrigatórias ausentes: ${missingColumns.join(', ')}.` });
  }
  const truncated = parsed.rows.length > MAX_IMPORT_ROWS;
  if (truncated) fileErrors.push({ line: 0, message: `Máximo de ${MAX_IMPORT_ROWS} linhas por importação; divida o arquivo (as ${parsed.rows.length - MAX_IMPORT_ROWS} excedentes foram ignoradas).` });
  if (missingColumns.length) return { ...empty(fileErrors), delimiter: parsed.delimiter, missingColumns, total: parsed.rows.length, truncated };

  const candidates = [];
  const results = [];
  for (const r of parsed.rows.slice(0, MAX_IMPORT_ROWS)) {
    if (!unified) { candidates.push({ line: r.line, entity: key, values: r.values }); continue; }
    const entity = resolveEntityKey(r.values[UNIFIED_COLUMN]);
    if (!entity) {
      results.push({ line: r.line, entity: null, ok: false, action: 'error', errors: { [UNIFIED_COLUMN]: `Entidade desconhecida: "${r.values[UNIFIED_COLUMN]}".` }, warnings: [], raw: {}, values: r.values });
      continue;
    }
    const names = new Set(IMPORT_ENTITIES[entity].columns.map((c) => c.name));
    candidates.push({ line: r.line, entity, values: Object.fromEntries(Object.entries(r.values).filter(([n]) => names.has(n))) });
  }

  // Contexto virtual: base existente + o que este arquivo vai criar (para referências entre entidades do arquivo).
  const ctx = { accounts: [...(data.accounts ?? [])], categories: [...(data.categories ?? [])], cards: [...(data.cards ?? [])], debtors: [...(data.debtors ?? [])] };
  let planned = 0;
  for (const entity of IMPORT_ORDER) {
    const index = existingIndex(entity, data.records);
    const seen = new Set();
    for (const c of candidates.filter((x) => x.entity === entity)) {
      const mapped = mapImportRow(entity, c.values, ctx);
      if (!mapped.ok) { results.push({ line: c.line, entity, ok: false, action: 'error', errors: mapped.errors, warnings: mapped.warnings, raw: mapped.raw, values: c.values }); continue; }
      const verdict = classify(entity, mapped, c.values, index, seen);
      if (verdict.action === 'create') { planned += 1; addPlanned(ctx, entity, mapped.raw, planned); }
      results.push({ line: c.line, entity, ok: true, action: verdict.action, errors: {}, warnings: mapped.warnings, raw: mapped.raw, values: c.values, key: verdict.key, existingId: verdict.existing?.id ?? null, changed: verdict.changed ?? [], reason: verdict.reason });
    }
  }
  const rows = results.sort((a, b) => a.line - b.line);
  const counts = { create: 0, merge: 0, duplicate: 0, error: 0 };
  for (const r of rows) counts[r.action] += 1;
  const valid = rows.filter((r) => r.ok).length;
  return {
    key, delimiter: parsed.delimiter, fileErrors, missingColumns, rows, truncated, counts,
    total: parsed.rows.length, valid, invalid: rows.length - valid, warnings: rows.reduce((t, r) => t + r.warnings.length, 0),
  };
}

const describeFailure = (error) => {
  const code = String(error?.code ?? '');
  return { message: code ? `${code}: ${error?.message ?? ''}`.trim() : (error?.message ?? String(error)), permissionDenied: code.includes('permission-denied') };
};

/**
 * Efetiva o plano do dry-run, ENTIDADE A ENTIDADE na ordem de dependência. Antes de cada entidade relê a base do
 * `uid` (referências criadas no grupo anterior passam a existir) e reclassifica cada linha — assim reimportar nunca
 * duplica. Relatório por linha via `onLog`: { line, entity, action: created|merged|ignored|failed, id?, message?,
 * permissionDenied? }. Retorna { created, merged, ignored, failed, permissionDenied, entries }.
 */
export async function applyImport(uid, plan, { onLog, io = {} } = {}) {
  const creators = io.creators ?? CREATORS;
  const updaters = io.updaters ?? UPDATERS;
  const entries = [];
  const push = (entry) => { entries.push(entry); onLog?.(entry); };
  const todo = plan.rows.filter((r) => r.ok && r.entity);
  let data = null;
  let dirty = true;
  for (const entity of IMPORT_ORDER) {
    const rows = todo.filter((r) => r.entity === entity);
    if (!rows.length) continue;
    if (!creators[entity]) throw new Error('Entidade desconhecida.');
    if (dirty || !data) {
      data = await (io.loadData ?? loadImportData)(uid, io);
      dirty = false;
    }
    if (Object.keys(data.errors ?? {}).length) {
      for (const row of rows) push({ line: row.line, entity, action: 'failed', message: `Leitura da base falhou (${Object.keys(data.errors).join(', ')}); linha não gravada para evitar duplicidade.` });
      continue;
    }
    const index = existingIndex(entity, data.records);
    const seen = new Set();
    for (const row of rows) {
      const mapped = mapImportRow(entity, row.values, data);
      if (!mapped.ok) {
        push({ line: row.line, entity, action: 'failed', message: Object.values(mapped.errors).join(' · ') });
        continue;
      }
      const verdict = classify(entity, mapped, row.values, index, seen);
      if (verdict.action === 'duplicate') { push({ line: row.line, entity, action: 'ignored', message: verdict.reason }); continue; }
      try {
        let r;
        if (verdict.action === 'merge') r = await updaters[entity](uid, verdict.existing.id, buildMergeRaw(entity, verdict.existing, mapped.raw, verdict.changed));
        else r = await creators[entity](uid, mapped.raw);
        if (r?.ok === false) {
          push({ line: row.line, entity, action: 'failed', message: Object.values(r.errors ?? {}).join(' · ') || 'Rejeitada pelo service.' });
        } else {
          dirty = true;
          push({ line: row.line, entity, action: verdict.action === 'merge' ? 'merged' : 'created', id: r?.id ?? r?.ids?.[0] ?? verdict.existing?.id ?? null, changed: verdict.changed });
        }
      } catch (error) {
        const f = describeFailure(error);
        push({ line: row.line, entity, action: 'failed', message: f.message, permissionDenied: f.permissionDenied });
      }
    }
  }
  const count = (a) => entries.filter((e) => e.action === a).length;
  return {
    created: count('created'), merged: count('merged'), ignored: count('ignored'), failed: count('failed'),
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

/** Linhas (alinhadas às colunas da entidade) de registros do uid; referências por nome, dinheiro em reais. */
function exportRowsFor(key, docs, ctx) {
  return rowsFromRecords(key, groupRows(key, docs), ctx);
}

/** Linhas de registros JÁ no formato de importação (dívidas/compras agrupadas) — sem reagrupar. */
function rowsFromRecords(key, records, ctx) {
  const def = IMPORT_ENTITIES[key];
  return records.map((doc) => def.columns.map((c) => {
    const value = doc[c.field];
    if (value === undefined || value === null) return '';
    if (c.type === 'money') return centsToMoneyString(Number(value));
    const refType = REF_COLLECTION[c.type];
    if (refType) return refLabel((ctx[refType] ?? []).find((i) => i.id === value) ?? { name: value });
    return value;
  }));
}

/** CSV da base atual DO uid (mesmas colunas do modelo, referências por nome). Retorna { filename, text, rowCount }. */
export async function exportCsv(uid, key, { delimiter = ';', io = {}, ctx: sharedCtx = null } = {}) {
  const def = IMPORT_ENTITIES[key];
  if (!def) throw new Error('Entidade desconhecida.');
  const fetchList = io.list ?? list;
  const [docs, ctx] = await Promise.all([fetchList(uid, EXPORT_COLLECTION[key], {}), sharedCtx ?? loadImportContext(uid, io)]);
  const rows = exportRowsFor(key, docs, ctx);
  return { filename: `vault-${key}.csv`, text: toCsv(def.columns.map((c) => c.name), rows, { delimiter }), rowCount: rows.length };
}

/**
 * CSV UNIFICADO da base DO uid (VF-2-03ac): 1 arquivo, coluna `entidade` + união das colunas; uma linha por registro,
 * na ordem de dependência (reimportável). Leitura isolada por entidade: falha de uma (ex.: `permission-denied`) não
 * derruba as outras. `onLog({ key, label, ok, rowCount?, error? })`. Retorna { filename, text, results, exported,
 * failed, totalRows }.
 */
export async function exportUnifiedCsv(uid, { delimiter = ';', onLog, io = {}, now = new Date() } = {}) {
  const ctx = await loadImportData(uid, io);
  const headers = unifiedHeaders();
  const lines = [];
  const results = [];
  for (const key of IMPORT_ORDER) {
    const label = IMPORT_ENTITIES[key].label;
    const readError = ctx.errors?.[EXPORT_COLLECTION[key]];
    try {
      if (readError) throw new Error(readError);
      const docs = ctx.records[key];
      const rows = rowsFromRecords(key, docs, ctx); // `records` já vem agrupado (dívidas/compras)
      for (const row of rows) {
        const byName = Object.fromEntries(IMPORT_ENTITIES[key].columns.map((c, i) => [c.name, row[i]]));
        lines.push(headers.map((h) => (h === UNIFIED_COLUMN ? key : (byName[h] ?? ''))));
      }
      results.push({ key, label, ok: true, rowCount: rows.length });
    } catch (error) {
      results.push({ key, label, ok: false, error: String(error?.message ?? error), permissionDenied: /permission-denied/.test(String(error?.message ?? error)) });
    }
    onLog?.(results.at(-1));
  }
  const exported = results.filter((r) => r.ok).length;
  return {
    filename: `vault-todas-entidades-${now.toISOString().slice(0, 10)}.csv`,
    text: toCsv(headers, lines, { delimiter }),
    results, exported, failed: results.length - exported, totalRows: lines.length,
  };
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
