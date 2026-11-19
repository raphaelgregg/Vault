/**
 * Receitas ↔ Contas: instituição e conta são conceitos independentes. O modelo grava só `accountId` (ID da conta);
 * no CSV, `conta` = nome da conta e `instituicao` a qualifica (nunca "Instituição — Nome" na exportação).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildEntity } from '../../js/core/model.js';
import { createAccount } from '../../js/services/accounts.js';
import { createIncome } from '../../js/services/incomes.js';
import { mapImportRow, resolveRef, templateRows, IMPORT_ENTITIES } from '../../js/core/importSchema.js';
import { parseCsv } from '../../js/utils/csv.js';
import { dryRunImport, applyImport, loadImportData, exportCsv, exportUnifiedCsv, unifiedTemplateCsv } from '../../js/services/importer.js';

const UID = 'u1';
const accounts = [
  { id: 'a1', institution: 'Nubank', name: 'Corrente', type: 'checking', initialBalanceCents: 0, status: 'active', color: '#000' },
  { id: 'a2', institution: 'Itaú', name: 'Corrente', type: 'checking', initialBalanceCents: 0, status: 'active', color: '#000' },
  { id: 'a3', institution: 'Inter', name: 'Poupança', type: 'savings', initialBalanceCents: 0, status: 'active', color: '#000' },
];
const categories = [{ id: 'c1', name: 'Salário', kind: 'income' }];
const ctx = { accounts, categories, cards: [], debtors: [] };
const income = (over = {}) => ({ descricao: 'Salário', categoria: 'Salário', valor: '100,00', data_prevista: '2026-12-05', conta: 'Corrente', instituicao: 'Nubank', ...over });
const csvOf = (header, rows) => [header.join(';'), ...rows.map((r) => header.map((h) => r[h] ?? '').join(';'))].join('\n');
const H = IMPORT_ENTITIES.receitas.columns.map((c) => c.name);

/** Base em memória mínima para exportar/reimportar receitas. */
const makeIo = (incomes = []) => {
  const tables = { accounts: structuredClone(accounts), categories: structuredClone(categories), incomes, creditCards: [], debtors: [], expenses: [], transfers: [], subscriptions: [], goals: [], debts: [], cardPurchases: [] };
  return { tables, io: { list: async (_uid, c) => structuredClone(tables[c] ?? []) } };
};

describe('modelo: instituição e conta independentes', () => {
  it('1) conta guarda institution e name em campos separados; sem campo composto', () => {
    const { ok, data } = buildEntity('accounts', { institution: 'Nubank', name: 'Corrente', type: 'checking', initialBalanceCents: '0,00', color: '#000', status: 'active' });
    assert.ok(ok);
    assert.equal(data.institution, 'Nubank');
    assert.equal(data.name, 'Corrente');
    assert.deepEqual(Object.keys(data).sort(), ['color', 'initialBalanceCents', 'institution', 'name', 'status', 'type']);
  });

  it('1b) createAccount persiste institution e name como campos independentes', async () => {
    let saved;
    const r = await createAccount(UID, { institution: 'Itaú', name: 'Corrente', type: 'checking', initialBalanceCents: '10,00', color: '#000', status: 'active' }, { create: async (_u, _c, d) => { saved = d; return 'x'; }, writeAudit: async () => {} });
    assert.deepEqual([r.ok, r.id], [true, 'x']);
    assert.deepEqual([saved.institution, saved.name], ['Itaú', 'Corrente']);
  });

  it('2) receita referencia a conta só por accountId (ID), sem instituição/nome da conta', () => {
    const { ok, data } = buildEntity('incomes', { description: 'S', categoryId: 'c1', amountCents: '1,00', expectedDate: '2026-12-05', accountId: 'a1', status: 'pending', recurrence: 'none' });
    assert.ok(ok);
    assert.equal(data.accountId, 'a1');
    assert.equal('institution' in data || 'conta' in data || 'accountName' in data, false);
  });

  it('2b) createIncome aceita o vínculo e exige conta', async () => {
    const miss = await createIncome(UID, { description: 'S', categoryId: 'c1', amountCents: '1,00', expectedDate: '2026-12-05', status: 'pending', recurrence: 'none' }, { lookupCategory: async () => categories[0] });
    assert.equal(miss.ok, false);
    assert.ok(miss.errors.accountId);
  });

  it('3) recuperação: instituição e nome vêm da conta (fonte de verdade), via accountId', () => {
    const inc = { accountId: 'a2' };
    const acc = accounts.find((a) => a.id === inc.accountId);
    assert.deepEqual([acc.institution, acc.name], ['Itaú', 'Corrente']);
  });
});

