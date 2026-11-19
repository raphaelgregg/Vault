/**
 * E2E do painel de manutenção (VF-2-03u): massa de testes completa pelos services, saldos derivados esperados,
 * limpeza (própria; auditLog negado e destacado), reset + gerar, importação CSV em 2 etapas e separação de
 * privilégios (VF-2-03w): usuário comum sem escopos administrativos; admin (claim) limpa um uid alvo e todos os usuários.
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
  await waitLog('clean-log', /Concluído \[own\]: \d+ documento/);
  const after = await counts();
  assert.ok(Object.values(after).every((n) => n === 0), JSON.stringify(after));
  const cleanText = await logText('clean-log');
  assert.match(cleanText, /accounts: 3 apagado/);
  assert.match(cleanText, /PERMISSION-DENIED[^\n]*auditLog/i); // auditoria é create-only: negado e destacado
  assert.ok(await page.locator('#clean-log .maint-log__line--denied').count() >= 1);

  log('usuário comum: escopos administrativos indisponíveis (sem claim admin) e log traz executor/escopo');
  assert.equal(await page.locator('#mode-target, #mode-all').count(), 0);
  assert.match(await page.locator('#admin-unavailable').innerText(), /claim admin/);
  assert.match(await logText('clean-log'), /Executor \(adminUid\): \S+ · escopo: own/);
  assert.match(await logText('clean-log'), /Auditoria-resumo gravada no log do executor/);

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
  const tplText = await readFile(await tplDownload.path(), 'utf8');
  assert.match(tplText, /nome;tipo;cor/);
  assert.equal(tplText.trim().split(/\r?\n/).length, 1); // modelo VAZIO: só o cabeçalho, nenhum dado
  assert.match(await page.locator('#import-explain').innerText(), /VAZIO[\s\S]*REGISTROS JÁ EXISTENTES/);
  assert.match(await page.locator('#btn-template').innerText(), /vazio/i);
  assert.match(await page.locator('#btn-export').innerText(), /registros existentes/i);
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

  log('exportar TODAS as entidades: um .zip com as 11 + _resumo.txt e log por entidade');
  const [zipDownload] = await Promise.all([page.waitForEvent('download'), page.click('#btn-export-all')]);
  await waitLog('import-log', /Fim: 11\/11 entidade\(s\) exportada\(s\)/);
  const exportLog = await logText('import-log');
  assert.match(exportLog, /Categorias: \d+ registro\(s\) → vault-categorias\.csv/);
  assert.match(exportLog, /Contas: 3 registro\(s\)/);
  assert.match(zipDownload.suggestedFilename(), /^vault-exportacao-completa-\d{4}-\d{2}-\d{2}\.zip$/);
  const zipBytes = await readFile(await zipDownload.path());
  assert.equal(zipBytes.readUInt32LE(0), 0x04034b50);
  const zipText = zipBytes.toString('latin1');
  for (const name of ['contas', 'categorias', 'receitas', 'despesas', 'transferencias', 'assinaturas', 'devedores', 'dividas', 'metas', 'cartoes', 'compras_cartao']) assert.ok(zipText.includes(`vault-${name}.csv`), name);
  assert.ok(zipText.includes('_resumo.txt') && zipText.includes('Total: 11/11 entidade(s)'));
  assert.ok(zipText.includes('Import A')); // registros existentes dentro do pacote

  log('administrador: claim admin (Auth emulator) — limpa um uid ALVO e depois TODOS os usuários, sem entrar nas contas');
  const signOut = () => page.evaluate(async () => { const { auth } = await import('/js/firebase/client.js'); await auth.signOut(); });
  const mkUser = async (accountNames) => {
    await signOut();
    await registerUser(page, app.base);
    await page.waitForSelector('#page-content .panel');
    return page.evaluate(async (names) => {
      const { createAccount } = await import('/js/services/accounts.js');
      const { auth } = await import('/js/firebase/client.js');
      const uid = auth.currentUser.uid;
      for (const n of names) {
        const r = await createAccount(uid, { institution: 'Banco', name: n, type: 'checking', initialBalanceCents: '10,00', color: '#1f7a5c', status: 'active' });
        if (!r.ok) throw new Error(JSON.stringify(r.errors));
      }
      return uid;
    }, accountNames);
  };
  const uidB = await mkUser(['B1', 'B2']);
  const uidC = await mkUser(['C1']);
  const uidA = await mkUser(['A1']);
  const claim = await fetch(`http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/projects/demo-vault-finance/accounts:update`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer owner' },
    body: JSON.stringify({ localId: uidA, customAttributes: JSON.stringify({ admin: true }) }),
  });
  assert.equal(claim.ok, true, `claim admin: ${claim.status}`);
  const accountsOf = (uid) => page.evaluate(async (u) => { const { list } = await import('/js/services/firestore.js'); return (await list(u, 'accounts', {})).length; }, uid);
  await page.goto(`${app.base}/pages/manutencao-dados.html`);
  await page.waitForSelector('#mode-target'); // claim lida do token renovado: opções administrativas aparecem
  assert.equal(await page.locator('#admin-unavailable').count(), 0);
  assert.match(await page.locator('#panel-clean .notice').innerText(), /ADMINISTRADOR/);
  assert.deepEqual([await accountsOf(uidB), await accountsOf(uidC), await accountsOf(uidA)], [2, 1, 1]); // admin LÊ dados alheios (necessário para apagar)

  await page.click('#btn-detect');
  await waitLog('clean-log', /usuário\(s\) detectado\(s\) \(amostra/);
  const options = await page.locator('#detected-users option').evaluateAll((o) => o.map((x) => x.value));
  assert.ok([uidA, uidB, uidC].every((u) => options.includes(u)), options.join(','));

  await page.check('#mode-target');
  await page.selectOption('#detected-users', uidB);
  assert.equal(await page.inputValue('#target-uid'), uidB);
  await page.fill('#clean-phrase', 'LIMPAR BANCO INTEIRO'); // frase do escopo errado: recusada
  await page.click('#btn-clean');
  await page.waitForTimeout(400);
  assert.equal(await accountsOf(uidB), 2);
  await page.fill('#clean-phrase', 'LIMPAR USUARIO ALVO');
  await page.click('#btn-clean');
  await waitLog('clean-log', /Concluído \[target_uid\] alvo \S+: \d+ documento/);
  const targetLog = await logText('clean-log');
  assert.ok(targetLog.includes(`Executor (adminUid): ${uidA} · escopo: target_uid · targetUid: ${uidB}`), targetLog);
  assert.match(targetLog, /accounts: 2 apagado/);
  assert.doesNotMatch(targetLog, /PERMISSION-DENIED/); // auditLog alheio nem é tentado
  assert.deepEqual([await accountsOf(uidB), await accountsOf(uidC), await accountsOf(uidA)], [0, 1, 1]); // só o alvo foi limpo

  await page.check('#mode-all');
  await page.fill('#clean-phrase', 'LIMPAR BANCO INTEIRO');
  await page.click('#btn-clean');
  await waitLog('clean-log', /Concluído \[all_users\]: \d+ documento/);
  const allLog = await logText('clean-log');
  assert.ok(allLog.includes(`Executor (adminUid): ${uidA} · escopo: all_users`), allLog);
  assert.ok(allLog.includes(`${uidC}=`) && allLog.includes(`${uidA}=`), allLog); // por usuário
  assert.deepEqual([await accountsOf(uidB), await accountsOf(uidC), await accountsOf(uidA)], [0, 0, 0]);
  assert.match(allLog, /Auditoria-resumo gravada/);

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
