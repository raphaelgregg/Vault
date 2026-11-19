/**
 * E2E do painel de manutenção (VF-2-03u): massa de testes completa pelos services, saldos derivados esperados,
 * limpeza (usuário e banco inteiro, com permission-denied destacado), reset + gerar e importação CSV em 2 etapas.
 * Rodar com `npm run test:e2e`. Sem `playwright`, sai com aviso (código 0).
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPlaywright, launchApp, registerUser } from './harness.mjs';

const pw = loadPlaywright();
if (!pw) {
  console.warn('[e2e] playwright não encontrado — cenários ignorados.');
  process.exit(0);
}

const app = await launchApp(pw);
const { page } = app;
let step = 'início';
const log = (name) => { step = name; console.info(`  · ${name}`); };
const logText = (id) => page.locator(`#${id}`).innerText();
const waitLog = (id, re) => page.waitForFunction(([sel, src]) => new RegExp(src).test(document.querySelector(sel)?.innerText ?? ''), [`#${id}`, re.source], { timeout: 120000 });
const counts = () => page.evaluate(async () => {
  const { list } = await import('/js/services/firestore.js');
  const { auth } = await import('/js/firebase/client.js');
  const uid = auth.currentUser.uid;
  const out = {};
  for (const c of ['accounts', 'categories', 'incomes', 'expenses', 'transfers', 'budgets', 'goals', 'goalTransactions', 'creditCards', 'cardPurchases', 'invoices', 'subscriptions', 'debtors', 'debts', 'debtPayments']) out[c] = (await list(uid, c, {})).length;
  return out;
});

try {
  await registerUser(page, app.base);
  await page.waitForSelector('#page-content .panel');
  await page.goto(`${app.base}/pages/manutencao-dados.html`);
  await page.waitForSelector('#btn-seed');

  log('massa de testes: pacote completo sem falhas');
  await page.click('#btn-seed');
  await waitLog('seed-log', /Fim: \d+ etapa/);
  const seedText = await logText('seed-log');
  assert.match(seedText, /Fim: 10 etapa\(s\) ok, 0 com falha/, seedText);

  log('massa: invariantes (saldo derivado, repartição de metas, faturas, devedores)');
  const state = await page.evaluate(async () => {
    const { list } = await import('/js/services/firestore.js');
    const { loadBalances } = await import('/js/services/balances.js');
    const { allocateLinkedGoalBalances } = await import('/js/core/model.js');
    const { auth } = await import('/js/firebase/client.js');
    const uid = auth.currentUser.uid;
    const accounts = await list(uid, 'accounts', {});
    const { balances, movements } = await loadBalances(uid, accounts);
    const byName = Object.fromEntries(accounts.map((a) => [a.name, balances.get(a.id)]));
    const goals = await list(uid, 'goals', {});
    const txCounts = new Map();
    for (const t of movements.goalTransactions) txCounts.set(t.goalId, (txCounts.get(t.goalId) ?? 0) + 1);
    const alloc = allocateLinkedGoalBalances(goals, balances, txCounts);
    const shares = Object.fromEntries(goals.map((g) => [g.name, alloc.get(g.id) ?? null]));
    const invoices = await list(uid, 'invoices', {});
    const debtors = await list(uid, 'debtors', {});
    const debts = await list(uid, 'debts', {});
    const purchases = await list(uid, 'cardPurchases', {});
    const paid = invoices.find((i) => i.status === 'paid');
    return {
      byName, shares,
      statuses: [...new Set(invoices.map((i) => i.status))].sort(),
      paidInvoice: paid ? { accountOk: Boolean(paid.accountId), paidAt: paid.paidAt, paidCents: paid.paidCents } : null,
      debtors: Object.fromEntries(debtors.map((d) => [d.name, { lent: d.lentCents, received: d.receivedCents, status: d.status }])),
      debtStatuses: [...new Set(debts.map((d) => d.status))].sort(),
      linkedPurchases: purchases.filter((p) => p.debtorId).length,
      consolidated: purchases.filter((p) => p.notes === 'Lançamento consolidado da fatura').length,
    };
  });
  assert.equal(state.byName['Teste Conta Corrente'], 775000); // 5000+6000−1200−1800−300+200+400−550
  assert.equal(state.byName['Teste Caixinha'], 100000);
  assert.equal(state.byName['Teste Investimentos'], 80000);
  assert.deepEqual([state.shares['Teste Reserva de emergência'], state.shares['Teste Viagem'], state.shares['Teste Notebook']], [60000, 40000, null]); // 600 + 400 = saldo da caixinha, sem duplicar
  assert.deepEqual(state.statuses, ['cancelled', 'closed', 'open', 'paid']);
  assert.deepEqual([state.paidInvoice.accountOk, state.paidInvoice.paidCents], [true, 55000]);
  assert.ok(state.paidInvoice.paidAt);
  assert.deepEqual(state.debtors['Teste Maria'], { lent: 30000 + 60000 + 45000, received: 20000, status: 'open' });
  assert.deepEqual(state.debtors['Teste João'], { lent: 40000, received: 40000, status: 'paid' });
  assert.deepEqual(state.debtStatuses, ['paid', 'pending']);
  assert.equal(state.linkedPurchases, 3);
  assert.equal(state.consolidated, 1);

  log('limpeza: confirmação errada não apaga; usuário apaga tudo e destaca auditLog negado');
  const before = await counts();
  assert.ok(before.accounts === 3 && before.invoices >= 4);
  await page.fill('#clean-phrase', 'errado');
  await page.click('#btn-clean');
  await page.waitForTimeout(400);
  assert.deepEqual(await counts(), before); // nada mudou
  await page.fill('#clean-phrase', 'LIMPAR MEUS DADOS');
  await page.click('#btn-clean');
  await waitLog('clean-log', /Concluído: \d+ documento/);
  const after = await counts();
  assert.ok(Object.values(after).every((n) => n === 0), JSON.stringify(after));
  const cleanText = await logText('clean-log');
  assert.match(cleanText, /accounts: 3 apagado/);
  assert.match(cleanText, /PERMISSION-DENIED[^\n]*auditLog/i); // auditoria é create-only: negado e destacado
  assert.ok(await page.locator('#clean-log .maint-log__line--denied').count() >= 1);

  log('banco inteiro: uid alheio tentado → permission-denied destacado');
  await page.check('#mode-db');
  await page.fill('#extra-uids', 'uid-de-outro-usuario');
  await page.fill('#clean-phrase', 'LIMPAR BANCO INTEIRO');
  await page.click('#btn-clean');
  await waitLog('clean-log', /Concluído: \d+ documento/);
  const dbText = await logText('clean-log');
  assert.match(dbText, /PERMISSION-DENIED[^\n]*users\/uid-de-outro-usuario/);
  assert.match(dbText, /Admin SDK/);

  log('resetar + gerar com volume: limpa e repopula (inclui 20 despesas + 20 receitas de massa)');
  await page.fill('#seed-volume', '1');
  await page.fill('#reset-phrase', 'RESETAR E GERAR');
  await page.click('#btn-reset');
  await waitLog('seed-log', /Fim: \d+ etapa/);
  assert.match(await logText('seed-log'), /Fim: 11 etapa\(s\) ok, 0 com falha/);
  const regen = await counts();
  assert.equal(regen.accounts, 3);
  assert.ok(regen.expenses >= 24 && regen.incomes >= 22, JSON.stringify(regen));

  log('importação CSV: modelo, dry-run sem gravar e efetivação só das válidas');
  await page.selectOption('#import-entity', 'categorias');
  const [tplDownload] = await Promise.all([page.waitForEvent('download'), page.click('#btn-template')]);
  assert.match(await readFile(await tplDownload.path(), 'utf8'), /nome;tipo;cor/);
  const catsBefore = (await counts()).categories;
  await page.fill('#import-text', 'nome;tipo;cor\nImport A;expense;#112233\nImport B;both;\nRuim;invalido;\n');
  await page.click('#btn-validate');
  await page.waitForFunction(() => /2 válida\(s\), 1 com erro/.test(document.querySelector('#import-summary')?.innerText ?? ''));
  assert.match(await page.locator('#import-rows').innerText(), /Linha 4 · tipo/);
  assert.equal((await counts()).categories, catsBefore); // dry-run não gravou nada
  await page.click('#btn-apply');
  await waitLog('import-log', /Fim: 2 criada\(s\), 0 falha/);
  assert.equal((await counts()).categories, catsBefore + 2);
  const [expDownload] = await Promise.all([page.waitForEvent('download'), page.click('#btn-export')]);
  const exported = await readFile(await expDownload.path(), 'utf8');
  assert.match(exported, /Import A;expense;#112233/);

  assert.deepEqual(app.problems.filter((p) => !/permission|PERMISSION|insufficient/i.test(p)), [], `erros de console/página: ${app.problems.join(' | ')}`);
  console.info('E2E manutenção OK');
} catch (error) {
  console.error(`E2E manutenção FALHOU na etapa "${step}":`, error.message);
  await page.screenshot({ path: join(tmpdir(), 'vault-e2e-maintenance-fail.png'), fullPage: true }).catch(() => {});
  console.error('screenshot:', join(tmpdir(), 'vault-e2e-maintenance-fail.png'));
  if (app.problems.length) console.error('problemas capturados:', app.problems);
  process.exitCode = 1;
} finally {
  await app.close();
}
