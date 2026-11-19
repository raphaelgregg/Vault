/**
 * E2E de Devedores (VF-2-03j): fechamento do mês e detalhamento de parcelas de cartão vinculadas.
 * Rodar com `npm run test:e2e`. Sem `playwright`, sai com aviso (código 0).
 */
import assert from 'node:assert/strict';
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
const content = () => page.locator('#page-content').innerText();
const waitText = (re) => page.waitForFunction((src) => new RegExp(src).test(document.querySelector('#page-content').innerText), re.source);

try {
  await registerUser(page, app.base);
  await page.waitForSelector('#page-content .panel');

  log('seed: cartão, devedor e compra parcelada vinculada (service real)');
  const seeded = await page.evaluate(async () => {
    const { createCard, registerCardPurchase } = await import('/js/services/creditCards.js');
    const { createDebtor } = await import('/js/services/debtors.js');
    const { auth } = await import('/js/firebase/client.js');
    const uid = auth.currentUser.uid;
    const card = await createCard(uid, { name: 'Cartão E2E', brand: 'Visa', limitCents: '5.000,00', closingDay: 28, dueDay: 5 });
    const debtor = await createDebtor(uid, { name: 'Maria', lentCents: '1.000,00', loanDate: new Date().toISOString().slice(0, 10) });
    const today = new Date().toISOString().slice(0, 10);
    const buy = await registerCardPurchase(uid, card.id, {
      description: 'Geladeira', amountCents: '300,00', installmentsTotal: 3, purchaseDate: today, debtorId: debtor.id,
    });
    return { ok: buy.ok, errors: buy.errors, months: buy.invoiceMonths };
  });
  assert.equal(seeded.ok, true, JSON.stringify(seeded.errors));
  // `invoiceMonths` do service traz ids de fatura (`<cardId>_<YYYY-MM>`): extrai o mês.
  const [firstMonth] = seeded.months.map((id) => id.split('_').pop()).sort();
  const [y, m] = firstMonth.split('-');

  log('devedores: total do mês destacado e emprestado consolidado (1.000 + 300)');
  await page.goto(`${app.base}/pages/devedores.html`);
  await page.waitForSelector('#page-content .panel');
  await page.fill('#closing-month', firstMonth);
  await page.waitForFunction((label) => document.querySelector('#page-content thead').innerText.toLowerCase().includes(label), `a receber em ${m}/${y}`);
  const row = page.locator('#page-content tbody tr', { hasText: 'Maria' });
  assert.match(await row.innerText(), /R\$\s?1\.300,00/); // emprestado = 1.000 + 300 de cartão
  assert.match(await row.locator('td strong').innerText(), /R\$\s?100,00/); // 1ª parcela de 3
  assert.match(await content(), new RegExp(`A receber em ${m}/${y}`, 'i'));

  log('detalhamento: parcela 1/3, cartão, valor e status da fatura');
  await page.getByRole('button', { name: 'Parcelas e recebimentos de Maria' }).click();
  await page.waitForSelector('#statement-month');
  const modal = page.locator('.modal');
  await modal.getByText('Geladeira').waitFor();
  const detail = await modal.innerText();
  assert.match(detail, /1\/3/);
  assert.match(detail, /Cartão E2E/);
  assert.match(detail, /R\$\s?100,00/);
  assert.match(detail, /Pendente/);
  assert.match(detail, new RegExp(`Total a receber em ${m}/${y}`, 'i'));

  log('VF-2-03l: devedor sem empréstimo inicial pela UI e compra de cartão vinculada pela modal');
  await page.goto(`${app.base}/pages/devedores.html`);
  await page.waitForSelector('#page-content .panel');
  await page.getByRole('button', { name: 'Novo devedor' }).click();
  await page.fill('#name', 'Zero Inicial');
  await page.locator('#debtor-form button[type="submit"]').click();
  await page.waitForFunction(() => /Zero Inicial/.test(document.querySelector('#page-content tbody')?.innerText ?? ''));
  assert.match(await page.locator('#page-content tbody tr', { hasText: 'Zero Inicial' }).innerText(), /R\$\s?0,00/);
  await page.goto(`${app.base}/pages/cartoes.html`);
  await page.waitForSelector('#page-content .panel');
  await page.getByRole('button', { name: 'Nova compra em Cartão E2E' }).click();
  await page.fill('#description', 'Fogão');
  await page.fill('#amountCents', '200,00');
  const options = await page.locator('#debtorId option').allInnerTexts();
  assert.ok(options.some((t) => t.startsWith('Zero Inicial')), `seletor sem o devedor: ${options.join(' | ')}`);
  await page.selectOption('#debtorId', { label: options.find((t) => t.startsWith('Zero Inicial')) });
  await page.locator('#purchase-form button[type="submit"]').click();
  await page.waitForFunction(() => /Compra lançada/.test(document.querySelector('.toast')?.innerText ?? ''));
  await page.goto(`${app.base}/pages/devedores.html`);
  await page.waitForSelector('#page-content tbody tr');
  assert.match(await page.locator('#page-content tbody tr', { hasText: 'Zero Inicial' }).innerText(), /R\$\s?200,00/);
  await page.getByRole('button', { name: 'Parcelas e recebimentos de Zero Inicial' }).click();
  await page.waitForSelector('#statement-month');
  // a fatura pode cair no mês seguinte (fechamento dia 28): escolhe o último mês listado
  const monthValues = await page.locator('#statement-month option').evaluateAll((opts) => opts.map((o) => o.value));
  await page.selectOption('#statement-month', monthValues.at(-1));
  await page.locator('.modal').getByText('Fogão').waitFor();

  assert.deepEqual(app.problems, [], `erros de console/página: ${app.problems.join(' | ')}`);
  console.info('E2E devedores OK');
} catch (error) {
  console.error(`E2E devedores FALHOU na etapa "${step}":`, error.message);
  await page.screenshot({ path: join(tmpdir(), 'vault-e2e-debtors-fail.png'), fullPage: true }).catch(() => {});
  console.error('screenshot:', join(tmpdir(), 'vault-e2e-debtors-fail.png'));
  if (app.problems.length) console.error('problemas capturados:', app.problems);
  process.exitCode = 1;
} finally {
  await app.close();
}
