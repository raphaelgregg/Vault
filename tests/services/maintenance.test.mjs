/**
 * VF-2-03u — CSV, esquema de importação (dry-run), importer, exportação, limpeza em lotes e trava de acesso.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, toCsv, csvField, detectDelimiter, normalizeMoneyText, normalizeDateText, normalizeName } from '../../js/utils/csv.js';
import { mapImportRow, resolveRef, IMPORT_ENTITIES, IMPORT_ENTITY_KEYS, MAX_IMPORT_ROWS, templateRows } from '../../js/core/importSchema.js';
import { dryRunImport, applyImport, templateCsv, exportCsv, loadImportContext } from '../../js/services/importer.js';
import { clearCollection, clearUserData, clearWholeDatabase, DOMAIN_COLLECTIONS, BATCH_LIMIT } from '../../js/services/maintenance.js';
import { isMaintenanceAuthorized, CONFIRM_PHRASES } from '../../js/utils/maintenance-config.js';

const uid = 'u1';

describe('csv puro', () => {
  it('detecta delimitador, lê aspas/CRLF/BOM e reporta linhas com colunas erradas', () => {
    assert.equal(detectDelimiter('a;b;c'), ';');
    assert.equal(detectDelimiter('a,b,c'), ',');
    assert.equal(detectDelimiter('"a,b";c'), ';');
    const r = parseCsv('﻿nome;valor\r\n"A; ""x""";1.234,56\r\n\r\nB;2\r\nC\r\n');
    assert.deepEqual(r.headers, ['nome', 'valor']);
    assert.deepEqual(r.rows.map((x) => [x.line, x.values.nome, x.values.valor]), [[2, 'A; "x"', '1.234,56'], [4, 'B', '2']]);
    assert.deepEqual(r.errors, [{ line: 5, message: 'Esperadas 2 colunas, encontradas 1.' }]);
    assert.equal(parseCsv('a,b\n1,2').delimiter, ',');
    assert.ok(parseCsv('').errors.length);
    assert.match(parseCsv('a;b\n"x;1').errors[0].message, /Aspas/);
  });
  it('exporta com aspas, CRLF, BOM e proteção contra injeção de fórmula; ida e volta preserva os valores', () => {
    assert.equal(csvField('=1+1'), "'=1+1");
    assert.equal(csvField('a;b'), '"a;b"');
    assert.equal(csvField('diz "oi"'), '"diz ""oi"""');
    const text = toCsv(['a', 'b'], [['x;y', 'ok'], ['linha\nnova', '']]);
    assert.ok(text.startsWith('﻿'));
    assert.deepEqual(parseCsv(text).rows.map((r) => [r.values.a, r.values.b]), [['x;y', 'ok'], ['linha\nnova', '']]);
  });
  it('dinheiro e data com exatidão: formatos aceitos/rejeitados', () => {
    const ok = { '1234': '1234', '1234,5': '1234,5', '1234,56': '1234,56', '1.234,56': '1234,56', '1.234': '1234', '1234.56': '1234,56', 'R$ 10,00': '10,00', '0,05': '0,05' };
    for (const [input, out] of Object.entries(ok)) assert.equal(normalizeMoneyText(input), out, input);
    for (const bad of ['-5,00', '1,234.56', '12,345', 'abc', '', '1.2.3']) assert.equal(normalizeMoneyText(bad), null, bad);
    assert.equal(normalizeDateText('2026-02-28'), '2026-02-28');
    for (const bad of ['2026-02-30', '28/02/2026', '2026-13-01', '']) assert.equal(normalizeDateText(bad), null, bad);
    assert.equal(normalizeName('  Ação  Média '), 'acao media');
  });
});

describe('esquema de importação (dry-run puro)', () => {
  const ctx = {
    accounts: [{ id: 'a1', institution: 'Nubank', name: 'Corrente' }, { id: 'a2', institution: 'Inter', name: 'Corrente' }, { id: 'a3', institution: 'Banco', name: 'Caixinha' }],
    categories: [{ id: 'c1', name: 'Mercado' }], cards: [{ id: 'k1', name: 'Nubank' }], debtors: [{ id: 'd1', name: 'Maria' }],
  };
  it('toda entidade tem template com todas as colunas e exemplo válido na estrutura', () => {
    for (const key of IMPORT_ENTITY_KEYS) {
      const { headers, rows } = templateRows(key);
      assert.equal(headers.length, IMPORT_ENTITIES[key].columns.length);
      assert.equal(rows[0].length, headers.length);
      assert.equal(new Set(headers).size, headers.length, `${key}: colunas únicas`);
    }
  });
  it('resolve referências por nome (sem acento/caixa), "Instituição — Nome" ou id; ambíguo e inexistente são erros', () => {
    assert.deepEqual(resolveRef('categories', 'mercado', ctx), { id: 'c1' });
    assert.deepEqual(resolveRef('accounts', 'nubank — corrente', ctx), { id: 'a1' });
    assert.deepEqual(resolveRef('accounts', 'a3', ctx), { id: 'a3' });
    assert.match(resolveRef('accounts', 'Corrente', ctx).error, /ambíguo/);
    assert.match(resolveRef('accounts', 'Zzz', ctx).error, /não encontrado/);
  });
  it('despesa válida vira centavos exatos; erros apontam a COLUNA; coluna extra vira aviso', () => {
    const ok = mapImportRow('despesas', { descricao: 'X', categoria: 'Mercado', valor: '1.234,56', data_compra: '2026-12-01', vencimento: '2026-12-01', conta: 'Inter — Corrente' }, ctx);
    assert.equal(ok.ok, true);
    assert.deepEqual([ok.raw.amountCents, ok.raw.accountId, ok.raw.categoryId, ok.raw.status, ok.raw.recurrence], ['1234,56', 'a2', 'c1', 'pending', 'none']);
    const bad = mapImportRow('despesas', { descricao: '', categoria: 'zz', valor: '-1', data_compra: '2026-02-30', vencimento: '2026-12-01', conta: 'Corrente', foo: 'x' }, ctx);
    assert.equal(bad.ok, false);
    assert.deepEqual(Object.keys(bad.errors).sort(), ['categoria', 'conta', 'data_compra', 'descricao', 'valor']);
    assert.match(bad.warnings[0], /foo/);
  });
  it('validação do modelo: enum inválido, devedor com valor 0, dívida (parcelas), compra de cartão e aviso de duplicado', () => {
    assert.match(mapImportRow('contas', { instituicao: 'X', nome: 'Y', tipo: 'poupanca', saldo_inicial: '0' }, ctx).errors.tipo, /inválido/i);
    assert.equal(mapImportRow('devedores', { nome: 'Zé', data: '2026-12-01' }, ctx).ok, true); // valor emprestado 0
    assert.ok(mapImportRow('dividas', { devedor: 'Maria', descricao: 'Moto', total: '600', parcelas: '121', primeiro_vencimento: '2026-12-10' }, ctx).errors.parcelas);
    assert.equal(mapImportRow('compras_cartao', { cartao: 'Nubank', descricao: 'TV', valor_total: '900', parcelas: '3', data_compra: '2026-12-01', devedor: 'Maria' }, ctx).raw.debtorId, 'd1');
    assert.ok(mapImportRow('compras_cartao', { cartao: 'Nubank', descricao: 'TV', valor_total: '900', parcelas: '49', data_compra: '2026-12-01' }, ctx).errors.parcelas);
    const dup = mapImportRow('cartoes', { nome: 'nubank', bandeira: 'M', limite: '1000', dia_fechamento: '10', dia_vencimento: '17' }, ctx);
    assert.equal(dup.ok, true);
    assert.match(dup.warnings[0], /Já existe/);
  });
});

describe('importer (2 etapas)', () => {
  const ctx = { accounts: [{ id: 'a1', institution: 'N', name: 'Corrente' }], categories: [{ id: 'c1', name: 'Mercado' }], cards: [], debtors: [] };
  const csv = ['descricao;categoria;valor;data_compra;vencimento;conta', 'Ok 1;Mercado;10,00;2026-12-01;2026-12-01;Corrente', 'Ruim;Nada;10,00;2026-12-01;2026-12-01;Corrente', 'Ok 2;Mercado;1.000,01;2026-12-02;2026-12-02;Corrente'].join('\n');

  it('dry-run NÃO grava e resume válidas/erros; colunas obrigatórias ausentes bloqueiam; limite de linhas', () => {
    const plan = dryRunImport('despesas', csv, ctx);
    assert.deepEqual([plan.total, plan.valid, plan.invalid], [3, 2, 1]);
    assert.equal(plan.rows[1].ok, false);
    const missing = dryRunImport('despesas', 'descricao;valor\nx;1', ctx);
    assert.deepEqual(missing.missingColumns.sort(), ['categoria', 'conta', 'data_compra', 'vencimento']);
    assert.equal(missing.rows.length, 0);
    const many = ['nome;tipo', ...Array.from({ length: MAX_IMPORT_ROWS + 5 }, (_, i) => `C${i};expense`)].join('\n');
    const big = dryRunImport('categorias', many, ctx);
    assert.equal(big.truncated, true);
    assert.equal(big.rows.length, MAX_IMPORT_ROWS);
  });
  it('efetivação grava só as válidas, registra falha e permission-denied por linha, e continua', async () => {
    const plan = dryRunImport('despesas', csv, ctx);
    const calls = [];
    const logs = [];
    const res = await applyImport(uid, plan, {
      onLog: (e) => logs.push(e),
      io: {
        creators: {
          despesas: async (u, raw) => {
            calls.push(raw);
            if (raw.description === 'Ok 2') throw Object.assign(new Error('Missing or insufficient permissions.'), { code: 'permission-denied' });
            return { ok: true, id: `id${calls.length}` };
          },
        },
      },
    });
    assert.equal(calls.length, 2); // a linha inválida nunca é enviada
    assert.deepEqual(calls.map((c) => c.amountCents), ['10,00', '1000,01']);
    assert.deepEqual([res.created, res.failed, res.permissionDenied], [1, 1, 1]);
    assert.match(logs[1].message, /permission-denied/);
    const rejected = await applyImport(uid, plan, { io: { creators: { despesas: async () => ({ ok: false, errors: { _form: 'regra' } }) } } });
    assert.equal(rejected.failed, 2);
  });
  it('modelo CSV e exportação (referências por nome, centavos → reais) fazem ida e volta no dry-run', async () => {
    const tpl = templateCsv('despesas');
    assert.equal(parseCsv(tpl).headers.length, IMPORT_ENTITIES.despesas.columns.length);
    assert.ok(templateCsv('contas', { delimiter: ',' }).includes('instituicao,nome,tipo'));
    const tables = {
      accounts: [{ id: 'a1', institution: 'Nubank', name: 'Corrente' }], categories: [{ id: 'c1', name: 'Mercado' }], creditCards: [{ id: 'k1', name: 'Nubank' }], debtors: [{ id: 'd1', name: 'Maria' }],
      expenses: [{ id: 'e1', description: 'Feira; "especial"', categoryId: 'c1', amountCents: 123456, accountId: 'a1', purchaseDate: '2026-12-01', dueDate: '2026-12-01', status: 'paid', recurrence: 'none', paidDate: '2026-12-01' }],
      debts: [{ id: 'x1', debtorId: 'd1', description: 'Moto', principalCents: 20000, installmentNumber: 1, installmentsTotal: 3, debtGroupId: 'g', dueDate: '2026-12-10', status: 'pending' }, { id: 'x2', debtorId: 'd1', description: 'Moto', principalCents: 20000, installmentNumber: 2, installmentsTotal: 3, debtGroupId: 'g', dueDate: '2027-01-10', status: 'pending' }, { id: 'x3', debtorId: 'd1', description: 'Moto', principalCents: 20001, installmentNumber: 3, installmentsTotal: 3, debtGroupId: 'g', dueDate: '2027-02-10', status: 'pending' }],
    };
    const io = { list: async (u, c) => tables[c] ?? [] };
    const exp = await exportCsv(uid, 'despesas', { io });
    assert.equal(exp.rowCount, 1);
    const reCtx = await loadImportContext(uid, io);
    const back = dryRunImport('despesas', exp.text, reCtx);
    assert.equal(back.valid, 1, JSON.stringify(back.rows[0]?.errors));
    assert.deepEqual([back.rows[0].raw.amountCents, back.rows[0].raw.description, back.rows[0].raw.accountId], ['1234,56', 'Feira; "especial"', 'a1']);
    const debts = await exportCsv(uid, 'dividas', { io });
    const row = parseCsv(debts.text).rows[0].values;
    assert.deepEqual([row.devedor, row.total, row.parcelas, row.primeiro_vencimento], ['Maria', '600,01', '3', '2026-12-10']);
    assert.equal(dryRunImport('dividas', debts.text, reCtx).valid, 1);
  });
});

describe('limpeza em lotes (≤ 500) e banco inteiro', () => {
  const makeIo = ({ perCollection = {}, failOn = {} } = {}) => {
    const store = Object.fromEntries(Object.entries(perCollection).map(([c, n]) => [c, Array.from({ length: n }, (_, i) => ({ id: `${c}${i}` }))]));
    const batches = [];
    return {
      batches,
      io: {
        list: async (u, c, opts) => {
          if (failOn[c]?.read) throw Object.assign(new Error('x'), { code: 'permission-denied' });
          return (store[c] ?? []).slice(0, opts.limit);
        },
        userDoc: (u, c, id) => ({ c, id }),
        newBatch: () => {
          const ops = [];
          return {
            delete: (ref) => ops.push(ref),
            commit: async () => {
              const c = ops[0].c;
              if (failOn[c]?.write) throw Object.assign(new Error('Missing or insufficient permissions.'), { code: 'permission-denied' });
              batches.push({ c, size: ops.length });
              store[c] = store[c].filter((d) => !ops.some((o) => o.id === d.id));
            },
          };
        },
        writeAudit: async () => ({ ok: true }),
      },
    };
  };
  it('1.234 docs → 3 lotes (500/500/234); nenhum lote passa de 500', async () => {
    const { io, batches } = makeIo({ perCollection: { expenses: 1234 } });
    const r = await clearCollection(uid, 'expenses', io);
    assert.deepEqual([r.deleted, r.batches, r.error], [1234, 3, null]);
    assert.deepEqual(batches.map((b) => b.size), [500, 500, 234]);
    assert.ok(batches.every((b) => b.size <= BATCH_LIMIT));
  });
  it('limpa todas as coleções de domínio + auditLog; auditLog negado é destacado e as demais seguem', async () => {
    const { io } = makeIo({ perCollection: { accounts: 3, expenses: 2, auditLog: 4 }, failOn: { auditLog: { write: true } } });
    const logs = [];
    const res = await clearUserData(uid, { io, onLog: (r) => logs.push(r) });
    assert.equal(logs.length, DOMAIN_COLLECTIONS.length + 1);
    assert.equal(logs.at(-1).collection, 'auditLog');
    assert.equal(logs.at(-1).permissionDenied, true);
    assert.equal(res.deleted, 5);
    assert.deepEqual([res.failures, res.permissionDenied], [1, 1]);
    assert.ok(DOMAIN_COLLECTIONS.every((c) => !['profile', 'settings', 'auditLog'].includes(c)));
  });
  it('banco inteiro: limpa o uid atual, TENTA uids extras (permission-denied destacado) e grava auditoria-resumo', async () => {
    const audits = [];
    const { io } = makeIo({ perCollection: { goals: 2 } });
    const base = io.list;
    io.list = async (u, c, o) => { if (u === 'outro') throw Object.assign(new Error('Missing or insufficient permissions.'), { code: 'permission-denied' }); return base(u, c, o); };
    io.writeAudit = async (u, e) => { audits.push(e); };
    const logs = [];
    const res = await clearWholeDatabase(uid, { extraUids: ['outro', 'outro', uid, ' '], io, onLog: (r) => logs.push(r) });
    const foreign = logs.filter((l) => l.uid === 'outro');
    assert.equal(foreign.length, 1);
    assert.equal(foreign[0].permissionDenied, true);
    assert.equal(res.runs.length, 2);
    assert.equal(res.deleted, 2);
    assert.equal(audits[0].action, 'maintenance_clear_all');
  });
});

describe('trava de acesso e confirmações', () => {
  it('libera localhost/emulador e e-mails da lista; nega o resto (lista vazia por padrão)', () => {
    assert.equal(isMaintenanceAuthorized({ hostname: 'localhost' }), true);
    assert.equal(isMaintenanceAuthorized({ hostname: '127.0.0.1', email: 'x@y.z' }), true);
    assert.equal(isMaintenanceAuthorized({ hostname: 'vault.vercel.app', email: 'a@b.c' }), false);
    assert.equal(isMaintenanceAuthorized({ hostname: 'vault.vercel.app', email: ' A@B.C ' }, ['a@b.c']), true);
    assert.equal(isMaintenanceAuthorized({ hostname: 'vault.vercel.app' }, ['']), false);
    assert.deepEqual(Object.keys(CONFIRM_PHRASES).sort(), ['database', 'reset', 'user']);
    assert.equal(CONFIRM_PHRASES.database, 'LIMPAR BANCO INTEIRO');
  });
});
