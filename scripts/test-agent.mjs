// Run with: npm run test:agent  (offline: checks tool-call -> proposal logic and guardrails)
import assert from 'node:assert/strict';

// The modules create a Supabase client at import time; placeholders are enough for offline tests.
process.env.SUPABASE_URL ||= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';
const { buildProposal, buildReminders } = await import('../api/_lib/agent-tools.js');
const { normalizeReceipt } = await import('../api/_lib/receipt.js');

const split = { owner_name: 'Sam', currency: 'USD', tax: 4.32, tip: 8.0 };
const items = [
  { name: 'Margherita Pizza', line_total: 14.0 },
  { name: 'Paneer Tikka', line_total: 11.5 },
  { name: 'Pasta Alfredo', line_total: 13.0 },
  { name: 'Garlic Bread', line_total: 6.5 },
  { name: 'Lemonade', line_total: 9.0 },
];
const total = 14 + 11.5 + 13 + 6.5 + 9 + 4.32 + 8;

// 1) Normal proposal: "me" alias, case differences, fuzzy item match
{
  const { proposal, error } = buildProposal({
    split, items,
    args: {
      people: ['asha', 'Ravi', 'Meera'], tax_tip_mode: 'proportional', explanation: 'x',
      assignments: [
        { item_name: 'margherita pizza', people: ['Asha', 'Ravi'] },
        { item_name: 'paneer', people: ['me'] },
        { item_name: 'Pasta', people: ['Meera'] },
      ],
    },
  });
  assert.equal(error, undefined);
  const sumReq = proposal.requests.reduce((a, r) => a + r.amount_cents, 0);
  assert.equal(sumReq + proposal.owner_share_cents, Math.round(total * 100), 'requests + owner share == total');
  assert.ok(!proposal.requests.some((r) => r.name === 'Sam'), 'owner is never charged');
  assert.deepEqual(proposal.requests.map((r) => r.name).sort(), ['Asha', 'Meera', 'Ravi']);
}

// 2) Owner paid but did not eat
{
  const { proposal } = buildProposal({ split, items, args: { people: ['A', 'B'], owner_participates: false, tax_tip_mode: 'equal', explanation: '' } });
  assert.equal(proposal.owner_share_cents, 0);
  assert.equal(proposal.requests.reduce((a, r) => a + r.amount_cents, 0), Math.round(total * 100));
}

// 3) Unknown item is reported, not silently dropped
{
  const { proposal } = buildProposal({ split, items, args: { people: ['A'], tax_tip_mode: 'equal', explanation: '', assignments: [{ item_name: 'Unicorn Steak', people: ['A'] }] } });
  assert.deepEqual(proposal.unmatched, ['Unicorn Steak']);
}

// 4) Guardrails
{
  const noOthers = buildProposal({ split, items, args: { people: [], tax_tip_mode: 'equal', explanation: '' } });
  assert.ok(noOthers.error, 'needs at least one other person');
  const tooMany = buildProposal({ split, items, args: { people: Array.from({ length: 20 }, (_, i) => `P${i}`), tax_tip_mode: 'equal', explanation: '' } });
  assert.match(tooMany.error, /at most/);
  const huge = buildProposal({ split: { ...split, tax: 0, tip: 0 }, items: [{ name: 'Gala dinner', line_total: 1200 }], args: { people: ['A'], tax_tip_mode: 'equal', explanation: '' } });
  assert.match(huge.error, /per-person limit/);
}

// 5) Reminders only match pending people and strip links
{
  const pending = [{ id: '1', name: 'Ravi', share: 10 }];
  const out = buildReminders({ args: { reminders: [
    { participant_name: 'ravi', message: 'Hey! pay at http://evil.example/x thanks' },
    { participant_name: 'Ghost', message: 'boo' },
  ] }, pending });
  assert.equal(out.length, 1);
  assert.ok(!/http/.test(out[0].message));
}

// 6) Receipt normalizer cleans junk and flags mismatched totals
{
  const r = normalizeReceipt({ is_receipt: true, venue: '  Cafe\n\u0000X  ', items: [{ name: 'Tea', quantity: 0, line_total: 3.456 }, { name: '', line_total: 5 }, { name: 'Free', line_total: 0 }], tax: -2, tip: 1, total: 99 });
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].line_total, 3.46);
  assert.equal(r.tax, 0);
  assert.equal(r.total_matches, false);
  assert.ok(!/[\n\u0000]/.test(r.venue));
}
console.log('agent-tools + receipt: all tests passed');
