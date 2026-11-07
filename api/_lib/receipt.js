import { sanitizeText } from './http.js';

export const CURRENCIES = ['USD', 'EUR', 'GBP', 'CAD', 'AUD'];

export const RECEIPT_SCHEMA = {
  type: 'object',
  properties: {
    is_receipt: { type: 'boolean' },
    venue: { type: 'string' },
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          quantity: { type: 'number' },
          line_total: { type: 'number' },
        },
        required: ['name', 'quantity', 'line_total'],
      },
    },
    subtotal: { type: 'number' },
    tax: { type: 'number' },
    tip: { type: 'number' },
    total: { type: 'number' },
  },
  required: ['is_receipt', 'venue', 'items', 'subtotal', 'tax', 'tip', 'total'],
};

export const toCents = (n) => Math.round((Number(n) || 0) * 100);

// Turns untrusted input (model output OR user-edited form) into clean, bounded numbers.
export function normalizeReceipt(raw) {
  const items = (Array.isArray(raw?.items) ? raw.items : [])
    .slice(0, 60)
    .map((i) => ({
      name: sanitizeText(i?.name, 80),
      quantity: Math.min(99, Math.max(1, Math.round(Number(i?.quantity) || 1))),
      line_cents: Math.max(0, toCents(i?.line_total)),
    }))
    .filter((i) => i.name && i.line_cents > 0);

  const taxCents = Math.max(0, toCents(raw?.tax));
  const tipCents = Math.max(0, toCents(raw?.tip));
  const subtotalCents = items.reduce((a, i) => a + i.line_cents, 0);
  const totalCents = subtotalCents + taxCents + tipCents;
  const parsedTotalCents = toCents(raw?.total);

  return {
    is_receipt: raw?.is_receipt !== false && items.length > 0,
    venue: sanitizeText(raw?.venue, 80),
    items: items.map((i) => ({ name: i.name, quantity: i.quantity, line_total: i.line_cents / 100 })),
    subtotal: subtotalCents / 100,
    tax: taxCents / 100,
    tip: tipCents / 100,
    total: totalCents / 100,
    total_cents: totalCents,
    total_matches: parsedTotalCents === 0 || Math.abs(parsedTotalCents - totalCents) <= 2,
  };
}
