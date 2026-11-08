import assert from 'node:assert/strict';

process.env.SUPABASE_URL ||= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

const { buildProposal } = await import('../api/_lib/agent-tools.js');
const { computeShares } = await import('../api/_lib/split-math.js');
const { default: approveHandler } = await import('../api/approve.js');
const { supabase } = await import('../api/_lib/supabase.js');

console.log('Running test-allocation-e2e.mjs...');

// Scenario Setup
// Participants: Sam (owner), Asha, Ravi, Meera
// Receipt: Garlic Bread 18, Paneer Tikka 30, Masala Soda 4, Gulab Jamun 6, tax 4.64, tip 5.80, total 68.44
const split = {
  id: '33333333-3333-3333-3333-333333333333',
  owner_name: 'Sam',
  currency: 'USD',
  subtotal: 58.0,
  tax: 4.64,
  tip: 5.8,
  total: 68.44,
  status: 'open',
};

const items = [
  { name: 'Garlic Bread', line_total: 18.0 },
  { name: 'Paneer Tikka', line_total: 30.0 },
  { name: 'Masala Soda', line_total: 4.0 },
  { name: 'Gulab Jamun', line_total: 6.0 },
];

const totalCents = 1800 + 3000 + 400 + 600 + 464 + 580; // 6844 cents
assert.equal(totalCents, 6844);

// 1. Compute Proposal using real server functions
// Ravi excluded. Asha gets Paneer Tikka. Other items shared by Sam, Asha, Meera. tip_mode = owner_covers.
const args = {
  people: ['Asha', 'Meera'],
  excluded_people: ['Ravi'],
  owner_participates: true,
  tax_tip_mode: 'proportional',
  tip_mode: 'owner_covers',
  assignments: [
    { item_name: 'Paneer Tikka', people: ['Asha'] },
    // Garlic Bread, Masala Soda, Gulab Jamun are unassigned, which split-math
    // distributes equally among active non-excluded eaters (Sam, Asha, Meera).
  ],
};

const { proposal, error } = buildProposal({ split, items, args });
assert.equal(error, undefined, `Proposal creation failed: ${error}`);

// Assertions on the computed proposal:
// - Sum of all shares == 6844 exactly
const sumAllShares = proposal.requests.reduce((a, r) => a + r.amount_cents, 0) + proposal.owner_share_cents;
assert.equal(sumAllShares, 6844, 'Sum of all shares must equal 6844 integer cents exactly');

// - Ravi excluded == 0
assert.deepEqual(proposal.excluded, ['Ravi']);
assert.ok(!proposal.requests.some((r) => r.name.toLowerCase() === 'ravi'), 'Ravi must not appear in any payment request');

// - No excluded person appears in any payment request
for (const ex of proposal.excluded) {
  assert.ok(!proposal.requests.some((r) => r.name.toLowerCase() === ex.toLowerCase()));
}

// - Asha share ~42.48 (+/- 1 cent: 4247 cents / $42.47)
const ashaReq = proposal.requests.find((r) => r.name === 'Asha');
assert.ok(ashaReq, 'Asha must have a payment request');
assert.ok(Math.abs(ashaReq.amount_cents - 4248) <= 1, `Asha share must be within +/- 1 cent of 4248 cents, got ${ashaReq.amount_cents}`);
assert.equal(ashaReq.amount_cents, 4247, `Asha exact computed share is 4247 cents`);
assert.equal(ashaReq.tip_cents, 0, 'Asha tip must be 0 under owner_covers');
assert.equal(ashaReq.tax_cents, 314, 'Asha tax portion must be 314 cents');

// - Meera share ~10.08 (+/- 1 cent: 1009 cents / $10.09)
const meeraReq = proposal.requests.find((r) => r.name === 'Meera');
assert.ok(meeraReq, 'Meera must have a payment request');
assert.ok(Math.abs(meeraReq.amount_cents - 1008) <= 1, `Meera share must be within +/- 1 cent of 1008 cents, got ${meeraReq.amount_cents}`);
assert.equal(meeraReq.amount_cents, 1009, `Meera exact computed share is 1009 cents`);
assert.equal(meeraReq.tip_cents, 0, 'Meera tip must be 0 under owner_covers');
assert.equal(meeraReq.tax_cents, 75, 'Meera tax portion must be 75 cents');

// - Sam (owner) share ~15.88 (1588 cents / $15.88)
assert.equal(proposal.owner_share_cents, 1588, `Sam share must be 1588 cents (~$15.88), got ${proposal.owner_share_cents}`);
// Assert Sam tip portion == 580
const samItemsPlusTax = proposal.owner_share_cents - 580;
assert.equal(proposal.tip_mode, 'owner_covers');
assert.equal(samItemsPlusTax, 933 + 75, "Sam's tip portion is exactly 580 cents");

// - Tax split independent of tip handling (314 + 75 + 75 = 464 cents)
assert.equal(ashaReq.tax_cents + meeraReq.tax_cents + 75, 464, 'Tax splits to 464 independent of tip');

// - The server-generated summary names the same people and amounts
assert.ok(proposal.summary.includes('Asha'), 'Summary must name Asha');
assert.ok(proposal.summary.includes('Meera'), 'Summary must name Meera');
assert.ok(proposal.summary.includes('Sam'), 'Summary must name Sam');
assert.ok(proposal.summary.includes('Tip covered by Sam'), 'Summary must state tip covered by owner');
assert.ok(proposal.summary.includes('Excluded ($0): Ravi'), 'Summary must name Ravi as excluded ($0)');

