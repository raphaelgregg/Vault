/**
 * VF-2-03u — CSV, esquema de importação (dry-run), importer, exportação, limpeza em lotes e trava de acesso.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, toCsv, csvField, detectDelimiter, normalizeMoneyText, normalizeDateText, normalizeName } from '../../js/utils/csv.js';
import { mapImportRow, resolveRef, IMPORT_ENTITIES, IMPORT_ENTITY_KEYS, MAX_IMPORT_ROWS, templateRows } from '../../js/core/importSchema.js';
import { dryRunImport, applyImport, templateCsv, exportCsv, exportAllCsv, loadImportContext } from '../../js/services/importer.js';
import { makeZip, crc32 } from '../../js/utils/zip.js';
import { clearCollection, clearUserData, clearScope, clearAllUsersData, discoverUsers, isAdminUser, SCOPES, DOMAIN_COLLECTIONS, BATCH_LIMIT } from '../../js/services/maintenance.js';
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
  it('escopo own: limpa só o uid do executor e audita no log dele (adminUid, escopo, totais)', async () => {
    const audits = [];
    const { io } = makeIo({ perCollection: { goals: 2, accounts: 1 } });
    io.writeAudit = async (u, e) => { audits.push([u, e]); return { ok: true }; };
    const res = await clearScope({ scope: SCOPES.OWN, adminUid: 'me', io });
    assert.deepEqual([res.scope, res.adminUid, res.targetUid, res.deleted], ['own', 'me', null, 3]);
    assert.equal(audits[0][0], 'me');
    assert.equal(audits[0][1].action, 'maintenance_clear_own');
    assert.deepEqual([audits[0][1].after.scope, audits[0][1].after.adminUid, audits[0][1].after.deleted], ['own', 'me', 3]);
  });
  it('escopo target_uid: só admin; apaga o uid alvo SEM tentar auditLog; auditoria no log do admin com targetUid', async () => {
    const audits = [];
    const seenUids = [];
    const { io } = makeIo({ perCollection: { expenses: 4 } });
    const base = io.list;
    io.list = async (u, c, o) => { seenUids.push(u); return base(u, c, o); };
    io.writeAudit = async (u, e) => { audits.push([u, e]); return { ok: true }; };
    const refused = await clearScope({ scope: SCOPES.TARGET, adminUid: 'adm', targetUid: 'alvo', admin: false, io });
    assert.equal(refused.ok, false);
    assert.match(refused.error, /claim/);
    assert.equal(seenUids.length, 0); // nada é enviado ao Firestore sem a claim
    assert.equal(audits.length, 0);
    const logs = [];
    const res = await clearScope({ scope: SCOPES.TARGET, adminUid: 'adm', targetUid: ' alvo ', admin: true, io, onLog: (r) => logs.push(r.collection) });
    assert.deepEqual([res.ok, res.scope, res.adminUid, res.targetUid, res.deleted], [true, 'target_uid', 'adm', 'alvo', 4]);
    assert.ok(new Set(seenUids).size === 1 && seenUids[0] === 'alvo');
    assert.equal(logs.includes('auditLog'), false);
    assert.equal(audits[0][0], 'adm'); // o log é do EXECUTOR
    assert.deepEqual([audits[0][1].docId, audits[0][1].after.targetUid, audits[0][1].action], ['alvo', 'alvo', 'maintenance_clear_target_uid']);
    assert.equal((await clearScope({ scope: SCOPES.TARGET, adminUid: 'adm', targetUid: '  ', admin: true, io })).ok, false);
    assert.equal((await clearScope({ scope: 'tudo', adminUid: 'adm', admin: true, io })).ok, false);
  });
  it('escopo all_users: só admin; consulta de grupo em lotes de 500 apagando docs de vários uids; log por uid e por coleção', async () => {
    const store = [
      ...Array.from({ length: 700 }, (_, i) => ({ path: `users/u${i % 3}/expenses/e${i}`, uid: `u${i % 3}` })),
      { path: 'users/u9/accounts/a1', uid: 'u9' },
    ];
    const batches = [];
    const io = {
      listGroup: async (c, max) => store.filter((d) => d.path.includes(`/${c}/`)).slice(0, max),
      docAtPath: (path) => ({ path }),
      newBatch: () => {
        const ops = [];
        return { delete: (r) => ops.push(r.path), commit: async () => { batches.push(ops.length); for (const p of ops) store.splice(store.findIndex((d) => d.path === p), 1); } };
      },
      writeAudit: async () => ({ ok: true }),
    };
    const refused = await clearScope({ scope: SCOPES.ALL, adminUid: 'adm', admin: false, io });
    assert.equal(refused.ok, false);
    assert.equal(batches.length, 0);
    const res = await clearScope({ scope: SCOPES.ALL, adminUid: 'adm', admin: true, io });
    assert.equal(res.ok, true);
    assert.equal(res.deleted, 701);
    assert.deepEqual(batches, [500, 200, 1]);
    assert.deepEqual(res.byUid, { u0: 234, u1: 233, u2: 233, u9: 1 });
    assert.equal(store.length, 0);
  });
  it('permission-denied de uma coleção no escopo global é destacado e as demais seguem; auditoria-resumo registra', async () => {
    const audits = [];
    const io = {
      listGroup: async (c) => { if (c === 'budgets') throw Object.assign(new Error('Missing or insufficient permissions.'), { code: 'permission-denied' }); return []; },
      docAtPath: (p) => ({ path: p }), newBatch: () => ({ delete() {}, commit: async () => {} }),
      writeAudit: async (u, e) => { audits.push(e); return { ok: true }; },
    };
    const logs = [];
    const res = await clearAllUsersData({ io, onLog: (r) => logs.push(r) });
    assert.equal(logs.length, DOMAIN_COLLECTIONS.length);
    assert.deepEqual([res.failures, res.permissionDenied], [1, 1]);
    const out = await clearScope({ scope: SCOPES.ALL, adminUid: 'adm', admin: true, io });
    assert.equal(out.ok, false);
    assert.equal(out.permissionDenied, 1);
    assert.equal(audits.at(-1).after.permissionDenied, 1);
  });
  it('discoverUsers: amostra por consulta de grupo, agrupada por uid; falha por coleção é listada', async () => {
    const io = { listGroup: async (c) => { if (c === 'goals') throw new Error('x'); return c === 'accounts' ? [{ uid: 'a', path: '' }, { uid: 'b', path: '' }, { uid: 'a', path: '' }] : c === 'expenses' ? [{ uid: 'b', path: '' }] : []; } };
    const r = await discoverUsers({ io });
    assert.deepEqual(r.users.map((u) => [u.uid, u.docs]), [['b', 2], ['a', 2]].sort((x, y) => y[1] - x[1] || 0).map((x) => x));
    assert.deepEqual(r.users.find((u) => u.uid === 'b').collections, ['accounts', 'expenses']);
    assert.equal(r.errors[0].collection, 'goals');
    assert.equal(r.sampled, true);
  });
  it('isAdminUser: só claim booleana admin === true (token renovado)', async () => {
    const withClaims = (claims, spy) => ({ getIdTokenResult: async (refresh) => { spy?.push(refresh); return { claims }; } });
    const spy = [];
    assert.equal(await isAdminUser(withClaims({ admin: true }, spy)), true);
    assert.deepEqual(spy, [true]); // força renovar o token para enxergar claim recém-definida
    for (const c of [{}, { admin: 'true' }, { admin: 1 }, { admin: false }]) assert.equal(await isAdminUser(withClaims(c)), false);
    assert.equal(await isAdminUser(null), false);
    const orig = console.error; console.error = () => {};
    assert.equal(await isAdminUser({ getIdTokenResult: async () => { throw new Error('x'); } }), false);
    console.error = orig;
  });
});

describe('trava de acesso e confirmações', () => {
  it('libera localhost/emulador e e-mails da lista; nega o resto (lista vazia por padrão)', () => {
    assert.equal(isMaintenanceAuthorized({ hostname: 'localhost' }), true);
    assert.equal(isMaintenanceAuthorized({ hostname: '127.0.0.1', email: 'x@y.z' }), true);
    assert.equal(isMaintenanceAuthorized({ hostname: 'vault.vercel.app', email: 'a@b.c' }), false);
    assert.equal(isMaintenanceAuthorized({ hostname: 'vault.vercel.app', email: ' A@B.C ' }, ['a@b.c']), true);
    assert.equal(isMaintenanceAuthorized({ hostname: 'vault.vercel.app' }, ['']), false);
    assert.deepEqual(Object.keys(CONFIRM_PHRASES).sort(), ['database', 'reset', 'target', 'user']);
    assert.equal(CONFIRM_PHRASES.database, 'LIMPAR BANCO INTEIRO');
  });
});

describe('modelo vazio × exportação × exportação completa (VF-2-03v)', () => {
  it('modelo CSV é VAZIO (só cabeçalhos); exemplo só sob pedido', () => {
    for (const key of IMPORT_ENTITY_KEYS) {
      const parsed = parseCsv(templateCsv(key));
      assert.equal(parsed.headers.length, IMPORT_ENTITIES[key].columns.length, key);
      assert.equal(parsed.rows.length, 0, `${key}: sem linhas de dados`);
      assert.equal(parseCsv(templateCsv(key, { withExample: true })).rows.length, 1);
    }
  });
  it('zip: assinaturas, CRC-32 conhecido, nomes UTF-8 e rejeita nome repetido', () => {
    assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926); // vetor de teste padrão
    const zip = makeZip([{ name: 'a.csv', data: 'x;y\r\n1;2\r\n' }, { name: 'ação.txt', data: 'olá' }], { now: new Date('2026-11-19T12:00:00Z') });
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    assert.equal(view.getUint32(0, true), 0x04034b50);
    assert.equal(view.getUint32(zip.length - 22, true), 0x06054b50);
    assert.equal(view.getUint16(zip.length - 22 + 10, true), 2); // 2 entradas
    assert.throws(() => makeZip([{ name: 'a', data: '' }, { name: 'a', data: '' }]), /repetido/);
  });
  const tables = {
    accounts: [{ id: 'a1', institution: 'Nubank', name: 'Corrente', type: 'checking', initialBalanceCents: 150000, color: '#1f7a5c', status: 'active' }],
    categories: [{ id: 'c1', name: 'Mercado', kind: 'expense', color: '#c0392b' }],
  };
  it('exporta as 11 entidades num único pacote e resume; entidade sem registros sai só com cabeçalho', async () => {
    const logs = [];
    const res = await exportAllCsv(uid, { io: { list: async (u, c) => tables[c] ?? [] }, onLog: (r) => logs.push(r), now: new Date('2026-11-19T12:00:00Z') });
    assert.equal(logs.length, IMPORT_ENTITY_KEYS.length);
    assert.deepEqual([res.exported, res.failed, res.totalRows], [11, 0, 2]);
    assert.equal(res.filename, 'vault-exportacao-completa-2026-11-19.zip');
    const text = new TextDecoder().decode(res.zip);
    for (const key of IMPORT_ENTITY_KEYS) assert.ok(text.includes(`vault-${key}.csv`), key);
    assert.ok(text.includes('_resumo.txt') && text.includes('Total: 11/11 entidade(s), 2 linha(s).'));
    assert.ok(text.includes('Nubank — Corrente'.length ? 'Corrente' : ''));
  });
  it('falha de leitura de UMA entidade (permission-denied) não derruba as outras e fica no log e no resumo', async () => {
    const logs = [];
    const io = { list: async (u, c) => { if (c === 'expenses') throw Object.assign(new Error('Missing or insufficient permissions.'), { code: 'permission-denied' }); return tables[c] ?? []; } };
    const res = await exportAllCsv(uid, { io, onLog: (r) => logs.push(r) });
    assert.deepEqual([res.exported, res.failed], [10, 1]);
    const bad = logs.find((r) => !r.ok);
    assert.deepEqual([bad.key, bad.permissionDenied], ['despesas', true]);
    const text = new TextDecoder().decode(res.zip);
    assert.ok(!text.includes('vault-despesas.csv'));
    assert.match(text, /FALHA {2}despesas — permission-denied/);
    // tudo falha (ex.: sem permissão): nada a baixar
    const none = await exportAllCsv(uid, { io: { list: async () => { throw Object.assign(new Error('x'), { code: 'permission-denied' }); } } });
    assert.equal(none.exported, 0);
  });
  it('lê as referências UMA vez (contexto compartilhado), não 4 listas por entidade', async () => {
    const calls = [];
    await exportAllCsv(uid, { io: { list: async (u, c) => { calls.push(c); return tables[c] ?? []; } } });
    assert.equal(calls.filter((c) => c === 'accounts').length <= 2, true); // ctx (1) + export de contas (1)
  });
});
