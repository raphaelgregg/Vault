/**
 * Referência de data = America/Sao_Paulo (UTC−3, sem horário de verão desde 2019). Instantes próximos da meia-noite UTC
 * e da virada de dia no Brasil: 00:00Z = 21:00 em Brasília (dia anterior); 03:00Z = 00:00 em Brasília (dia novo).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { todayInAppZone, currentMonthKey, parseIsoDate, dateToIsoDate, monthBounds, APP_TIME_ZONE } from '../../js/utils/dates.js';
import { todayParts, loadDashboard } from '../../js/services/dashboard.js';
import { monthlyForecast } from '../../js/core/forecast.js';
import { accountBalances, applyGoalTransaction } from '../../js/core/model.js';
import { upcomingDue, monthResult } from '../../js/core/aggregates.js';
import { closeInvoice } from '../../js/services/creditCards.js';

const at = (iso) => new Date(iso);

describe('todayInAppZone — dia civil de Brasília', () => {
  it('fuso explícito', () => assert.equal(APP_TIME_ZONE, 'America/Sao_Paulo'));

  it('meia-noite UTC e virada de dia no Brasil', () => {
    const cases = [
      ['2026-11-19T23:59:59Z', '2026-11-19'], // 20:59:59 BRT
      ['2026-11-20T00:00:00Z', '2026-11-19'], // 21:00 BRT — UTC já é dia 20 (o bug antigo)
      ['2026-11-20T00:30:00Z', '2026-11-19'], // 21:30 BRT
      ['2026-11-20T02:59:59Z', '2026-11-19'], // 23:59:59 BRT
      ['2026-11-20T03:00:00Z', '2026-11-20'], // 00:00 BRT — dia novo
      ['2026-11-20T12:00:00Z', '2026-11-20'], // meio-dia UTC (convenção de armazenamento) = 09:00 BRT
    ];
    for (const [instant, expected] of cases) assert.equal(todayInAppZone(at(instant)), expected, instant);
  });

  it('virada de mês', () => {
    assert.equal(todayInAppZone(at('2026-12-01T02:59:59Z')), '2026-11-30');
    assert.equal(todayInAppZone(at('2026-12-01T03:00:00Z')), '2026-12-01');
    assert.equal(currentMonthKey(at('2026-12-01T01:00:00Z')), '2026-11'); // UTC já seria dezembro
    assert.equal(currentMonthKey(at('2026-12-01T03:00:00Z')), '2026-12');
  });

  it('virada de ano e fevereiro bissexto', () => {
    assert.equal(todayInAppZone(at('2027-01-01T00:00:00Z')), '2026-12-31');
    assert.equal(todayInAppZone(at('2027-01-01T02:59:59Z')), '2026-12-31');
    assert.equal(todayInAppZone(at('2027-01-01T03:00:00Z')), '2027-01-01');
    assert.equal(currentMonthKey(at('2027-01-01T01:00:00Z')), '2026-12');
    assert.equal(todayInAppZone(at('2028-03-01T02:00:00Z')), '2028-02-29');
    assert.equal(todayInAppZone(at('2028-03-01T03:00:00Z')), '2028-03-01');
  });

  it('todayParts (dashboard) usa a mesma referência', () => {
    assert.deepEqual(todayParts(at('2026-11-20T00:30:00Z')), { today: '2026-11-19', month: '2026-11' });
    assert.deepEqual(todayParts(at('2027-01-01T01:00:00Z')), { today: '2026-12-31', month: '2026-12' });
  });
});

describe('classificação de vencimentos depois das 21h em Brasília', () => {
  const e = (id, dueDate, status = 'pending') => ({ id, description: id, dueDate, amountCents: 1000, status });
  const classify = (instant, extra = {}) => {
    const { today, month } = todayParts(at(instant));
    return monthlyForecast({ month, today, expenses: [e('hoje', '2026-11-19'), e('ontem', '2026-11-18'), e('amanha', '2026-11-20')], ...extra });
  };

  it('às 21:30 BRT (00:30Z do dia 20) a despesa que vence HOJE (19) NÃO está vencida', () => {
    const f = classify('2026-11-20T00:30:00Z');
    assert.equal(f.expenses.overdueCents, 1000); // só "ontem" (18/11)
    assert.equal(f.expenses.upcomingCents, 2000); // hoje (19) + amanhã (20)
  });

  it('com UTC o resultado seria diferente (regressão do bug): às 03:00Z do dia 20 passa a vencer', () => {
    const f = classify('2026-11-20T03:00:00Z');
    assert.equal(f.expenses.overdueCents, 2000); // 18 e 19 vencidas
    assert.equal(f.expenses.upcomingCents, 1000); // só a do dia 20
  });

  it('vencidas de mês anterior na virada de mês (BR ainda em novembro, UTC já em dezembro)', () => {
    const { today, month } = todayParts(at('2026-12-01T01:00:00Z'));
    assert.deepEqual([today, month], ['2026-11-30', '2026-11']);
    const f = monthlyForecast({ month, today, expenses: [e('ult', '2026-11-30'), e('out', '2026-10-31')] });
    assert.deepEqual([f.expenses.overdueCents, f.expenses.upcomingCents, f.expenses.plannedCents], [1000, 1000, 1000]);
  });

  it('virada de ano: 22:00 BRT de 31/12 ainda é dezembro; despesa de 31/12 não vencida', () => {
    const { today, month } = todayParts(at('2027-01-01T01:00:00Z'));
    const f = monthlyForecast({ month, today, expenses: [e('ano', '2026-12-31'), e('ja', '2026-12-30'), e('jan', '2027-01-05')] });
    assert.deepEqual([today, month], ['2026-12-31', '2026-12']);
    assert.deepEqual([f.expenses.overdueCents, f.expenses.upcomingCents, f.expenses.plannedCents], [1000, 1000, 2000]);
    assert.equal(f.nextMonths[0].month, '2027-01');
    assert.equal(f.nextMonths[0].expensesCents, 1000);
  });

  it('receitas previstas: a de hoje (BR) não é atrasada às 21:30 BRT; passa a ser às 00:00 BRT', () => {
    const inc = [{ id: 'i', status: 'pending', expectedDate: '2026-11-19', amountCents: 5000 }];
    const before = monthlyForecast({ month: '2026-11', today: todayParts(at('2026-11-20T00:30:00Z')).today, pendingIncomes: inc });
    const after = monthlyForecast({ month: '2026-11', today: todayParts(at('2026-11-20T03:00:00Z')).today, pendingIncomes: inc });
    assert.deepEqual([before.incomes.pendingCents, before.incomes.overdueCents], [5000, 0]);
    assert.deepEqual([after.incomes.pendingCents, after.incomes.overdueCents], [5000, 5000]);
  });

  it('próximos vencimentos: o que vence hoje (BR) continua na lista às 21:30 BRT', () => {
    const { today } = todayParts(at('2026-11-20T00:30:00Z'));
    const items = upcomingDue({ expenses: [e('hoje', '2026-11-19')], today });
    assert.deepEqual(items.map((i) => i.label), ['hoje']);
  });

  it('loadDashboard: mês padrão e isCurrentMonth seguem o dia de Brasília', async () => {
    const io = { list: async () => [], now: () => at('2026-12-01T01:00:00Z') };
    const d = await loadDashboard('u', io);
    assert.equal(d.month, '2026-11');
    assert.equal(d.isCurrentMonth, true);
    const d2 = await loadDashboard('u', { ...io, now: () => at('2026-12-01T03:00:00Z') });
    assert.equal(d2.month, '2026-12');
  });

  it('fechamento de fatura: no dia do fechamento em Brasília, mesmo que o UTC já seja o dia seguinte', async () => {
    const make = (instant) => {
      const calls = [];
      return { calls, io: {
        now: () => at(instant),
        getById: async () => ({ id: 'f', status: 'open', closingDate: '2026-11-20' }),
        list: async () => [], update: async (_u, _c, _id, d) => { calls.push(d); }, writeAudit: async () => {},
      } };
    };
    const early = make('2026-11-20T02:59:59Z'); // 23:59:59 BRT de 19/11: ainda não fechou
    assert.equal((await closeInvoice('u', 'f', early.io)).ok, false);
    const ok = make('2026-11-20T03:00:00Z'); // 00:00 BRT de 20/11
    assert.equal((await closeInvoice('u', 'f', ok.io)).ok, true);
  });
});

describe('datas de abertura e persistência (sem alteração)', () => {
  it('data de abertura é só-dia: comparação de strings, independente de fuso', () => {
    const account = { id: 'a', initialBalanceCents: 1000, openingDate: '2026-11-19' };
    const b = accountBalances([account], { incomes: [
      { accountId: 'a', status: 'received', amountCents: 100, receivedDate: '2026-11-18' }, // antes: já no saldo de abertura
      { accountId: 'a', status: 'received', amountCents: 200, receivedDate: '2026-11-19' }, // no dia: conta
    ] });
    assert.equal(b.get('a'), 1200);
    // "hoje" às 21:30 BRT (00:30Z de 20/11) é 19/11: abrir a conta "hoje" e receber "hoje" conta
    assert.equal(todayInAppZone(at('2026-11-20T00:30:00Z')), account.openingDate);
  });

  it('persistência inalterada: meio-dia UTC, ida e volta preserva o dia', () => {
    const parsed = parseIsoDate('2026-11-19');
    assert.equal(parsed.toISOString(), '2026-11-19T12:00:00.000Z');
    assert.equal(dateToIsoDate(parsed), '2026-11-19');
    assert.deepEqual(monthBounds('2026-12'), { start: '2026-12-01', end: '2026-12-31' });
  });

  it('resultado do mês e saldo continuam usando só as datas gravadas (nenhum "agora")', () => {
    const r = monthResult([{ status: 'received', receivedDate: '2026-11-30', amountCents: 10 }, { status: 'received', receivedDate: '2026-12-01', amountCents: 5 }], [], '2026-11');
    assert.equal(r.incomeCents, 10);
    assert.equal(applyGoalTransaction({ status: 'active', targetCents: 10 }, 0, 'deposit', 5).ok, true);
  });
});
