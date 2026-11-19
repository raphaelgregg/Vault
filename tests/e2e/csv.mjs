/**
 * E2E do CSV unificado (VF-2-03ac): modelo e base populada de TODAS as entidades em 1 arquivo, escopo estrito ao uid
 * autenticado (inclusive administrador), importação fora de ordem respeitando dependências e idempotência
 * (reimportar não duplica; mesclagem só de campos preenchidos). Sem `playwright`, sai com aviso (código 0).
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPlaywright, launchApp, registerUser } from './harness.mjs';
import { unifiedHeaders, UNIFIED_COLUMN, IMPORT_ORDER } from '../../js/core/importSchema.js';

const pw = loadPlaywright();
if (!pw) {
  console.warn('[e2e] playwright não encontrado — cenários ignorados.');
  process.exit(0);
}

const app = await launchApp(pw);
const { page } = app;
let step = 'início';
const log = (name) => { step = name; console.info(`  · ${name}`); };
const logText = () => page.locator('#import-log').innerText();
const waitLog = (re) => page.waitForFunction((src) => new RegExp(src).test(document.querySelector('#import-log')?.innerText ?? ''), re.source, { timeout: 120000 });
const summary = () => page.locator('#import-summary').innerText();
const waitSummary = (re) => page.waitForFunction((src) => new RegExp(src).test(document.querySelector('#import-summary')?.innerText ?? ''), re.source, { timeout: 30000 });

const HEADERS = unifiedHeaders();
const line = (entity, v = {}) => HEADERS.map((h) => (h === UNIFIED_COLUMN ? entity : (v[h] ?? ''))).join(';');
const buildCsv = ({ catColor = '#c0392b' } = {}) => [
  HEADERS.join(';'),
  line('compras_cartao', { cartao: 'Nubank', descricao: 'Geladeira', valor_total: '900,00', parcelas: '3', data_compra: '2026-12-01', devedor: 'Maria' }),
  line('dividas', { devedor: 'Maria', descricao: 'Moto', total: '600,00', parcelas: '3', primeiro_vencimento: '2026-12-10' }),
  line('metas', { nome: 'Caixinha', objetivo: '10000,00', prazo: '2027-12-31', conta: 'Corrente' }),
  line('assinaturas', { nome: 'Netflix', valor: '55,90', periodicidade: 'monthly', proxima_cobranca: '2026-12-10', conta: 'Corrente', categoria: 'Assinaturas' }),
  line('transferencias', { origem: 'Corrente', destino: 'Caixinha Conta', valor: '500,00', data: '2026-12-02', motivo: 'Reserva', status: 'pending' }),
  line('despesas', { descricao: 'Supermercado', categoria: 'Mercado', valor: '350,90', data_compra: '2026-12-01', vencimento: '2026-12-01', conta: 'Corrente', recorrencia: 'none' }),
  line('receitas', { descricao: 'Salário', categoria: 'Salário', valor: '5000,00', data_prevista: '2026-12-05', conta: 'Corrente', recorrencia: 'none' }),
  line('devedores', { nome: 'Maria', data: '2026-12-01', valor_emprestado: '0,00' }),
  line('cartoes', { nome: 'Nubank', bandeira: 'Mastercard', limite: '5000,00', dia_fechamento: '10', dia_vencimento: '17' }),
  line('categorias', { nome: 'Mercado', tipo: 'expense', cor: catColor }),
  line('categorias', { nome: 'Salário', tipo: 'income', cor: '#1f8a5b' }),
  line('categorias', { nome: 'Assinaturas', tipo: 'expense', cor: '#e67e22' }),
  line('contas', { instituicao: 'Banco', nome: 'Corrente', tipo: 'checking', saldo_inicial: '1000,00', cor: '#1f7a5c', status: 'active' }),
  line('contas', { instituicao: 'Nubank', nome: 'Caixinha Conta', tipo: 'savings', saldo_inicial: '0,00', cor: '#1f7a5c', status: 'active' }),
].join('\n');

const signOut = () => page.evaluate(async () => { const { auth } = await import('/js/firebase/client.js'); await auth.signOut(); });
const counts = (uid) => page.evaluate(async (u) => {
  const { list } = await import('/js/services/firestore.js');
  const out = {};
  for (const c of ['accounts', 'categories', 'incomes', 'expenses', 'transfers', 'subscriptions', 'debtors', 'debts', 'goals', 'creditCards', 'cardPurchases']) out[c] = (await list(u, c, {})).length;
  return out;
}, uid);

try {
  log('usuário B (outro dono): dados próprios, inclusive nomes IGUAIS aos do arquivo');
  await registerUser(page, app.base);
  await page.waitForSelector('#page-content .panel');
  const uidB = await page.evaluate(async () => {
    const { createAccount } = await import('/js/services/accounts.js');
    const { createCategory } = await import('/js/services/categories.js');
    const { auth } = await import('/js/firebase/client.js');
    const uid = auth.currentUser.uid;
    await createAccount(uid, { institution: 'Banco', name: 'B-Conta-Secreta', type: 'checking', initialBalanceCents: '777,00', color: '#111111', status: 'active' });
    await createAccount(uid, { institution: 'Banco', name: 'Corrente', type: 'checking', initialBalanceCents: '1,00', color: '#111111', status: 'active' }); // mesmo nome do arquivo
    await createCategory(uid, { name: 'Mercado', kind: 'expense', color: '#000001' });
    return uid;
  });

  log('administrador A (claim admin): exporta/importa SÓ o próprio uid');
  await signOut();
  await registerUser(page, app.base);
  await page.waitForSelector('#page-content .panel');
  const uidA = await page.evaluate(async () => { const { auth } = await import('/js/firebase/client.js'); return auth.currentUser.uid; });
  const claim = await fetch('http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/projects/demo-vault-finance/accounts:update', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer owner' }, body: JSON.stringify({ localId: uidA, customAttributes: JSON.stringify({ admin: true }) }),
  });
  assert.equal(claim.ok, true);
  await page.evaluate(async () => { const { auth } = await import('/js/firebase/client.js'); await auth.currentUser.getIdToken(true); });
  await page.goto(`${app.base}/pages/manutencao-dados.html`);
  await page.waitForSelector('#btn-validate');
  assert.match(await page.locator('#maint-role').innerText(), /ADMINISTRADOR/);

  log('seletor "Todas as entidades" e modelo unificado (cabeçalho + 1 linha-modelo por entidade)');
  const options = await page.locator('#import-entity option').evaluateAll((o) => o.map((x) => [x.value, x.textContent]));
  assert.ok(options.some(([v, t]) => v === 'todas' && /Todas as entidades/.test(t)));
  assert.equal(options.length, 12);
  await page.selectOption('#import-entity', 'todas');
  assert.match(await page.locator('#btn-template').innerText(), /UNIFICADO/);
  assert.match(await page.locator('#btn-export').innerText(), /base populada.*todas as entidades/i);
  assert.match(await page.locator('#import-explain').innerText(), /nenhum dado seu/i);
  const [tpl] = await Promise.all([page.waitForEvent('download'), page.click('#btn-template')]);
  const tplLines = (await readFile(await tpl.path(), 'utf8')).replace(/^﻿/, '').trim().split(/\r?\n/);
  assert.equal(tplLines[0].split(';')[0], 'entidade');
  assert.deepEqual(tplLines.slice(1).map((l) => l.split(';')[0]), [...IMPORT_ORDER]); // ordem de dependência
  assert.match(await logText(), /Modelo UNIFICADO baixado/);

  log('importar CSV unificado FORA de ordem: dry-run não grava; apply cria tudo na ordem de dependência');
  const before = await counts(uidA);
  assert.ok(Object.values(before).every((n) => n === 0));
  await page.fill('#import-text', buildCsv());
  await page.click('#btn-validate');
  await waitSummary(/Novas: 14 · a atualizar: 0 · duplicadas \(ignoradas\): 0/);
  assert.match(await summary(), /14 linha\(s\) lida\(s\): 14 válida\(s\), 0 com erro/);
  assert.deepEqual(await counts(uidA), before); // dry-run não gravou
  await page.click('#btn-apply');
  await waitLog(/Fim: 14 criada\(s\), 0 atualizada\(s\), 0 ignorada\(s\) por duplicidade, 0 falha\(s\)/);
  const created = await counts(uidA);
  assert.deepEqual(created, { accounts: 2, categories: 3, incomes: 1, expenses: 1, transfers: 1, subscriptions: 1, debtors: 1, debts: 3, goals: 1, creditCards: 1, cardPurchases: 3 });
  const linked = await page.evaluate(async (u) => {
    const { list } = await import('/js/services/firestore.js');
    const accounts = await list(u, 'accounts', {}); const expenses = await list(u, 'expenses', {}); const purchases = await list(u, 'cardPurchases', {}); const debtors = await list(u, 'debtors', {});
    const corrente = accounts.find((a) => a.name === 'Corrente');
    return { expenseOk: expenses[0].accountId === corrente.id, purchaseDebtor: purchases.every((p) => p.debtorId === debtors[0].id), lent: debtors[0].lentCents };
  }, uidA);
  assert.deepEqual(linked, { expenseOk: true, purchaseDebtor: true, lent: 60000 + 90000 });
  // o outro usuário (B) não foi tocado e os nomes iguais NÃO contaram como duplicata do dono
  assert.deepEqual(await counts(uidB), { accounts: 2, categories: 1, incomes: 0, expenses: 0, transfers: 0, subscriptions: 0, debtors: 0, debts: 0, goals: 0, creditCards: 0, cardPurchases: 0 });

  log('reimportar o MESMO arquivo: tudo ignorado por duplicidade, nada duplicado');
  await page.click('#btn-validate');
  await waitSummary(/Novas: 0 · a atualizar: 0 · duplicadas \(ignoradas\): 14/);
  assert.equal(await page.locator('#btn-apply').isDisabled(), true); // nada a gravar
  assert.deepEqual(await counts(uidA), created);

  log('arquivo com 1 campo diferente: atualiza só o registro alterado (mesclagem) e ignora o resto');
  await page.fill('#import-text', buildCsv({ catColor: '#112233' }));
  await page.click('#btn-validate');
  await waitSummary(/Novas: 0 · a atualizar: 1 · duplicadas \(ignoradas\): 13/);
  await page.click('#btn-apply');
  await waitLog(/Fim: 0 criada\(s\), 1 atualizada\(s\), 13 ignorada\(s\) por duplicidade, 0 falha\(s\)/);
  assert.match(await logText(), /atualizada[^\n]*campos: color/);
  assert.deepEqual(await counts(uidA), created);
  const color = await page.evaluate(async (u) => { const { list } = await import('/js/services/firestore.js'); return (await list(u, 'categories', {})).find((c) => c.name === 'Mercado').color; }, uidA);
  assert.equal(color, '#112233');

  log('exportar base populada (todas as entidades, 1 CSV): só o uid do administrador, nada do usuário B');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#btn-export')]);
  await waitLog(/Fim: 11\/11 entidade\(s\), 14 registro\(s\) no total/);
  assert.match(await logText(), new RegExp(`Exportando a base do usuário ${uidA}`));
  assert.match(dl.suggestedFilename(), /^vault-todas-entidades-\d{4}-\d{2}-\d{2}\.csv$/);
  const exported = await readFile(await dl.path(), 'utf8');
  assert.ok(exported.includes('Corrente') && exported.includes('Geladeira') && exported.includes('Moto') && exported.includes('Netflix'));
  assert.doesNotMatch(exported, /B-Conta-Secreta|777,00/); // dados do OUTRO usuário nunca saem, mesmo sendo admin
  const dataLines = exported.replace(/^﻿/, '').trim().split(/\r?\n/).slice(1);
  assert.equal(dataLines.length, 14);
  assert.deepEqual([...new Set(dataLines.map((l) => l.split(';')[0]))], [...IMPORT_ORDER]);
  assert.equal(dataLines.filter((l) => l.startsWith('categorias;') && l.includes('Corrente')).length, 0);

  log('o arquivo exportado é reimportável: 100% duplicado (idempotente)');
  await page.fill('#import-text', exported);
  await page.click('#btn-validate');
  await waitSummary(/Novas: 0 · a atualizar: 0 · duplicadas \(ignoradas\): 14/);

  log('modo por entidade preservado: importar só categorias continua idempotente');
  await page.selectOption('#import-entity', 'categorias');
  assert.match(await page.locator('#btn-template').innerText(), /vazio/i);
  await page.fill('#import-text', 'nome;tipo;cor\nMercado;expense;\nNova Categoria;both;#abcdef\n');
  await page.click('#btn-validate');
  await waitSummary(/Novas: 1 · a atualizar: 0 · duplicadas \(ignoradas\): 1/);
  await page.click('#btn-apply');
  await waitLog(/Fim: 1 criada\(s\), 0 atualizada\(s\), 1 ignorada\(s\) por duplicidade/);

  // 404 esperado: o painel de administradores consulta GET /api/admin-claims, que não existe no servidor estático do E2E.
  assert.deepEqual(app.problems.filter((p) => !/permission|PERMISSION|insufficient|status of 404/i.test(p)), [], `erros de console/página: ${app.problems.join(' | ')}`);
  console.info('E2E CSV unificado OK');
} catch (error) {
  console.error(`E2E CSV unificado FALHOU na etapa "${step}":`, error.message);
  await page.screenshot({ path: join(tmpdir(), 'vault-e2e-csv-fail.png'), fullPage: true }).catch(() => {});
  console.error('screenshot:', join(tmpdir(), 'vault-e2e-csv-fail.png'));
  if (app.problems.length) console.error('problemas capturados:', app.problems);
  process.exitCode = 1;
} finally {
  await app.close();
}
