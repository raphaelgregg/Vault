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
