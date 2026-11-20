/**
 * E2E da Central de validação do sistema (VF-UI-02): usuário comum não vê a seção e é barrado (403) em chamadas diretas;
 * administrador popula, audita e remove os dados de demonstração sem tocar nos dados reais.
 */
import assert from 'node:assert/strict';
import { loadPlaywright, launchApp, registerUser } from './harness.mjs';

const pw = loadPlaywright();
if (!pw) { console.warn('[e2e] playwright não encontrado — cenários ignorados.'); process.exit(0); }
const app = await launchApp(pw);
const { page } = app;
let step = 'início';
const log = (name) => { step = name; console.info(`  · ${name}`); };

const direct = (op, extra = {}) => page.evaluate(async ([o, e]) => {
  const { auth } = await import('/js/firebase/client.js');
  const res = await fetch('/api/validation', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${await auth.currentUser.getIdToken(true)}` }, body: JSON.stringify({ op: o, ...e }) });
  return { status: res.status, body: await res.json() };
}, [op, extra]);
const counts = () => page.evaluate(async () => {
  const { list } = await import('/js/services/firestore.js');
  const { auth } = await import('/js/firebase/client.js');
  const out = {};
  for (const c of ['accounts', 'categories', 'incomes', 'expenses', 'transfers', 'goals', 'creditCards', 'invoices', 'debtors', 'debts', 'debtPayments', 'budgets']) out[c] = (await list(auth.currentUser.uid, c, {})).length;
  return out;
});
const realIds = () => page.evaluate(async () => {
  const { list } = await import('/js/services/firestore.js');
  const { auth } = await import('/js/firebase/client.js');
  const out = [];
  for (const c of ['accounts', 'categories', 'expenses', 'debtors']) for (const d of await list(auth.currentUser.uid, c, {})) if (!d.id.startsWith('demo_')) out.push(`${c}/${d.id}:${d.updatedAt?.toMillis?.() ?? ''}`);
  return out.sort();
});

try {
  await registerUser(page, app.base, 'Central Comum');
  await page.goto(`${app.base}/pages/manutencao-dados.html`);
  await page.waitForSelector('#btn-seed');

  log('usuário comum: a Central NÃO aparece e chamadas diretas ao endpoint são barradas (403) sem criar nada');
  assert.equal(await page.locator('#panel-validation').count(), 0);
  assert.equal(await page.getByText('Central de validação do sistema').count(), 0);
  for (const [op, extra] of [['status'], ['seed', { confirm: 'POPULAR DEMONSTRACAO' }], ['audit'], ['cleanup', { confirm: 'REMOVER DEMONSTRACAO' }]]) {
    const r = await direct(op, extra);
    assert.deepEqual([r.status, r.body.error], [403, 'FORBIDDEN'], op);
  }
  assert.equal(Object.values(await counts()).reduce((t, n) => t + n, 0), 0);

  log('administrador: a Central aparece, isolada, e os painéis existentes continuam presentes');
  const uid = await page.evaluate(async () => (await import('/js/firebase/client.js')).auth.currentUser.uid);
  const claim = await fetch('http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/projects/demo-vault-finance/accounts:update', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer owner' }, body: JSON.stringify({ localId: uid, customAttributes: JSON.stringify({ admin: true }) }),
  });
  assert.equal(claim.ok, true);
  await page.goto(`${app.base}/pages/manutencao-dados.html`);
  await page.waitForSelector('#panel-validation');
  for (const id of ['panel-clean', 'panel-admins', 'panel-seed', 'panel-import', 'btn-seed', 'btn-reset', 'btn-clean', 'btn-validate']) assert.equal(await page.locator(`#${id}`).count(), 1, id);
  assert.match(await page.locator('#panel-validation h2').innerText(), /Central de validação do sistema/);
  await page.waitForFunction(() => /Nenhum dado de demonstração/.test(document.querySelector('#validation-status')?.innerText ?? ''));
  assert.equal(await page.locator('#btn-validation-audit').isDisabled(), true); // sem dados, sem auditoria

  log('dados REAIS do administrador existem antes da demonstração (devem ficar intactos)');
  await page.evaluate(async () => {
    const { createAccount } = await import('/js/services/accounts.js');
    const { createCategory } = await import('/js/services/categories.js');
    const { createExpense } = await import('/js/services/expenses.js');
    const { createDebtor } = await import('/js/services/debtors.js');
    const { auth } = await import('/js/firebase/client.js');
    const uid = auth.currentUser.uid;
    const a = await createAccount(uid, { institution: 'Banco Real', name: 'Corrente real', type: 'checking', initialBalanceCents: '321,00', color: '#111111', status: 'active' });
    const c = await createCategory(uid, { name: 'Real', kind: 'expense', color: '#222222' });
    await createExpense(uid, { description: 'Despesa real', categoryId: c.id, amountCents: '10,00', accountId: a.id, purchaseDate: '2026-12-01', dueDate: '2026-12-10', status: 'pending', recurrence: 'none' });
    await createDebtor(uid, { name: 'Devedor real', lentCents: '50,00', loanDate: '2026-12-01' });
  });
  const realBefore = await realIds();
  assert.equal(realBefore.length, 4);

  log('popular: frase errada não grava; frase correta popula; segunda tentativa não duplica');
  await page.fill('#validation-seed-phrase', 'errado');
  await page.click('#btn-validation-seed');
  await page.waitForTimeout(400);
  assert.equal((await counts()).accounts, 1);
  await page.fill('#validation-seed-phrase', 'POPULAR DEMONSTRACAO');
  await page.click('#btn-validation-seed');
  await page.waitForFunction(() => /37 registros de demonstração criados/.test(document.querySelector('#validation-log')?.innerText ?? ''), { timeout: 60000 });
  await page.waitForFunction(() => /Dados de demonstração presentes \(37 registros/.test(document.querySelector('#validation-status')?.innerText ?? ''));
  const seeded = await counts();
  assert.deepEqual([seeded.accounts, seeded.debtors, seeded.invoices, seeded.debtPayments], [4, 3, 3, 3]);
  assert.equal(await page.locator('#btn-validation-seed').isDisabled(), true);

  log('conferência visual: dados demo aparecem nas telas existentes (Bancos)');
  await page.goto(`${app.base}/pages/bancos.html`);
  await page.waitForFunction(() => /\[DEMO\]/.test(document.querySelector('#page-content')?.innerText ?? ''));
  await page.goto(`${app.base}/pages/manutencao-dados.html`);
  await page.waitForSelector('#panel-validation');

  log('auditoria funcional: todos os cenários passam, nenhum dado real é afetado');
  await page.click('#btn-validation-audit');
  await page.waitForSelector('#validation-table', { timeout: 120000 });
  const rows = await page.locator('#validation-table tbody tr').evaluateAll((trs) => trs.map((tr) => [tr.dataset.scenario, tr.dataset.ok]));
  assert.ok(rows.length >= 11, JSON.stringify(rows));
  assert.deepEqual(rows.filter(([, ok]) => ok !== 'true'), []);
  assert.match(await page.locator('#validation-log').innerText(), /0 falharam/);
  assert.deepEqual(await realIds(), realBefore);

  log('remover: frase errada não remove; correta remove SÓ a demonstração e os dados reais ficam idênticos');
  await page.fill('#validation-clean-phrase', 'errado');
  await page.click('#btn-validation-clean');
  await page.waitForTimeout(400);
  assert.equal((await counts()).accounts, 4);
  await page.fill('#validation-clean-phrase', 'REMOVER DEMONSTRACAO');
  await page.click('#btn-validation-clean');
  await page.waitForFunction(() => /37 registros de demonstração removidos/.test(document.querySelector('#validation-log')?.innerText ?? ''), { timeout: 60000 });
  const after = await counts();
  assert.deepEqual([after.accounts, after.debtors, after.invoices, after.debtPayments, after.goals], [1, 1, 0, 0, 0]);
  assert.deepEqual(await realIds(), realBefore);
  console.info('E2E central de validação OK');
} catch (error) {
  console.error(`E2E central de validação FALHOU na etapa "${step}":`, error.message);
  await page.screenshot({ path: '/tmp/vault-e2e-validation-fail.png' }).catch(() => {});
  process.exitCode = 1;
} finally {
  await app.close();
}
