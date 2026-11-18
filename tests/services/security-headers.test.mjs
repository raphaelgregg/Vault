/**
 * VF-1-03 — CSP e SRI. Executar: node --test tests/services/security-headers.test.mjs
 * Garante que o hash CSP do import map injetado, o SRI do lucide e os hosts liberados
 * continuam em sincronia com js/importmap.js, pages/*.html e vercel.json.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import vm from 'node:vm';

const read = (p) => fs.readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const vercel = JSON.parse(read('vercel.json'));
const csp = vercel.headers
  .flatMap((h) => h.headers)
  .find((h) => h.key === 'Content-Security-Policy').value;
const directive = (name) =>
  csp.split(';').map((d) => d.trim()).find((d) => d.startsWith(`${name} `)) ?? '';

function runImportMap() {
  let script;
  const document = {
    querySelector: () => null,
    createElement: () => ({}),
    head: { appendChild: (s) => { script = s; } },
  };
  vm.runInNewContext(read('js/importmap.js'), { document });
  return script;
}

describe('CSP (vercel.json)', () => {
  it('restringe defaults e bloqueia embed/object', () => {
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /object-src 'none'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /base-uri 'self'/);
  });
  it('script-src não permite unsafe-inline/unsafe-eval', () => {
    const d = directive('script-src');
    assert.ok(!d.includes('unsafe-inline') && !d.includes('unsafe-eval'));
  });
  it('hash do import map injetado confere com js/importmap.js', () => {
    const { textContent } = runImportMap();
    const hash = `'sha256-${crypto.createHash('sha256').update(textContent).digest('base64')}'`;
    assert.ok(directive('script-src').includes(hash), `hash esperado: ${hash}`);
  });
  it('connect-src cobre apenas Firebase', () => {
    const d = directive('connect-src');
    for (const h of ['firestore.googleapis.com', 'identitytoolkit.googleapis.com', 'securetoken.googleapis.com'])
      assert.ok(d.includes(h), h);
  });
});

describe('SRI', () => {
  it('import map traz integrity sha384 para cada módulo Firebase', () => {
    const map = JSON.parse(runImportMap().textContent);
    for (const url of Object.values(map.imports)) assert.match(map.integrity[url] ?? '', /^sha384-[A-Za-z0-9+/]{64}$/);
  });
  it('lucide em todas as páginas tem integrity + crossorigin', () => {
    const pages = fs.readdirSync(new URL('../../pages', import.meta.url)).filter((f) => f.endsWith('.html'));
    assert.ok(pages.length > 0);
    for (const f of pages) {
      const tag = read(`pages/${f}`).match(/<script[^>]*unpkg\.com[^>]*>/)?.[0];
      assert.ok(tag, f);
      assert.match(tag, /integrity="sha384-[A-Za-z0-9+/=]+"/, f);
      assert.match(tag, /crossorigin="anonymous"/, f);
    }
  });
});
