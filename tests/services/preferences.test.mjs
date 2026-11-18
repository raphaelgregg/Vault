/**
 * Testes do serviço de preferências (VF-2-02): perfil, configurações e tema.
 * Executar: node --test tests/services/preferences.test.mjs
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateSettings,
  validateProfile,
  defaultProfileName,
  getSettings,
  getProfile,
  saveSettings,
  saveProfile,
} from '../../js/services/preferences.js';
import { resolveTheme } from '../../js/components/theme.js';

const uid = 'u1';
const STAMP = Symbol('serverTimestamp');

function makeIo({ settings = null, profile = null } = {}) {
  const calls = { save: [], audit: [], get: [] };
  return {
    calls,
    io: {
      now: () => STAMP,
      getSingleton: async (_u, collection) => {
        calls.get.push(collection);
        return collection === 'settings' ? settings : profile;
      },
      saveSingleton: async (_u, collection, data, docId) => { calls.save.push({ collection, data, docId }); },
      writeAudit: async (_u, entry) => { calls.audit.push(entry); },
    },
  };
}

describe('validateSettings', () => {
  it('aceita tema, hideValues e firstWeekday válidos', () => {
    const r = validateSettings({ theme: 'dark', hideValues: true, firstWeekday: 1 });
    assert.ok(r.ok);
    assert.deepEqual(r.data, { theme: 'dark', hideValues: true, firstWeekday: 1 });
  });
  it('rejeita tema, booleano e dia fora do domínio', () => {
    assert.equal(validateSettings({ theme: 'blue' }).errors.theme, 'Tema inválido.');
    assert.ok(validateSettings({ hideValues: 'yes' }).errors.hideValues);
    for (const d of [-1, 7, 1.5, '2']) assert.ok(validateSettings({ firstWeekday: d }).errors.firstWeekday, String(d));
  });
  it('ignora campos desconhecidos (schema fechado)', () => {
    assert.deepEqual(validateSettings({ theme: 'light', createdAt: 1, extra: 1 }).data, { theme: 'light' });
  });
});

describe('validateProfile', () => {
  it('faz trim e aceita nome válido', () => {
    assert.deepEqual(validateProfile({ name: '  Ana  ' }).data, { name: 'Ana' });
  });
  it('rejeita nome vazio, longo e e-mail vazio', () => {
    assert.ok(validateProfile({ name: '   ' }).errors.name);
    assert.ok(validateProfile({ name: 'x'.repeat(81) }).errors.name);
    assert.ok(validateProfile({ email: '' }).errors.email);
  });
  it('não aceita currency/locale do cliente', () => {
    assert.deepEqual(validateProfile({ name: 'A', currency: 'USD', locale: 'en' }).data, { name: 'A' });
  });
  it('defaultProfileName deriva do e-mail', () => {
    assert.equal(defaultProfileName('ana@x.com'), 'ana');
    assert.equal(defaultProfileName(''), 'Usuário');
  });
});

describe('leitura', () => {
  it('getSettings/getProfile leem o documento main', async () => {
    const { io, calls } = makeIo({ settings: { theme: 'dark' }, profile: { name: 'Ana' } });
    assert.deepEqual(await getSettings(uid, io), { theme: 'dark' });
    assert.deepEqual(await getProfile(uid, io), { name: 'Ana' });
    assert.deepEqual(calls.get, ['settings', 'profile']);
  });
  it('retorna null quando não existem', async () => {
    const { io } = makeIo();
    assert.equal(await getSettings(uid, io), null);
  });
});

describe('saveSettings', () => {
  it('cria com createdAt e audita create', async () => {
    const { io, calls } = makeIo();
    const r = await saveSettings(uid, { theme: 'dark' }, io);
    assert.ok(r.ok);
    assert.deepEqual(calls.save[0], {
      collection: 'settings',
      docId: 'main',
      data: { theme: 'dark', createdAt: STAMP },
    });
    assert.equal(calls.audit[0].action, 'create');
    assert.equal(calls.audit[0].docId, 'main');
    assert.ok(!('createdAt' in calls.audit[0].after));
  });
  it('na criação sem tema usa "system" (exigido pelas Rules)', async () => {
    const { io, calls } = makeIo();
    await saveSettings(uid, { hideValues: true }, io);
    assert.equal(calls.save[0].data.theme, 'system');
  });
  it('atualiza sem reenviar createdAt e audita update', async () => {
    const { io, calls } = makeIo({ settings: { theme: 'light', createdAt: 1 } });
    await saveSettings(uid, { theme: 'dark' }, io);
    assert.deepEqual(calls.save[0].data, { theme: 'dark' });
    assert.equal(calls.audit[0].action, 'update');
  });
  it('dado inválido não lê, grava nem audita', async () => {
    const { io, calls } = makeIo();
    const r = await saveSettings(uid, { theme: 'neon' }, io);
    assert.equal(r.ok, false);
    assert.ok(r.errors.theme);
    assert.equal(calls.get.length + calls.save.length + calls.audit.length, 0);
  });
  it('patch vazio é rejeitado', async () => {
    const { io, calls } = makeIo();
    assert.equal((await saveSettings(uid, {}, io)).ok, false);
    assert.equal(calls.save.length, 0);
  });
});

describe('saveProfile', () => {
  it('cria com e-mail do Auth, nome padrão, BRL/pt-BR e createdAt', async () => {
    const { io, calls } = makeIo();
    const r = await saveProfile(uid, { email: 'ana@x.com' }, io);
    assert.ok(r.ok);
    assert.deepEqual(calls.save[0].data, {
      name: 'ana', email: 'ana@x.com', currency: 'BRL', locale: 'pt-BR', createdAt: STAMP,
    });
    assert.equal(calls.audit[0].action, 'create');
  });
  it('atualiza só o nome e ignora tentativa de trocar e-mail', async () => {
    const { io, calls } = makeIo({ profile: { name: 'Ana', email: 'ana@x.com' } });
    const r = await saveProfile(uid, { name: ' Ana Maria ', email: 'outro@x.com' }, io);
    assert.ok(r.ok);
    assert.deepEqual(calls.save[0].data, { name: 'Ana Maria' });
    assert.equal(calls.audit[0].action, 'update');
  });
  it('rejeita nome vazio sem gravar', async () => {
    const { io, calls } = makeIo({ profile: { name: 'Ana' } });
    const r = await saveProfile(uid, { name: '  ' }, io);
    assert.equal(r.ok, false);
    assert.ok(r.errors.name);
    assert.equal(calls.save.length, 0);
    assert.equal(calls.audit.length, 0);
  });
  it('criação sem e-mail é rejeitada', async () => {
    const { io, calls } = makeIo();
    const r = await saveProfile(uid, { name: 'Ana' }, io);
    assert.equal(r.ok, false);
    assert.ok(r.errors.email);
    assert.equal(calls.save.length, 0);
  });
});

describe('resolveTheme', () => {
  it('respeita light/dark e resolve system pelo SO', () => {
    assert.equal(resolveTheme('light', true), 'light');
    assert.equal(resolveTheme('dark', false), 'dark');
    assert.equal(resolveTheme('system', true), 'dark');
    assert.equal(resolveTheme('system', false), 'light');
    assert.equal(resolveTheme('lixo', true), 'dark');
  });
});
