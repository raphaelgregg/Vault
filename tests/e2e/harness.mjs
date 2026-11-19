/**
 * Harness de testes E2E (VF-4-04): servidor estático + Playwright contra os emuladores.
 *
 * Sem dependência nova no package.json: usa o `playwright` já instalado no ambiente (se não existir,
 * `loadPlaywright()` devolve null e os scripts saem com aviso). O SDK do Firebase (gstatic) é servido
 * do `node_modules/firebase` local (mesmo bundle ESM), então não precisa de rede; a versão local pode
 * diferir da fixada no import map (a chave `integrity` é removida SÓ neste harness).
 * Execução: `npm run test:e2e` (sobe Auth+Firestore e roda os cenários).
 */
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(import.meta.url);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };

export function loadPlaywright() {
  try { return require('playwright'); } catch { return null; }
}

export function startStatic(port = 5599) {
  const server = createServer(async (req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname));
    const file = join(root, path === '/' || path === '\\' ? 'index.html' : path);
    if (!file.startsWith(root) || !existsSync(file)) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(await readFile(file));
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({
    base: `http://localhost:${port}`,
    close: () => new Promise((done) => server.close(done)),
  })));
}

/** Contexto de navegador com SDK local, sem SRI e sem lucide (CDNs bloqueadas no ambiente). */
export async function newContext(browser) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.route('https://www.gstatic.com/firebasejs/**', async (route) => {
    const name = route.request().url().split('/').pop();
    const file = join(root, 'node_modules', 'firebase', name);
    if (!existsSync(file)) { await route.fulfill({ status: 404, body: 'missing' }); return; }
    const body = (await readFile(file, 'utf8')).replace(/firebasejs\/\d+\.\d+\.\d+\//g, 'firebasejs/10.12.2/');
    await route.fulfill({ status: 200, contentType: 'text/javascript', body });
  });
  await context.route('**/js/importmap.js', async (route) => {
    const response = await route.fetch();
    const text = (await response.text()).replace(/\s*map\.integrity\[[^\n]*\n/g, '\n').replace('integrity: {},', '');
    await route.fulfill({ response, body: text });
  });
  await context.route('https://unpkg.com/**', (route) => route.abort());
  return context;
}

let counter = 0;
/** Cria usuário novo pela UI (aba "Criar conta") e espera o dashboard. */
export async function registerUser(page, base, name = 'Teste E2E') {
  counter += 1;
  const email = `e2e-${Date.now()}-${counter}@example.com`;
  await page.goto(`${base}/?mode=demo`);
  await page.click('#tab-register');
  await page.fill('#register-name', name);
  await page.fill('#register-email', email);
  await page.fill('#register-password', 'senha-e2e-123');
  await page.click('#form-register button[type="submit"]');
  await page.waitForURL(/dashboard/, { timeout: 15000 });
  return { email, password: 'senha-e2e-123' };
}

/** Executa código no contexto da página com os services do app (mesmo SDK/sessão). */
export function callService(page, modulePath, fnName, ...args) {
  return page.evaluate(async ([mod, fn, a]) => {
    const m = await import(mod);
    const auth = await import('/js/firebase/client.js');
    return m[fn](auth.auth.currentUser.uid, ...a);
  }, [modulePath, fnName, args]);
}

/**
 * Sobe servidor + navegador + página com coleta de erros de console. Retorna
 * { page, base, problems, close }. Usado pelos cenários que não precisam do preâmbulo de flows.mjs.
 */
export async function launchApp(pw) {
  const server = await startStatic();
  const browser = await pw.chromium.launch();
  const context = await newContext(browser);
  const page = await context.newPage();
  const problems = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/ERR_FAILED|unpkg|lucide/i.test(m.text())) problems.push(`console: ${m.text().slice(0, 200)}`);
  });
  return {
    page,
    base: server.base,
    problems,
    close: async () => { await browser.close(); await server.close(); },
  };
}
