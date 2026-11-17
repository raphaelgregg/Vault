/**
 * Testes do serviço de Categorias (Fase 3).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  getCategoryKindOptions,
} from '../../js/services/categories.js';
import { buildEntity } from '../../js/core/model.js';

describe('categories service — validação', () => {
  it('getCategoryKindOptions retorna tipos esperados', () => {
    const options = getCategoryKindOptions();
    assert.equal(options.length, 3);
    assert.deepEqual(options.map((o) => o.value), ['income', 'expense', 'both']);
  });

  it('buildEntity aceita categoria válida', () => {
    const valid = { name: 'Salário', kind: 'income', color: '#1f7a5c' };
    const { ok, data } = buildEntity('categories', valid);
    assert.ok(ok);
    assert.equal(data.name, 'Salário');
    assert.equal(data.kind, 'income');
  });

  it('buildEntity rejeita kind inválido', () => {
    const invalid = { name: 'Teste', kind: 'invalido', color: '#1f7a5c' };
    const { ok, errors } = buildEntity('categories', invalid);
    assert.ok(!ok);
    assert.ok(errors.kind);
  });

  it('buildEntity rejeita nome vazio', () => {
    const invalid = { name: '   ', kind: 'income', color: '#1f7a5c' };
    const { ok, errors } = buildEntity('categories', invalid);
    assert.ok(!ok);
    assert.ok(errors.name);
  });

  it('buildEntity rejeita nome > 60 caracteres', () => {
    const invalid = { name: 'x'.repeat(61), kind: 'income', color: '#1f7a5c' };
    const { ok, errors } = buildEntity('categories', invalid);
    assert.ok(!ok);
    assert.ok(errors.name);
  });
});