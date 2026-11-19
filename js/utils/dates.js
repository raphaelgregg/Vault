/**
 * Datas: timestamps do Firestore no banco, formato brasileiro na tela.
 * Day.js é carregado via CDN nos HTMLs; aqui só helpers de apresentação.
 */
import { LOCALE } from './constants.js';

export function toDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof value?.toDate === 'function') return value.toDate(); // Timestamp do Firestore
  if (typeof value === 'object' && typeof value.seconds === 'number') {
    return new Date(value.seconds * 1000);
  }
  return new Date(value);
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Campos de data gravados como Timestamp: `date`, qualquer `*Date` (expectedDate, dueDate, loanDate…)
 * e as exceções declaradas em `DATE_FIELD_EXCEPTIONS` (`deadline` de metas, `paidAt` de faturas — VF-2-03q).
 * createdAt/updatedAt são do servidor e ficam de fora. Texto livre (description, notes…) nunca é
 * convertido. Toda entrada de `SCHEMAS[*].dateFields` DEVE ser reconhecida aqui (há teste): `deadline`
 * não era, e a meta com prazo ia como string e era negada pelas Rules (`permission-denied`).
 */
const DATE_FIELD_EXCEPTIONS = Object.freeze(['deadline', 'paidAt']);
export function isDateFieldName(key) {
  return key === 'date' || /Date$/.test(key) || DATE_FIELD_EXCEPTIONS.includes(key);
}

/** "YYYY-MM-DD" de calendário real → Date; caso contrário null. Puro. */
export function parseIsoDate(value) {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return null;
  const [y, m, d] = value.split('-').map(Number);
  // Meio-dia UTC: o dia de calendário é o mesmo em qualquer fuso (UTC−12…UTC+12),
  // independente do fuso do navegador. Leitura correspondente: dateToIsoDate (UTC).
  const probe = new Date(Date.UTC(y, m - 1, d, 12));
  const valid = probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
  return valid ? probe : null;
}

/** Date/Timestamp → "YYYY-MM-DD" do dia de calendário em UTC (inverso de parseIsoDate). */
export function dateToIsoDate(value) {
  const date = toDate(value);
  return date && !Number.isNaN(date.getTime()) ? date.toISOString().slice(0, 10) : null;
}

export function formatDateBR(value) {
  const date = toDate(value);
  if (!date || Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(LOCALE, { dateStyle: 'short' }).format(date);
}

export function formatMonthBR(value) {
  const date = toDate(value);
  if (!date || Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(LOCALE, { month: 'long', year: 'numeric' }).format(date);
}

export function startOfMonth(date = new Date()) {
  return new Date(date.getFullYear(), date.getMonth(), 1, 0, 0, 0, 0);
}

export function currentMonthKey(date = new Date()) {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  return `${date.getFullYear()}-${month}`;
}

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** "YYYY-MM" → { start: "YYYY-MM-01", end: "YYYY-MM-<último dia>" }; null se inválido. Puro. */
export function monthBounds(month) {
  const m = MONTH_RE.exec(month ?? '');
  if (!m) return null;
  const last = new Date(Date.UTC(Number(m[1]), Number(m[2]), 0, 12)).getUTCDate();
  return { start: `${month}-01`, end: `${month}-${String(last).padStart(2, '0')}` };
}

/** Lista "YYYY-MM" de `from` a `to` (inclusive, máx. 120); [] se inválido ou invertido. Puro. */
export function monthsBetween(from, to) {
  if (!MONTH_RE.test(from ?? '') || !MONTH_RE.test(to ?? '') || from > to) return [];
  const out = [];
  let [y, m] = from.split('-').map(Number);
  while (out.length < 120) {
    const key = `${y}-${String(m).padStart(2, '0')}`;
    out.push(key);
    if (key === to) break;
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out;
}