describe('importação de receitas: resolução de conta', () => {
  it('4) conta + instituição válidas → accountId da conta correta', () => {
    const r = mapImportRow('receitas', income(), ctx);
    assert.equal(r.ok, true);
    assert.equal(r.raw.accountId, 'a1');
    assert.equal(mapImportRow('receitas', income({ instituicao: 'itau' }), ctx).raw.accountId, 'a2'); // caixa/acento são normalizados
    assert.equal(mapImportRow('receitas', income({ instituicao: 'ITAÚ' }), ctx).raw.accountId, 'a2');
  });

  it('5) referências inexistentes são rejeitadas com mensagem clara (coluna `conta`)', () => {
    const noAcc = mapImportRow('receitas', income({ conta: 'Zzz' }), ctx);
    assert.equal(noAcc.ok, false);
    assert.match(noAcc.errors.conta, /não encontrada/);
    const wrongInst = mapImportRow('receitas', income({ conta: 'Poupança', instituicao: 'Nubank' }), ctx);
    assert.equal(wrongInst.ok, false);
    assert.match(wrongInst.errors.conta, /não encontrada na instituição "Nubank".*Inter/);
    assert.match(mapImportRow('receitas', income({ instituicao: 'Banco X' }), ctx).errors.conta, /não encontrada na instituição "Banco X"/);
    assert.match(mapImportRow('receitas', income({ conta: '' }), ctx).errors.conta, /obrigatório/);
  });

  it('6) mesmo nome em instituições diferentes: sem instituição é ambíguo; com instituição resolve cada uma', () => {
    const amb = mapImportRow('receitas', income({ instituicao: '' }), ctx);
    assert.equal(amb.ok, false);
    assert.match(amb.errors.conta, /ambíguo.*Nubank, Itaú.*instituicao/);
    assert.equal(mapImportRow('receitas', income({ instituicao: 'Nubank' }), ctx).raw.accountId, 'a1');
    assert.equal(mapImportRow('receitas', income({ instituicao: 'Itaú' }), ctx).raw.accountId, 'a2');
    // nome único dispensa a instituição
    assert.equal(mapImportRow('receitas', income({ conta: 'Poupança', instituicao: '' }), ctx).raw.accountId, 'a3');
  });

  it('id explícito funciona; id com instituição divergente é rejeitado', () => {
    assert.deepEqual(resolveRef('accounts', 'a2', ctx), { id: 'a2' });
    assert.deepEqual(resolveRef('accounts', 'a2', ctx, 'Itaú'), { id: 'a2' });
    assert.match(resolveRef('accounts', 'a2', ctx, 'Nubank').error, /pertence à instituição "Itaú"/);
  });

  it('8) compatibilidade: rótulo antigo "Instituição — Nome" ainda resolve, só se for inequívoco', () => {
    assert.deepEqual(resolveRef('accounts', 'Itaú — Corrente', ctx), { id: 'a2' });
    assert.deepEqual(resolveRef('accounts', 'nubank - corrente', ctx), { id: 'a1' });
    assert.match(resolveRef('accounts', 'Inter — Corrente', ctx).error, /não encontrado/);
  });

  it('instituicao sem conta (conta opcional) gera aviso, não erro', () => {
    const r = mapImportRow('metas', { nome: 'M', objetivo: '10,00', conta: '', instituicao: 'Nubank' }, ctx);
    assert.equal(r.ok, true);
    assert.match(r.warnings.join(' '), /instituicao.*sem "conta"/);
  });

  it('instituicao não vira campo do modelo nem aviso de coluna desconhecida', () => {
    const r = mapImportRow('receitas', income(), ctx);
    assert.equal(Object.keys(r.raw).some((k) => /instit/i.test(k)), false);
    assert.equal(r.warnings.length, 0);
  });

  it('transferência: instituição de origem e destino independentes', () => {
    const r = mapImportRow('transferencias', { origem: 'Corrente', instituicao_origem: 'Itaú', destino: 'Corrente', instituicao_destino: 'Nubank', valor: '1,00', data: '2026-12-02', motivo: 'x', status: 'pending' }, ctx);
    assert.equal(r.ok, true);
    assert.deepEqual([r.raw.fromAccountId, r.raw.toAccountId], ['a2', 'a1']);
  });

  it('contas homônimas em outra instituição geram aviso informativo; mesma instituição+nome não', () => {
    const base = { tipo: 'checking', saldo_inicial: '0,00' };
    assert.match(mapImportRow('contas', { instituicao: 'Bradesco', nome: 'Corrente', ...base }, ctx).warnings[0], /outra instituição/);
    assert.equal(mapImportRow('contas', { instituicao: 'Nubank', nome: 'Reserva', ...base }, ctx).warnings.length, 0);
    assert.equal(mapImportRow('contas', { instituicao: 'Inter', nome: 'Poupança', ...base }, ctx).warnings.length, 0);
  });
});