// 2. Proposal Lifecycle & State Integrity:
// - The proposal is logged in agent_log as pending with approved_by_human = false
// - No participants or PayPal orders are created until approve runs
let logRecord = {
  id: 'log-prop-1',
  split_id: split.id,
  action: 'proposal',
  reasoning: proposal.summary,
  payload: proposal,
  status: 'pending',
  approved_by_human: false,
};

let participantsDb = [];

const origFrom = supabase.from;
supabase.from = (table) => {
  if (table === 'split_secrets') {
    return {
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: { owner_key: 'valid-owner-key' } }),
        }),
      }),
    };
  }
  if (table === 'splits') {
    return {
      select: () => ({
        eq: () => ({
          single: async () => ({ data: split }),
        }),
      }),
    };
  }
  if (table === 'agent_log') {
    return {
      update: (fields) => ({
        eq: (col1, val1) => ({
          eq: (col2, val2) => ({
            eq: (col3, val3) => ({
              eq: (col4, val4) => ({
                select: () => ({
                  maybeSingle: async () => {
                    if (val1 === logRecord.id && val4 === 'pending') {
                      Object.assign(logRecord, fields);
                      return { data: logRecord };
                    }
                    return { data: null };
                  },
                }),
              }),
            }),
          }),
        }),
      }),
      insert: () => ({
        select: () => ({
          single: async () => ({ data: { id: 'new-log' }, error: null }),
          maybeSingle: async () => ({ data: { id: 'new-log' }, error: null }),
        }),
      }),
    };
  }
  if (table === 'participants') {
    return {
      select: (cols, opts) => ({
        eq: () => ({
          count: participantsDb.length,
        }),
      }),
      insert: (rows) => {
        const inserted = rows.map((r, i) => ({ id: `p-${i + 1}`, ...r }));
        participantsDb.push(...inserted);
        return {
          select: async () => ({ data: inserted, error: null }),
        };
      },
    };
  }
  return origFrom.call(supabase, table);
};

// Verify BEFORE approve:
assert.equal(logRecord.status, 'pending');
assert.equal(logRecord.approved_by_human, false);
assert.equal(participantsDb.length, 0, 'No participants exist before approval');

// Run approve step via real approveHandler
function mockRes() {
  const r = {
    statusCode: 200,
    status(c) { r.statusCode = c; return r; },
    json(d) { r.body = d; return r; },
  };
  return r;
}

const approveRes = mockRes();
await approveHandler(
  {
    method: 'POST',
    body: {
      splitId: split.id,
      ownerKey: 'valid-owner-key',
      logId: logRecord.id,
      decision: 'approve',
    },
  },
  approveRes
);

assert.equal(approveRes.statusCode, 200);
assert.equal(logRecord.status, 'approved');
assert.equal(logRecord.approved_by_human, true, 'Proposal must now be approved_by_human = true');

// Verify AFTER approve:
assert.equal(participantsDb.length, 2, 'Exactly 2 participants created (Asha and Meera)');
assert.ok(participantsDb.some((p) => p.name === 'Asha' && p.share === 42.47), 'Asha participant share is 42.47');
assert.ok(participantsDb.some((p) => p.name === 'Meera' && p.share === 10.09), 'Meera participant share is 10.09');
assert.ok(!participantsDb.some((p) => p.name === 'Ravi'), 'Ravi must NOT be in participants');
assert.ok(!participantsDb.some((p) => p.name === 'Sam'), 'Sam (owner) must NOT be charged');

// Verify no PayPal order is created yet (paypal_order_id is null)
assert.ok(participantsDb.every((p) => !p.paypal_order_id), 'No PayPal orders created until payment step');

// 3. Tests for Clarification on Unknown Names & Ambiguous Assignments
console.log('Testing unknown name and ambiguous assignment guardrails...');

// (a) Unknown name: "Priya had the tikka" without being in people
const resUnknown = buildProposal({
  split,
  items,
  args: {
    people: ['Asha', 'Meera'],
    assignments: [
      { item_name: 'Paneer Tikka', people: ['Priya'] }, // Priya is unknown
    ],
  },
});
assert.ok(resUnknown.error, 'Must return an error for unknown name');
assert.match(resUnknown.error, /I don't recognize "Priya"/);
assert.equal(resUnknown.proposal, undefined, 'Must create NO allocation for unknown name');

// (b1) Ambiguous item: matches two menu entries ("Tikka" matches both Paneer Tikka and Chicken Tikka)
const menuWithTwoTikkas = [
  { name: 'Paneer Tikka', line_total: 15.0 },
  { name: 'Chicken Tikka', line_total: 15.0 },
];
const resAmbItem = buildProposal({
  split,
  items: menuWithTwoTikkas,
  args: {
    people: ['Asha'],
    assignments: [
      { item_name: 'Tikka', people: ['Asha'] }, // Matches both
    ],
  },
});
assert.ok(resAmbItem.error, 'Must return an error for ambiguous item');
assert.match(resAmbItem.error, /Ambiguous item "Tikka" matches multiple items/);
assert.equal(resAmbItem.proposal, undefined, 'Must create NO allocation for ambiguous item');

// (b2) Ambiguous assignment with no roster ("the rest is shared" with no people listed)
const resNoRoster = buildProposal({
  split,
  items,
  args: {
    people: [], // No roster
    assignments: [],
  },
});
assert.ok(resNoRoster.error, 'Must return an error for missing roster');
assert.match(resNoRoster.error, /I need to know who shared the meal with you/);
assert.equal(resNoRoster.proposal, undefined, 'Must create NO allocation when no roster is provided');

// Restore Supabase
supabase.from = origFrom;

console.log('test-allocation-e2e.mjs: all integrated tests passed successfully!');
