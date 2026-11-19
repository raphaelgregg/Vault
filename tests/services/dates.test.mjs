/**
 * VF-3-03 — conversão de datas ISO <-> Timestamp (firestore.js) e utilitários puros.
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { toFirestoreData, fromFirestoreDoc, Timestamp } from '../../js/services/firestore.js';
import { isDateFieldName, parseIsoDate, dateToIsoDate } from '../../js/utils/dates.js';
import { isValidIsoDate, SCHEMAS, buildEntity } from '../../js/core/model.js';

const ORIGINAL_TZ = process.env.TZ;
afterEach(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

describe('campos de data dos schemas × conversão para Timestamp (VF-2-03q)', () => {
  it('TODO campo em SCHEMAS[*].dateFields é reconhecido por isDateFieldName (senão vai como string e as Rules negam)', () => {
    for (const [kind, schema] of Object.entries(SCHEMAS)) {
      for (const field of schema.dateFields ?? []) assert.equal(isDateFieldName(field), true, `${kind}.${field}`);
    }
  });
  it('meta com prazo e fatura paga viram Timestamp ao gravar e voltam como ISO ao ler', () => {
    const goal = buildEntity('goals', { name: 'Caixinha', targetCents: '1.000,00', deadline: '2027-01-10', accountId: 'a1', status: 'active' });
    assert.equal(goal.ok, true);
    const stored = toFirestoreData(goal.data);
    assert.equal(typeof stored.deadline.toDate, 'function'); // Timestamp (antes: string → permission-denied)
    assert.equal(stored.deadline.toDate().toISOString(), '2027-01-10T12:00:00.000Z');
    assert.equal(fromFirestoreDoc('g1', stored).deadline, '2027-01-10');
    const paid = toFirestoreData({ status: 'paid', paidAt: '2026-11-20' });
    assert.equal(typeof paid.paidAt.toDate, 'function');
    assert.equal(fromFirestoreDoc('i1', paid).paidAt, '2026-11-20');
  });
});

describe('utils/dates — parse e campos de data', () => {
  it('isDateFieldName reconhece date e *Date, não texto livre nem carimbos de servidor', () => {
    for (const key of ['date', 'dueDate', 'expectedDate', 'loanDate', 'nextChargeDate']) {
      assert.equal(isDateFieldName(key), true, key);
    }
    for (const key of ['description', 'notes', 'reason', 'createdAt', 'updatedAt', 'referenceMonth', 'dateNote']) {
      assert.equal(isDateFieldName(key), false, key);
    }
  });

  it('parseIsoDate aceita datas reais e rejeita inexistentes/formatos errados', () => {
    assert.equal(parseIsoDate('2026-02-28')?.toISOString(), '2026-02-28T12:00:00.000Z');
    assert.equal(parseIsoDate('2028-02-29')?.toISOString(), '2028-02-29T12:00:00.000Z'); // bissexto
    for (const bad of ['2026-02-29', '2026-13-01', '2026-00-10', '2026-04-31', '26-01-01',
      '2026-1-1', '2026-01-01T00:00:00Z', '', null, undefined, 20260101]) {
      assert.equal(parseIsoDate(bad), null, String(bad));
    }
  });

  it('isValidIsoDate (modelo) continua com o mesmo contrato', () => {
    assert.equal(isValidIsoDate('2026-11-18'), true);
    assert.equal(isValidIsoDate('2026-02-30'), false);
    assert.equal(isValidIsoDate('18/11/2026'), false);
  });
});

describe('toFirestoreData', () => {
  it('converte só campos de data; description/notes com formato de data permanecem string', () => {
    const out = toFirestoreData({
      description: '2026-11-18',
      notes: '2026-01-01',
      reason: '2026-05-05',
      dueDate: '2026-11-20',
      date: '2026-11-16',
      amountCents: 100,
    });
    assert.equal(out.description, '2026-11-18');
    assert.equal(out.notes, '2026-01-01');
    assert.equal(out.reason, '2026-05-05');
    assert.ok(out.dueDate instanceof Timestamp);
    assert.ok(out.date instanceof Timestamp);
    assert.equal(out.amountCents, 100);
  });

  it('não toca em valores que não são string (Timestamp, null, undefined)', () => {
    const ts = Timestamp.fromDate(new Date('2026-01-01T12:00:00Z'));
    const out = toFirestoreData({ dueDate: ts, paidDate: null, receivedDate: undefined });
    assert.equal(out.dueDate, ts);
    assert.equal(out.paidDate, null);
    assert.equal(out.receivedDate, undefined);
  });

  it('data inválida em campo de data lança RangeError (nunca grava string)', () => {
    assert.throws(() => toFirestoreData({ dueDate: '2026-02-31' }), RangeError);
    assert.throws(() => toFirestoreData({ date: '18/11/2026' }), /"date"/);
    assert.throws(() => toFirestoreData({ paidDate: '' }), RangeError);
  });
});

describe('ida e volta sem deslocamento de dia, em qualquer fuso', () => {
  const zones = ['UTC', 'America/Sao_Paulo', 'America/Los_Angeles', 'Pacific/Pago_Pago',
    'Pacific/Kiritimati', 'Asia/Kolkata', 'Pacific/Auckland'];
  const days = ['2026-01-01', '2026-02-28', '2026-03-08', '2026-10-25', '2026-12-31', '2028-02-29'];

  for (const tz of zones) {
    it(`${tz}: ISO -> Timestamp -> ISO preserva o dia`, () => {
      process.env.TZ = tz;
      for (const day of days) {
        const { dueDate } = toFirestoreData({ dueDate: day });
        assert.equal(dueDate.toDate().toISOString(), `${day}T12:00:00.000Z`);
        assert.equal(fromFirestoreDoc('x', { dueDate }).dueDate, day, `${tz} ${day}`);
      }
    });
  }

  it('lê dados legados gravados como meio-dia local (UTC−3) no mesmo dia', () => {
    const legacy = Timestamp.fromDate(new Date('2026-11-20T15:00:00Z')); // 12:00 em São Paulo
    assert.equal(fromFirestoreDoc('x', { dueDate: legacy }).dueDate, '2026-11-20');
  });
});

describe('fromFirestoreDoc', () => {
  it('converte campos de data; mantém createdAt/updatedAt e texto intactos', () => {
    const ts = Timestamp.fromDate(new Date('2026-11-20T12:00:00Z'));
    const created = Timestamp.fromDate(new Date('2026-11-21T03:00:00Z'));
    const out = fromFirestoreDoc('d1', {
      date: ts, expectedDate: ts, createdAt: created, updatedAt: created,
      description: '2026-11-20', stamp: ts,
    });
    assert.equal(out.id, 'd1');
    assert.equal(out.date, '2026-11-20');
    assert.equal(out.expectedDate, '2026-11-20');
    assert.equal(out.createdAt, created);
    assert.equal(out.updatedAt, created);
    assert.equal(out.description, '2026-11-20');
    assert.equal(out.stamp, ts);
  });

  it('dateToIsoDate trata Date, Timestamp e entrada inválida', () => {
    assert.equal(dateToIsoDate(new Date('2026-05-05T12:00:00Z')), '2026-05-05');
    assert.equal(dateToIsoDate(Timestamp.fromDate(new Date('2026-05-05T12:00:00Z'))), '2026-05-05');
    assert.equal(dateToIsoDate(null), null);
    assert.equal(dateToIsoDate(new Date('nope')), null);
  });
});