describe('importação em lote: validação, duplicidade e integridade', () => {
  const dry = (rows) => dryRunImport('receitas', csvOf(H, rows), { ...ctx, records: { receitas: [] }, errors: {} });

  it('linhas válidas e inválidas: inválidas não gravam e nada existente é alterado', async () => {
    const plan = dry([income(), income({ descricao: 'Ruim', conta: 'Zzz' }), income({ descricao: 'Ambígua', instituicao: '' })]);
    assert.deepEqual([plan.counts.create, plan.counts.error], [1, 2]);
    const created = [];
    const res = await applyImport(UID, plan, { io: { loadData: async () => ({ ...ctx, records: { receitas: [] }, errors: {} }), creators: { receitas: async (_u, raw) => { created.push(raw); return { ok: true, id: 'i1' }; } }, updaters: {} } });
    assert.equal(res.created, 1);
    assert.equal(created.length, 1);
    assert.equal(created[0].accountId, 'a1');
  });

  it('mesma descrição/valor/data em contas homônimas de instituições diferentes NÃO é duplicata; repetição exata é', () => {
    const plan = dry([income({ instituicao: 'Nubank' }), income({ instituicao: 'Itaú' }), income({ instituicao: 'Nubank' })]);
    assert.deepEqual(plan.rows.map((r) => r.action), ['create', 'create', 'duplicate']);
  });

  it('reimportar contra base que já tem a receita é duplicata (idempotente)', () => {
    const existing = [{ id: 'i1', description: 'Salário', categoryId: 'c1', amountCents: 10000, expectedDate: '2026-12-05', accountId: 'a2' }];
    const plan = dryRunImport('receitas', csvOf(H, [income({ instituicao: 'Itaú' }), income({ instituicao: 'Nubank' })]), { ...ctx, records: { receitas: existing }, errors: {} });
    assert.deepEqual(plan.rows.map((r) => r.action), ['duplicate', 'create']);
  });
});

