/**
 * VF-COR-01 (verificação adicional) — NAVEGADOR: como as telas de Transferências e Devedores se comportam com estorno
 * existente em 3 situações: (A) leitura permitida, (B) leitura NEGADA (Rules antigas carregadas em tempo de execução),
 * (C) erro de conexão. Negado/erro ⇒ estado de erro ou limitação EXPLÍCITO; nunca "sem estornos" nem valores incorretos.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp, FieldValue } from 'firebase-admin/firestore';
import { loadPlaywright, launchApp, registerUser } from './harness.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const pw = loadPlaywright();
if (!pw) { console.warn('[e2e] playwright não encontrado — cenários ignorados.'); process.exit(0); }
const NEW_RULES = readFileSync(join(root, 'firestore.rules'), 'utf8');
const LEGACY_RULES = readFileSync(join(root, 'tests', 'fixtures', 'firestore.rules.legacy'), 'utf8');
const setRules = async (content) => {
  const res = await fetch('http://127.0.0.1:8080/emulator/v1/projects/demo-vault-finance:securityRules', { method: 'PUT', body: JSON.stringify({ rules: { files: [{ name: 'firestore.rules', content }] } }) });
  assert.equal(res.ok, true, `rules PUT ${res.status}`);
};

initializeApp({ projectId: 'demo-vault-finance' });
const db = getFirestore();
const noon = (iso) => Timestamp.fromDate(new Date(`${iso}T12:00:00.000Z`));
const stamp = () => ({ createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });

const app = await launchApp(pw);
const { page } = app;
let step = 'início';
const log = (name) => { step = name; console.info(`  · ${name}`); };
const content = async () => (await page.locator('#page-content').innerText()).replace(/\s+/g, ' ');

try {
  await registerUser(page, app.base, 'Visibilidade');
  await page.goto(`${app.base}/pages/bancos.html`);
  await page.waitForSelector('#page-content .panel');
  const uid = await page.evaluate(async () => { const { auth } = await import('/js/firebase/client.js'); for (let i = 0; i < 50 && !auth.currentUser; i += 1) await new Promise((r) => setTimeout(r, 100)); return auth.currentUser.uid; });
  const put = (c, id, data) => db.doc(`users/${uid}/${c}/${id}`).set({ ...data, ...stamp() });
  // mundo criado "pelo servidor": conta, meta com aporte ESTORNADO, devedor com parcela recebida e ESTORNADA
  await put('accounts', 'accA', { institution: 'Banco Visib', name: 'Corrente', type: 'checking', initialBalanceCents: 100000, color: '#000000', status: 'active' });
  await put('goals', 'g1', { name: 'Viagem Visib', targetCents: 100000, status: 'active' });
  await put('goalTransactions', 'gt1', { goalId: 'g1', type: 'deposit', amountCents: 6000, date: noon('2026-12-03'), accountId: 'accA' });
  await put('debtors', 'dev', { name: 'Devedor Visib', loanDate: noon('2026-11-10'), lentCents: 20000, receivedCents: 0, status: 'open' });
  await put('debts', 'p0', { debtorId: 'dev', description: 'Moto', principalCents: 10000, dueDate: noon('2099-12-10'), installmentNumber: 1, installmentsTotal: 2, debtGroupId: 'g', status: 'pending' });
  await put('debts', 'p1', { debtorId: 'dev', description: 'Moto', principalCents: 10000, dueDate: noon('2099-12-20'), installmentNumber: 2, installmentsTotal: 2, debtGroupId: 'g', status: 'pending' });
  await put('debtPayments', 'pay1', { debtId: 'p0', debtorId: 'dev', amountCents: 10000, date: noon('2026-12-02'), accountId: 'accA' });
  await put('reversals', 'debtPayments_pay1', { kind: 'debtPayment', targetCollection: 'debtPayments', targetId: 'pay1', amountCents: 10000, reason: 'Conta errada', date: noon('2026-12-04'), operationId: 'rev-op-00001', accountId: 'accA', debtorId: 'dev', debtId: 'p0', original: {} });
  await put('reversals', 'goalTransactions_gt1', { kind: 'goalTransaction', targetCollection: 'goalTransactions', targetId: 'gt1', amountCents: 6000, reason: 'Aporte errado', date: noon('2026-12-04'), operationId: 'rev-op-00002', accountId: 'accA', goalId: 'g1', original: {} });
  const openParcels = async () => { await page.getByRole('button', { name: 'Parcelas e recebimentos de Devedor Visib' }).click(); await page.waitForSelector('.modal__dialog'); };

  // ---------------------------------------------------------------- (A) leitura permitida
  log('A) leitura PERMITIDA: estornos descontados (meta com aporte estornado; parcela pendente com R$ 0 recebido)');
  await setRules(NEW_RULES);
  await page.goto(`${app.base}/pages/transferencias.html`);
  await page.waitForSelector('#page-content .panel');
  await page.waitForFunction(() => /Aportes e resgates em metas/.test(document.querySelector('#page-content')?.innerText ?? ''));
  assert.equal(await page.locator('#reversals-unavailable').count(), 0);
  assert.match(await content(), /Estornado/);
  await page.goto(`${app.base}/pages/devedores.html`);
  await page.waitForSelector('tbody tr');
  await openParcels();
  const modalA = (await page.locator('.modal__dialog').innerText()).replace(/\s+/g, ' ');
  assert.equal(await page.locator('#reversals-unavailable').count(), 0);
  assert.match(modalA, /Moto/);
  assert.match(modalA, /Estornado/); // o recebimento original continua visível, marcado
  assert.equal(await page.getByRole('button', { name: /Quitar parcela 1 de Moto/ }).count(), 1); // parcela reaberta: quitável de novo
  assert.doesNotMatch(modalA, /✓ Paga/);

  // ---------------------------------------------------------------- (B) leitura NEGADA (Rules antigas)
  log('B) leitura NEGADA (Rules antigas): limitação EXPLÍCITA; sem valores derivados; transferências entre contas e Nova dívida seguem');
  await setRules(LEGACY_RULES);
  const denied = await page.evaluate(async () => { const { list } = await import('/js/services/firestore.js'); const { auth } = await import('/js/firebase/client.js'); try { await list(auth.currentUser.uid, 'reversals', {}); return 'lido'; } catch (e) { return e.code; } });
  assert.equal(denied, 'permission-denied');
  await page.goto(`${app.base}/pages/transferencias.html`);
  await page.waitForSelector('#reversals-unavailable');
  const tText = await content();
  assert.match(tText, /Transferências registradas/); // a tela NÃO fica em branco
  assert.match(tText, /Limitação: não foi possível ler os estornos/);
  assert.doesNotMatch(tText, /Aportes e resgates em metas/); // histórico de metas oculto
  await page.getByRole('button', { name: 'Nova transferência' }).click();
  await page.waitForSelector('#transfer-form');
  assert.deepEqual(await page.locator('#transfer-form optgroup').evaluateAll((g) => g.map((x) => x.label).filter((l) => /Metas/.test(l))), [], 'metas não aparecem como origem/destino com o guardado desconhecido');
  assert.equal(await page.locator('#transfer-form option', { hasText: 'Viagem Visib' }).count(), 0);
  await page.keyboard.press('Escape');
  await page.goto(`${app.base}/pages/devedores.html`);
  await page.waitForSelector('tbody tr');
  assert.match(await content(), /Não foi possível calcular o fechamento do mês/); // aviso já existente da lista (valores "—")
  await openParcels();
  const modalB = (await page.locator('.modal__dialog').innerText()).replace(/\s+/g, ' ');
  assert.match(modalB, /Limitação: não foi possível ler os estornos/);
  assert.doesNotMatch(modalB, /✓ Paga|Parcial/); // nenhuma situação inventada
  assert.deepEqual(await page.locator('.modal__dialog tbody tr td:nth-child(7)').allInnerTexts(), ['—', '—']); // coluna Recebido oculta
  assert.equal(await page.locator('.modal__dialog [data-status="unknown"]').count(), 2); // as 2 parcelas: situação indisponível
  assert.equal(await page.getByRole('button', { name: /Quitar/ }).count(), 0); // recebimentos desativados
  assert.equal(await page.locator('#settle-month').count(), 0);
  // "Nova dívida" não depende de estornos e continua funcionando
  await page.locator('.modal__dialog').getByRole('button', { name: 'Nova dívida', exact: true }).click();
  await page.waitForSelector('#debt-form');
  await page.fill('#description', 'Notebook Visib');
  await page.fill('#totalCents', '600,00');
  await page.fill('#installments', '2');
  await page.fill('#firstDueDate', '2099-12-30');
  await page.locator('#debt-form button[type="submit"]').click();
  await page.waitForFunction(() => /Dívida criada em 2 parcelas/.test(document.querySelector('.toast')?.innerText ?? ''), { timeout: 15000 });
  await page.waitForFunction(() => /Notebook Visib/.test(document.querySelector('.modal__dialog')?.innerText ?? ''));
  assert.match(await page.locator('.modal__dialog').innerText(), /Limitação: não foi possível ler os estornos/); // segue limitado após criar

  // ---------------------------------------------------------------- (C) erro de conexão
  log('C) ERRO DE CONEXÃO: estado de erro explícito (nunca "sem estornos", nunca tela em branco)');
  await setRules(NEW_RULES);
  await page.context().route('**/js/services/firestore.js', async (route) => {
    const response = await route.fetch();
    const src = (await response.text()).replace('export async function list(uid, collectionName, options = {}) {', "export async function list(uid, collectionName, options = {}) {\n  if (collectionName === 'reversals') throw Object.assign(new Error('offline'), { code: 'unavailable' });\n  return list_(uid, collectionName, options);\n}\nasync function list_(uid, collectionName, options = {}) {");
    await route.fulfill({ response, body: src });
  });
  await page.goto(`${app.base}/pages/transferencias.html`);
  await page.waitForSelector('#transfers-load-error');
  assert.match(await content(), /Não foi possível carregar as transferências\. Sem conexão com o servidor/);
  assert.doesNotMatch(await content(), /Transferências registradas/);
  await page.goto(`${app.base}/pages/devedores.html`);
  await page.waitForSelector('tbody tr');
  assert.match(await content(), /Não foi possível calcular o fechamento do mês/);
  await page.getByRole('button', { name: 'Parcelas e recebimentos de Devedor Visib' }).click();
  await page.waitForFunction(() => /Sem conexão com o servidor/.test(document.querySelector('.toast')?.innerText ?? ''));
  assert.equal(await page.locator('.modal__dialog').count(), 0); // sem modal com dados presumidos
  console.info('E2E visibilidade de estornos OK');
} catch (error) {
  console.error(`E2E visibilidade de estornos FALHOU na etapa "${step}":`, error.message);
  await page.screenshot({ path: '/tmp/vault-e2e-reversals-fail.png' }).catch(() => {});
  process.exitCode = 1;
} finally {
  await setRules(NEW_RULES).catch(() => {});
  await app.close();
}
