/** Rotas (VF-2-04): menu, página HTML, rewrite do Vercel e módulo registrado em app.js em sincronia. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { NAV_ITEMS } from '../../js/utils/nav.js';

const root = join(import.meta.dirname, '..', '..');
const vercel = JSON.parse(readFileSync(join(root, 'vercel.json'), 'utf8'));
const appJs = readFileSync(join(root, 'js', 'app.js'), 'utf8');

describe('rotas de navegação', () => {
  for (const item of NAV_ITEMS) {
    it(`${item.id}: página, data-page, rewrite limpo e módulo`, () => {
      const page = join(root, 'pages', `${item.id}.html`);
      assert.ok(existsSync(page), `pages/${item.id}.html`);
      assert.equal(item.href, `${item.id}.html`);
      assert.match(readFileSync(page, 'utf8'), new RegExp(`data-page="${item.id}"`));
      const rewrite = vercel.rewrites.find((r) => r.source === `/${item.id}`);
      assert.equal(rewrite?.destination, `/pages/${item.id}.html`, 'rewrite em vercel.json');
      assert.match(appJs, new RegExp(`\\b${item.id}: \\(\\) => import\\('./modules/${item.id}.js'\\)`), 'MODULES em app.js');
      assert.ok(existsSync(join(root, 'js', 'modules', `${item.id}.js`)), 'módulo JS');
    });
  }
});