describe('exportação e reimportação', () => {
  const stored = [
    { id: 'i1', description: 'Salário', categoryId: 'c1', amountCents: 500000, expectedDate: '2026-12-05', accountId: 'a2', status: 'pending', recurrence: 'none' },
    { id: 'i2', description: 'Freela', categoryId: 'c1', amountCents: 30000, expectedDate: '2026-12-06', accountId: 'a1', status: 'pending', recurrence: 'none' },
  ];

  it('7) exporta `conta` só com o nome e `instituicao` separada; reimporta sem perder o vínculo', async () => {
    const { io } = makeIo(stored);
    const out = await exportCsv(UID, 'receitas', { io });
    const parsed = parseCsv(out.text);
    assert.deepEqual(parsed.rows.map((r) => [r.values.conta, r.values.instituicao]), [['Corrente', 'Itaú'], ['Corrente', 'Nubank']]);
    assert.equal(out.text.includes('—'), false);

    const data = await loadImportData(UID, io);
    const plan = dryRunImport('receitas', out.text, data);
    assert.equal(plan.counts.error, 0);
    assert.deepEqual(plan.rows.map((r) => r.action), ['duplicate', 'duplicate']); // já existem: nada a criar
    // base vazia de receitas: recria com os MESMOS accountId
    const empty = makeIo([]);
    const plan2 = dryRunImport('receitas', out.text, await loadImportData(UID, empty.io));
    assert.deepEqual(plan2.rows.map((r) => r.raw.accountId), ['a2', 'a1']);
  });

  it('exportação unificada preserva o vínculo (coluna instituicao compartilhada)', async () => {
    const { io } = makeIo(stored);
    const out = await exportUnifiedCsv(UID, { io });
    const rows = parseCsv(out.text).rows.filter((r) => r.values.entidade === 'receitas');
    assert.deepEqual(rows.map((r) => [r.values.conta, r.values.instituicao]), [['Corrente', 'Itaú'], ['Corrente', 'Nubank']]);
    const contas = parseCsv(out.text).rows.filter((r) => r.values.entidade === 'contas');
    assert.deepEqual(contas.map((r) => [r.values.instituicao, r.values.nome]), [['Nubank', 'Corrente'], ['Itaú', 'Corrente'], ['Inter', 'Poupança']]);
  });

  it('conta com instituição+nome repetidos exporta o ID (nunca liga à conta errada) e reimporta por id', async () => {
    const twins = [{ ...accounts[0], id: 'b1' }, { ...accounts[0], id: 'b2' }];
    const { io, tables } = makeIo([{ ...stored[1], accountId: 'b2' }]);
    tables.accounts = twins;
    const out = await exportCsv(UID, 'receitas', { io });
    assert.equal(parseCsv(out.text).rows[0].values.conta, 'b2');
    const plan = dryRunImport('receitas', out.text, await loadImportData(UID, io));
    assert.equal(plan.rows[0].raw.accountId, 'b2');
  });

  it('registro antigo/órfão (conta removida) exporta o id em `conta` e instituicao vazia, sem quebrar', async () => {
    const { io } = makeIo([{ ...stored[0], accountId: 'sumiu' }]);
    const row = parseCsv((await exportCsv(UID, 'receitas', { io })).text).rows[0].values;
    assert.deepEqual([row.conta, row.instituicao], ['sumiu', '']);
  });

  it('modelos de CSV trazem `instituicao` ao lado de `conta`', () => {
    for (const key of ['receitas', 'despesas', 'assinaturas', 'metas', 'cartoes']) {
      const { headers } = templateRows(key);
      assert.equal(headers.indexOf('instituicao'), headers.indexOf('conta') + 1, key);
    }
    const t = templateRows('transferencias').headers;
    assert.deepEqual(t.slice(0, 4), ['origem', 'instituicao_origem', 'destino', 'instituicao_destino']);
    assert.match(unifiedTemplateCsv(), /instituicao/);
  });
});

describe('módulos que usam Contas', () => {
  it('9) despesas, assinaturas, metas, cartões e transferências resolvem conta por nome+instituição', () => {
    const base = { conta: 'Corrente', instituicao: 'Itaú' };
    assert.equal(mapImportRow('despesas', { descricao: 'D', categoria: 'Salário', valor: '1,00', data_compra: '2026-12-01', vencimento: '2026-12-01', ...base }, { ...ctx, categories: [{ id: 'c1', name: 'Salário', kind: 'both' }] }).raw.accountId, 'a2');
    assert.equal(mapImportRow('assinaturas', { nome: 'N', valor: '1,00', periodicidade: 'monthly', proxima_cobranca: '2026-12-10', categoria: 'Salário', ...base }, ctx).raw.accountId, 'a2');
    assert.equal(mapImportRow('metas', { nome: 'M', objetivo: '10,00', ...base }, ctx).raw.accountId, 'a2');
    assert.equal(mapImportRow('cartoes', { nome: 'C', bandeira: 'Visa', limite: '10,00', dia_fechamento: '1', dia_vencimento: '2', ...base }, ctx).raw.accountId, 'a2');
    assert.equal(mapImportRow('despesas', { descricao: 'D', categoria: 'Salário', valor: '1,00', data_compra: '2026-12-01', vencimento: '2026-12-01', conta: 'Corrente' }, ctx).ok, false);
  });
});
