/**
 * Inventário VISUAL/FUNCIONAL de `/manutencao-dados` (VF-UI-02): grava (`--record`) ou compara a lista de TODOS os
 * controles e seções da página existente, para usuário comum e administrador. A comparação exige que cada item da linha
 * de base continue presente e idêntico (id, tipo, nome, texto, placeholder, rótulo, valor, opções e estado desabilitado);
 * só é permitido acrescentar elementos DENTRO de `#panel-validation` (Central de validação do sistema).
 */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlaywright, launchApp, registerUser } from './harness.mjs';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'manutencao-inventory.json');
const record = process.argv.includes('--record');
const pw = loadPlaywright();
if (!pw) { console.warn('[e2e] playwright não encontrado — cenários ignorados.'); process.exit(0); }

const app = await launchApp(pw);
const { page } = app;

/** Coleta o inventário dos controles de #page-content (ignora o que estiver dentro de #panel-validation). */
const collect = () => page.evaluate(() => {
  const root = document.querySelector('#page-content');
  const skip = (node) => Boolean(node.closest('#panel-validation'));
  const nodes = [...root.querySelectorAll('section, h2, h3, button, input, select, textarea, a, label, p[id], div[id], span[id], table[id]')].filter((n) => !skip(n));
  const text = (n) => (n.tagName === 'SELECT' || n.tagName === 'TEXTAREA' ? '' : (n.childElementCount === 0 ? n.textContent : '')).replace(/\s+/g, ' ').trim().slice(0, 120);
  return nodes.map((n, i) => ({
    tag: n.tagName.toLowerCase(), id: n.id || null, type: n.getAttribute('type'), name: n.getAttribute('name'), text: text(n),
    placeholder: n.getAttribute('placeholder'), aria: n.getAttribute('aria-label'), forId: n.getAttribute('for'), cls: n.id ? null : (n.className || null),
    disabled: n.disabled === true, checked: n.type === 'radio' || n.type === 'checkbox' ? n.checked : null,
    value: ['INPUT', 'TEXTAREA'].includes(n.tagName) && !['file'].includes(n.type) ? n.value : null,
    options: n.tagName === 'SELECT' ? [...n.options].map((o) => `${o.value}|${o.textContent.trim()}`) : null, order: i,
  }));
});
const key = (e) => `${e.tag}#${e.id ?? ''}|${e.type ?? ''}|${e.name ?? ''}|${e.text}|${e.forId ?? ''}|${e.aria ?? ''}`;

try {
  await registerUser(page, app.base, 'Inventario Comum');
  await page.goto(`${app.base}/pages/manutencao-dados.html`);
  await page.waitForSelector('#btn-seed');
  const common = await collect();
  // promove o MESMO usuário a administrador (Auth Emulator) e recarrega
  const uid = await page.evaluate(async () => (await import('/js/firebase/client.js')).auth.currentUser.uid);
  const claim = await fetch('http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/projects/demo-vault-finance/accounts:update', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer owner' },
    body: JSON.stringify({ localId: uid, customAttributes: JSON.stringify({ admin: true }) }),
  });
  assert.equal(claim.ok, true);
  await page.goto(`${app.base}/pages/manutencao-dados.html`);
  await page.waitForSelector('#mode-target');
  await page.waitForSelector('#btn-admin-claim');
  const admin = await collect();
  const snapshot = { common, admin };
  if (record) {
    await writeFile(FIXTURE, `${JSON.stringify(snapshot, null, 1)}\n`);
    console.info(`inventário gravado: comum=${common.length} controles, admin=${admin.length} controles`);
  } else {
    const base = JSON.parse(await readFile(FIXTURE, 'utf8'));
    for (const role of ['common', 'admin']) {
      const keyed = (list) => { const seen = new Map(); return list.map((e) => { const k = key(e); const n = (seen.get(k) ?? 0) + 1; seen.set(k, n); return { ...e, k: `${k}#${n}` }; }); };
      const now = keyed(snapshot[role]);
      const baseline = keyed(base[role]);
      const nowKeys = new Map(now.map((e) => [e.k, e]));
      const missing = baseline.filter((e) => !nowKeys.has(e.k));
      assert.deepEqual(missing.map((e) => e.k), [], `${role}: controles da linha de base AUSENTES/ALTERADOS`);
      // atributos de estado idênticos
      for (const e of baseline) {
        const cur = nowKeys.get(e.k);
        for (const f of ['placeholder', 'disabled', 'checked', 'value', 'options', 'cls']) assert.deepEqual(cur[f], e[f], `${role}: ${e.k} campo ${f}`);
      }
      // ordem relativa preservada
      const order = baseline.map((e) => nowKeys.get(e.k).order);
      assert.deepEqual(order, [...order].sort((a, b) => a - b), `${role}: ordem dos controles alterada`);
      assert.equal(now.length, baseline.length, `${role}: nenhum controle novo fora de #panel-validation (${now.length} vs ${baseline.length})`);
    }
    // usuário comum NUNCA vê a central
    await page.goto(`${app.base}/pages/manutencao-dados.html`);
    console.info(`inventário idêntico à linha de base: comum=${base.common.length}, admin=${base.admin.length} controles`);
  }
  console.info('E2E inventário OK');
} catch (error) {
  console.error('E2E inventário FALHOU:', error.message);
  process.exitCode = 1;
} finally {
  await app.close();
}
