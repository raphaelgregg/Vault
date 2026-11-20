/**
 * Central de validação (VF-UI-02): cliente do endpoint e contrato de ISOLAMENTO em `/manutencao-dados`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { callValidation, ValidationApiError, VALIDATION_CONFIRM } from '../../js/services/validationCenter.js';
import { CONFIRM } from '../../server/validation/center.mjs';

const res = (status, body) => ({ ok: status < 300, status, json: async () => body });

describe('callValidation', () => {
  it('POST com Bearer do ID token e corpo { op, ...extra }', async () => {
    const seen = [];
    const fetch = async (url, init) => { seen.push({ url, init }); return res(200, { ok: true, seeded: false }); };
    const r = await callValidation('seed', { confirm: 'x' }, { fetch, getToken: async () => 'tok' });
    assert.equal(r.seeded, false);
    assert.equal(seen[0].url, '/api/validation');
    assert.equal(seen[0].init.headers.authorization, 'Bearer tok');
    assert.deepEqual(JSON.parse(seen[0].init.body), { op: 'seed', confirm: 'x' });
  });
  it('403/401/409 e falha de rede viram ValidationApiError com o código real do servidor', async () => {
    for (const [status, error] of [[403, 'FORBIDDEN'], [401, 'INVALID_TOKEN'], [409, 'ALREADY_SEEDED']]) {
      await assert.rejects(() => callValidation('status', {}, { fetch: async () => res(status, { ok: false, error, message: 'm' }), getToken: async () => 't' }),
        (e) => e instanceof ValidationApiError && e.status === status && e.code === error);
    }
    await assert.rejects(() => callValidation('status', {}, { fetch: async () => { throw new TypeError('x'); }, getToken: async () => 't' }), (e) => e.code === 'NETWORK_ERROR');
  });
  it('as frases de confirmação do cliente são as do servidor', () => {
    assert.deepEqual({ ...VALIDATION_CONFIRM }, { ...CONFIRM });
  });
});

describe('contrato de isolamento de /manutencao-dados', () => {
  const src = readFileSync(new URL('../../js/modules/manutencao-dados.js', import.meta.url), 'utf8');
  it('os painéis existentes mantêm a ordem e a Central só entra como ÚLTIMO item, atrás do gate de administrador', () => {
    assert.match(src, /cleanPanel, adminPanel, seedPanel, importPanel, await loadValidationCenter\(admin\)\);/);
    assert.match(src, /async function loadValidationCenter\(admin\) \{\s*if \(admin !== true\) return null;/);
    assert.match(src, /catch \(error\) \{[\s\S]*return null;/); // falha da Central nunca derruba a página
  });
  it('os serviços de manutenção existentes não importam nada da Central (sem acoplamento)', () => {
    for (const f of ['../../js/services/maintenance.js', '../../js/services/seed.js', '../../js/services/adminClaims.js', '../../js/services/importer.js']) {
      assert.doesNotMatch(readFileSync(new URL(f, import.meta.url), 'utf8'), /validation-center|validationCenter|api\/validation/);
    }
  });
});
