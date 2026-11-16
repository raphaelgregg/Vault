/**
 * Dinheiro SEMPRE em centavos inteiros. Nenhum float em regra financeira.
 * Formatação apenas na borda de apresentação.
 */
import { CURRENCY, LOCALE } from './constants.js';

export function toCents(input) {
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) throw new Error('Valor inválido.');
    return Math.round(input * 100);
  }
  const raw = String(input ?? '').trim();
  if (!raw) throw new Error('Valor vazio.');
  // Aceita "1.234,56", "1234.56", "R$ 1.234,56", "-12,30"
  const negative = raw.startsWith('-');
  const digits = raw
    .replace(/[^\d.,]/g, '')
    .replace(/\.(?=\d{3}(\D|$))/g, '')
    .replace(',', '.');
  const value = Number(negative ? `-${digits}` : digits);
  if (!Number.isFinite(value)) throw new Error('Valor inválido.');
  return Math.round(value * 100);
}

export function fromCents(cents) {
  return (Number(cents) || 0) / 100;
}

export function formatBRL(cents, { withSymbol = true } = {}) {
  const value = fromCents(cents);
  return new Intl.NumberFormat(LOCALE, {
    style: withSymbol ? 'currency' : 'decimal',
    currency: CURRENCY,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

export function isValidCents(value, { allowNegative = false } = {}) {
  return Number.isInteger(value) && (allowNegative || value >= 0);
}
