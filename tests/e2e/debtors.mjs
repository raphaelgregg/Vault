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
    const debtor = await createDebtor(uid, { name: 'Maria', lentCents: '1.000,00', loanDate: new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date()) });
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
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
  await modal.getByText('Geladeira').first().waitFor();
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
  await page.locator('.modal').getByText('Fogão').first().waitFor();

  log('VF-2-03m: dívida parcelada pela UI convive com a de cartão (lista única, total em aberto somado)');
  await page.goto(`${app.base}/pages/devedores.html`);
  await page.waitForSelector('#page-content tbody tr');
  await page.getByRole('button', { name: 'Parcelas e recebimentos de Maria' }).click();
  await page.getByRole('button', { name: 'Nova dívida' }).click();
  await page.fill('#description', 'Moto');
  await page.fill('#totalCents', '600,00');
  await page.fill('#installments', '3');
  await page.locator('#debt-form button[type="submit"]').click();
  await page.waitForFunction(() => /Dívida criada em 3 parcelas/.test(document.querySelector('.toast')?.innerText ?? ''));
  await page.waitForSelector('#statement-month');
  await page.selectOption('#statement-month', 'all');
  await page.waitForFunction(() => /Moto/.test(document.querySelector('.modal')?.innerText ?? ''));
  const all = await page.locator('.modal').innerText();
  for (const re of [/Moto\s+1\/3/, /Moto\s+2\/3/, /Moto\s+3\/3/, /Geladeira/, /Parcelada/, /Cartão/]) assert.match(all, re);
  assert.match(all, /Total em aberto\s+R\$\s?1\.900,00/); // 1.000 + 300 (cartão) + 600 (dívida)
  assert.doesNotMatch(all, /duplicidade/i);

  log('VF-2-03n: antecipar a parcela 3/3 e quitar o restante da dívida (cartão intacto)');
  const accountId = await page.evaluate(async () => {
    const { createAccount } = await import('/js/services/accounts.js');
    const { auth } = await import('/js/firebase/client.js');
    const r = await createAccount(auth.currentUser.uid, { institution: 'Banco E2E', name: 'Corrente', type: 'checking', initialBalanceCents: '0,00', color: '#1f7a5c', status: 'active' });
    return r.id;
  });
  const modalText = () => page.locator('.modal').innerText();
  // o modal carrega as contas ao abrir: reabre para enxergar a conta recém-criada
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Parcelas e recebimentos de Maria' }).click();
  await page.waitForSelector('#statement-month');
  await page.getByRole('button', { name: 'Quitar parcela 3 de Moto' }).click();
  await page.selectOption('#accountId', accountId);
  await page.locator('#debt-pay-form button[type="submit"]').click();
  await page.waitForFunction(() => /Parcela antecipada e quitada/.test(document.querySelector('.toast')?.innerText ?? ''));
  await page.waitForFunction(() => /Total em aberto\s+R\$\s?1\.700,00/.test(document.querySelector('.modal')?.innerText ?? '')); // 1.900 − 200
  assert.match(await modalText(), /Moto\s+3\/3[^\n]*R\$\s?200,00[^\n]*R\$\s?200,00[^\n]*Paga/);
  await page.getByRole('button', { name: 'Quitar dívida Moto' }).first().click();
  await page.selectOption('#accountId', accountId);
  await page.locator('#debt-settle-form button[type="submit"]').click();
  await page.waitForFunction(() => /Dívida quitada/.test(document.querySelector('.toast')?.innerText ?? ''));
  await page.waitForFunction(() => /Total em aberto\s+R\$\s?1\.300,00/.test(document.querySelector('.modal')?.innerText ?? '')); // 1.000 + 300 de cartão
  const after = await modalText();
  assert.equal((after.match(/Moto\s+\d\/3[^\n]*Paga/g) ?? []).length, 3);
  assert.match(after, /Geladeira[^\n]*Pendente/); // compras de cartão intactas
  assert.equal(await page.getByRole('button', { name: /Quitar dívida Moto/ }).count(), 0);

  log('VF-2-03ak: quitar parcela individual e todas as parcelas pendentes de um mês (cartão + dívida), com Firestore e indicadores');
  const renan = await page.evaluate(async () => {
    const { listCards, registerCardPurchase } = await import('/js/services/creditCards.js');
    const { createDebtor } = await import('/js/services/debtors.js');
    const { createDebtPlan } = await import('/js/services/debtPayments.js');
    const { auth } = await import('/js/firebase/client.js');
    const uid = auth.currentUser.uid;
    const [card] = (await listCards(uid)).filter((c) => c.name === 'Cartão E2E');
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
    const debtor = await createDebtor(uid, { name: 'Renan', lentCents: '0,00', loanDate: today });
    let month = null;
    for (const [description, amountCents] of [['Água', '25,00'], ['Mercado', '78,00'], ['Supermercado', '28,00']]) {
      const r = await registerCardPurchase(uid, card.id, { description, amountCents, installmentsTotal: 1, purchaseDate: today, debtorId: debtor.id });
      month = r.invoiceMonths[0].split('_').pop();
    }
    // dívida parcelada em 2x de R$ 50: a 1ª vence no mês da fatura, a 2ª no seguinte
    await createDebtPlan(uid, { debtorId: debtor.id, description: 'Parcela', totalCents: '100,00', installments: 2, firstDueDate: `${month}-28` });
    return { id: debtor.id, month };
  });
  const snapshot = async () => page.evaluate(async ([debtorId, month]) => {
    const { loadDashboard } = await import('/js/services/dashboard.js');
    const { loadBalances } = await import('/js/services/balances.js');
    const { listAccounts } = await import('/js/services/accounts.js');
    const { list } = await import('/js/services/firestore.js');
    const { auth } = await import('/js/firebase/client.js');
    const uid = auth.currentUser.uid;
    const accs = await listAccounts(uid);
    const acc = accs.find((a) => a.institution === 'Banco E2E');
    const bal = (await loadBalances(uid, accs)).balances.get(acc.id);
    const dash = await loadDashboard(uid, { month, includeDebtors: true });
    const payments = (await list(uid, 'debtPayments', { where: [['debtorId', '==', debtorId]] })).map(({ id, debtId, purchaseId, amountCents, date, accountId }) => ({ id, debtId, purchaseId, amountCents, date, accountId }));
    const debtors = await list(uid, 'debtors', {});
    const debts = await list(uid, 'debts', { where: [['debtorId', '==', debtorId]] });
    return { bal, receivable: dash.monthlyForecast.debtors.receivableCents, payments, debtor: debtors.find((d) => d.id === debtorId), debts: debts.map((d) => ({ n: d.installmentNumber, status: d.status, due: d.dueDate })), accId: acc.id };
  }, [renan.id, renan.month]);
  const base0 = await snapshot();
  await page.goto(`${app.base}/pages/devedores.html`);
  await page.waitForSelector('#page-content tbody tr');
  await page.getByRole('button', { name: 'Parcelas e recebimentos de Renan' }).click();
  await page.waitForSelector('#statement-month');
  await page.selectOption('#statement-month', renan.month);
  await page.waitForSelector('#month-settlement');
  assert.match(await page.locator('#month-settlement').innerText(), /4 pendente\(s\) · 0 paga\(s\)/);
  assert.match(await page.locator('#month-settlement').innerText(), /R\$\s?181,00/); // 25 + 78 + 28 + 50
  assert.equal(await page.getByRole('button', { name: /^Quitar dívida/ }).count(), 1); // dívida parcelada: quitar a dívida inteira é outra operação
  // — quitar UMA parcela (Água)
  await page.getByRole('button', { name: 'Quitar parcela 1 de Água' }).click();
  await page.selectOption('#accountId', base0.accId);
  await page.locator('#debt-pay-form button[type="submit"]').click();
  await page.waitForFunction(() => /Parcela (antecipada e )?quitada/.test(document.querySelector('.toast')?.innerText ?? ''));
  await page.waitForFunction(() => /3 pendente\(s\) · 1 paga\(s\)/.test(document.querySelector('#month-settlement')?.innerText ?? ''));
  assert.equal(await page.locator('.modal [data-status="paid"]').count(), 1);
  assert.equal(await page.getByRole('button', { name: 'Quitar parcela 1 de Água' }).count(), 0); // já paga: sem ação
  assert.equal(await page.getByRole('button', { name: 'Quitar parcela 1 de Mercado' }).count(), 1);
  const afterOne = await snapshot();
  assert.equal(afterOne.bal, base0.bal + 2500);
  assert.equal(afterOne.debtor.receivedCents, 2500);
  assert.deepEqual(afterOne.payments.map((p) => [p.id, !!p.purchaseId, !!p.debtId, p.amountCents]), [['settle-' + afterOne.payments[0].purchaseId, true, false, 2500]]);
  assert.equal(base0.receivable - afterOne.receivable, 2500); // a receber do mês (dashboard/previsão) caiu
  // — quitar TODAS as pendentes do mês, com confirmação
  await page.getByRole('button', { name: 'Quitar todas as parcelas pendentes deste mês' }).click();
  await page.waitForSelector('#debt-month-form');
  const confirmText = await page.locator('#debt-month-form').innerText();
  assert.match(confirmText, /3 parcela\(s\) pendente\(s\)/);
  assert.match(confirmText, /R\$\s?156,00/); // 78 + 28 + 50 (a Água já paga ficou de fora)
  await page.selectOption('#debt-month-form #accountId', base0.accId);
  await page.locator('#debt-month-form button[type="submit"]').click();
  await page.waitForFunction(() => /Mês quitado: 3 parcela/.test(document.querySelector('.toast')?.innerText ?? ''));
  await page.waitForFunction(() => /0 pendente\(s\) · 4 paga\(s\)/.test(document.querySelector('#month-settlement')?.innerText ?? ''));
  assert.equal(await page.getByRole('button', { name: 'Quitar todas as parcelas pendentes deste mês' }).count(), 0);
  const afterMonth = await snapshot();
  assert.equal(afterMonth.bal, base0.bal + 18100); // cada recebimento entrou UMA vez na conta (25+78+28+50)
  assert.equal(afterMonth.debtor.receivedCents, 18100);
  assert.equal(afterMonth.payments.length, 4); // histórico: 1 individual + 3 do lote, sem duplicar a Água
  assert.equal(new Set(afterMonth.payments.map((p) => p.id)).size, 4);
  assert.ok(afterMonth.payments.every((p) => p.id.startsWith('settle-') && p.accountId === base0.accId));
  assert.equal(afterMonth.payments.filter((p) => p.debtId).length, 1);
  assert.deepEqual(afterMonth.debts.map((d) => [d.n, d.status]).sort(), [[1, 'paid'], [2, 'pending']]); // a parcela do OUTRO mês não mudou
  assert.equal(base0.receivable - afterMonth.receivable, 18100);
  assert.equal(afterMonth.debtor.status, 'open');
  // repetir não duplica: nada pendente neste mês
  const dupe = await page.evaluate(async ([debtorId, month, accountId]) => {
    const { settleMonthInstallments } = await import('/js/services/debtPayments.js');
    const { auth } = await import('/js/firebase/client.js');
    return settleMonthInstallments(auth.currentUser.uid, debtorId, month, { date: '2031-01-01', accountId });
  }, [renan.id, renan.month, base0.accId]);
  assert.equal(dupe.ok, false);
  assert.equal((await snapshot()).payments.length, 4);
  await page.keyboard.press('Escape');

  log('VF-2-03p: pagar fatura com conta bancária e cancelar fatura vazia (modal Faturas e compras)');
  const seeded2 = await page.evaluate(async () => {
    const { listCards } = await import('/js/services/creditCards.js');
    const { create } = await import('/js/services/firestore.js');
    const { auth } = await import('/js/firebase/client.js');
    const uid = auth.currentUser.uid;
    const [card] = await listCards(uid);
    await create(uid, 'invoices', { cardId: card.id, referenceMonth: '2031-01', dueDate: '2031-01-17', status: 'open' }, `${card.id}_2031-01`);
    return card.id;
  });
  assert.ok(seeded2);
  await page.goto(`${app.base}/pages/cartoes.html`);
  await page.waitForSelector('#page-content .panel');
  await page.getByRole('button', { name: 'Faturas e compras de Cartão E2E' }).click();
  await page.waitForSelector('.modal');
  assert.equal(await page.getByRole('button', { name: 'Cancelar fatura 01/2031' }).count(), 1); // fatura R$ 0,00 sem compras
  assert.equal(await page.getByRole('button', { name: 'Pagar fatura 01/2031' }).count(), 0); // zerada: não paga
  await page.getByRole('button', { name: /Pagar fatura/ }).first().click();
  await page.selectOption('#accountId', { label: 'Banco E2E — Corrente' });
  await page.locator('#invoice-pay-form button[type="submit"]').click();
  await page.waitForFunction(() => /Fatura paga/.test(document.querySelector('.toast')?.innerText ?? ''));
  await page.waitForSelector('.modal');
  assert.match(await page.locator('.modal').innerText(), /Paga[^\n]*Banco E2E — Corrente/); // paga com a conta
  await page.getByRole('button', { name: 'Cancelar fatura 01/2031' }).click();
  await page.getByRole('button', { name: 'Cancelar fatura', exact: true }).click();
  await page.waitForFunction(() => /Fatura cancelada/.test(document.querySelector('.toast')?.innerText ?? ''));
  await page.waitForSelector('.modal');
  assert.equal(await page.getByRole('button', { name: 'Cancelar fatura 01/2031' }).count(), 0);
  // VF-2-03t: a fatura cancelada some da lista (oculta por padrão), reaparece sob demanda e pode ser EXCLUÍDA
  assert.doesNotMatch(await page.locator('.modal').innerText(), /01\/2031/);
  await page.getByRole('button', { name: /Mostrar faturas canceladas/ }).click();
  await page.waitForFunction(() => /01\/2031[^\n]*Cancelada/.test(document.querySelector('.modal')?.innerText ?? ''));
  await page.getByRole('button', { name: 'Excluir fatura 01/2031' }).click();
  await page.getByRole('button', { name: 'Excluir fatura', exact: true }).click();
  await page.waitForFunction(() => /Fatura excluída/.test(document.querySelector('.toast')?.innerText ?? ''));
  await page.waitForSelector('.modal');
  assert.equal(await page.getByRole('button', { name: /Mostrar faturas canceladas/ }).count(), 0); // nada mais cancelado
  assert.doesNotMatch(await page.locator('.modal').innerText(), /01\/2031/);
  await page.keyboard.press('Escape');

  log('VF-2-03t: excluir cartão sem compras cujas faturas estão canceladas/zeradas (antes: bloqueado)');
  await page.evaluate(async () => {
    const { createCard } = await import('/js/services/creditCards.js');
    const { create } = await import('/js/services/firestore.js');
    const { auth } = await import('/js/firebase/client.js');
    const uid = auth.currentUser.uid;
    const c = await createCard(uid, { name: 'Inter', brand: 'Visa', limitCents: '1.000,00', closingDay: 10, dueDay: 17 });
    await create(uid, 'invoices', { cardId: c.id, referenceMonth: '2031-02', dueDate: '2031-02-17', status: 'cancelled', totalCents: 0 }, `${c.id}_2031-02`);
    await create(uid, 'invoices', { cardId: c.id, referenceMonth: '2031-03', dueDate: '2031-03-17', status: 'cancelled' }, `${c.id}_2031-03`);
  });
  await page.goto(`${app.base}/pages/cartoes.html`);
  await page.waitForSelector('#page-content .panel');
  await page.getByRole('button', { name: 'Excluir Inter' }).click();
  await page.getByRole('button', { name: 'Excluir', exact: true }).click();
  await page.waitForFunction(() => /Cartão excluído/.test(document.querySelector('.toast')?.innerText ?? ''));
  await page.waitForFunction(() => !/Inter/.test(document.querySelector('#page-content tbody')?.innerText ?? ''));
  const orphans = await page.evaluate(async () => {
    const { list } = await import('/js/services/firestore.js');
    const { auth } = await import('/js/firebase/client.js');
    return (await list(auth.currentUser.uid, 'invoices')).filter((i) => /2031-0[23]$/.test(i.id)).length;
  });
  assert.equal(orphans, 0); // faturas removidas junto, sem órfãs

  log('VF-2-03r: assinatura no cartão vira parcela na fatura; consolidado em fatura aberta; fatura paga intacta');
  await page.evaluate(async () => {
    const { createCategory } = await import('/js/services/categories.js');
    const { auth } = await import('/js/firebase/client.js');
    await createCategory(auth.currentUser.uid, { name: 'Streaming', kind: 'expense', color: '#1f8a5b' });
  });
  await page.goto(`${app.base}/pages/assinaturas.html`);
  await page.waitForSelector('#page-content .panel');
  await page.getByRole('button', { name: /Nova assinatura/ }).click();
  await page.fill('#name', 'Netflix');
  await page.fill('#amountCents', '55,90');
  await page.selectOption('#accountId', { label: 'Banco E2E — Corrente' });
  await page.selectOption('#categoryId', { index: 1 });
  await page.selectOption('#cardId', { label: 'Cartão E2E' });
  await page.locator('#subscription-form button[type="submit"]').click();
  await page.waitForFunction(() => /Netflix/.test(document.querySelector('#page-content tbody')?.innerText ?? ''));
  assert.match(await page.locator('#page-content tbody tr', { hasText: 'Netflix' }).innerText(), /Cartão Cartão E2E \(fatura\)/);
  await page.getByRole('button', { name: 'Registrar cobrança de Netflix' }).click();
  await page.waitForFunction(() => /Cobrança lançada na fatura do cartão/.test(document.querySelector('.toast')?.innerText ?? ''));
  await page.goto(`${app.base}/pages/cartoes.html`);
  await page.waitForSelector('#page-content .panel');
  await page.getByRole('button', { name: 'Faturas e compras de Cartão E2E' }).click();
  await page.waitForSelector('.modal');
  assert.match(await page.locator('.modal').innerText(), /Netflix[^\n]*R\$\s?55,90[^\n]*Assinatura/);
  await page.getByRole('button', { name: 'Lançar consolidado' }).click();
  const paidMonth = await page.evaluate(async () => {
    const { listCards, listInvoices } = await import('/js/services/creditCards.js');
    const { auth } = await import('/js/firebase/client.js');
    const [c] = await listCards(auth.currentUser.uid);
    return (await listInvoices(auth.currentUser.uid, c.id)).find((i) => i.status === 'paid')?.referenceMonth;
  });
  assert.ok(paidMonth, 'há uma fatura paga');
  await page.fill('#referenceMonth', paidMonth); // fatura já PAGA acima: não pode ser alterada
  await page.fill('#amountCents', '10,00');
  await page.locator('#consolidation-form button[type="submit"]').click();
  await page.waitForSelector('.form__error:not(:empty)');
  assert.match(await page.locator('.modal').innerText(), /já está paga e não é alterada/);
  await page.fill('#referenceMonth', '2031-06');
  await page.fill('#amountCents', '123,45');
  await page.locator('#consolidation-form button[type="submit"]').click();
  await page.waitForFunction(() => /Consolidado lançado/.test(document.querySelector('.toast')?.innerText ?? ''));
  await page.waitForSelector('.modal');
  assert.match(await page.locator('.modal').innerText(), /Consolidado da fatura 06\/2031[^\n]*R\$\s?123,45[^\n]*Consolidado/);
  await page.keyboard.press('Escape');

  log('VF-2-03q: dashboard — blocos de saldo livre/vinculado, previsto, faturas do mês e devedores');
  await page.goto(`${app.base}/pages/dashboard.html`);
  await page.waitForSelector('#dashboard-month');
  const dash = await page.locator('#page-content').innerText();
  for (const re of [/Saldo total/i, /Livre/, /Vinculado a metas/, /Receitas/, /previsto/i, /Faturas a pagar/i, /Limite utilizado/i, /A receber em/i, /Total em aberto/i]) assert.match(dash, re);
  assert.doesNotMatch(dash, /\bnull\b/);
  assert.doesNotMatch(dash, /Não foi possível carregar:/);

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
