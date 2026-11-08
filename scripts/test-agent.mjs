// Run with: npm run test:agent  (offline: checks tool-call -> proposal logic and guardrails)
import assert from 'node:assert/strict';

// The modules create a Supabase client at import time; placeholders are enough for offline tests.
process.env.SUPABASE_URL ||= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';
process.env.GEMINI_API_KEY ||= 'test-gemini-key';

const {
  buildProposal,
  buildReminders,
  buildRoster,
  sanitizeName,
  extractExplicitAdds,
  parseGroupDeclaration,
} = await import('../api/_lib/agent-tools.js');
const { normalizeReceipt } = await import('../api/_lib/receipt.js');
const { default: agentHandler } = await import('../api/agent.js');
const { supabase } = await import('../api/_lib/supabase.js');

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
    split,
    items,
    args: {
      people: ['asha', 'Ravi', 'Meera'],
      tax_tip_mode: 'proportional',
      explanation: 'x',
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
  const { proposal } = buildProposal({
    split,
    items,
    args: { people: ['A', 'B'], owner_participates: false, tax_tip_mode: 'equal', explanation: '' },
  });
  assert.equal(proposal.owner_share_cents, 0);
  assert.equal(proposal.requests.reduce((a, r) => a + r.amount_cents, 0), Math.round(total * 100));
}

// 3) Unknown item is reported, not silently dropped
{
  const { proposal } = buildProposal({
    split,
    items,
    args: {
      people: ['A'],
      tax_tip_mode: 'equal',
      explanation: '',
      assignments: [{ item_name: 'Unicorn Steak', people: ['A'] }],
    },
  });
  assert.deepEqual(proposal.unmatched, ['Unicorn Steak']);
}

// 4) Guardrails
{
  const noOthers = buildProposal({ split, items, args: { people: [], tax_tip_mode: 'equal', explanation: '' } });
  assert.ok(noOthers.error, 'needs at least one other person');
  const tooMany = buildProposal({
    split,
    items,
    args: { people: Array.from({ length: 20 }, (_, i) => `Person${String.fromCharCode(65 + i)}`), tax_tip_mode: 'equal', explanation: '' },
  });
  assert.match(tooMany.error, /at most/);
  const huge = buildProposal({
    split: { ...split, tax: 0, tip: 0 },
    items: [{ name: 'Gala dinner', line_total: 1200 }],
    args: { people: ['A'], tax_tip_mode: 'equal', explanation: '' },
  });
  assert.match(huge.error, /per-person limit/);
}

// 5) Reminders only match pending people and strip links
{
  const pending = [{ id: '1', name: 'Ravi', share: 10 }];
  const out = buildReminders({
    args: {
      reminders: [
        { participant_name: 'ravi', message: 'Hey! pay at http://evil.example/x thanks' },
        { participant_name: 'Ghost', message: 'boo' },
      ],
    },
    pending,
  });
  assert.equal(out.length, 1);
  assert.ok(!/http/.test(out[0].message));
}

// 6) Receipt normalizer cleans junk and flags mismatched totals
{
  const r = normalizeReceipt({
    is_receipt: true,
    venue: '  Cafe\n\u0000X  ',
    items: [
      { name: 'Tea', quantity: 0, line_total: 3.456 },
      { name: '', line_total: 5 },
      { name: 'Free', line_total: 0 },
    ],
    tax: -2,
    tip: 1,
    total: 99,
  });
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].line_total, 3.46);
  assert.equal(r.tax, 0);
  assert.equal(r.total_matches, false);
  assert.ok(!/[\n\u0000]/.test(r.venue));
}

// 7) Excluded people: zero share, not charged, unassigned items don't go to excluded
{
  const { proposal, error } = buildProposal({
    split,
    items,
    args: {
      people: ['Asha', 'Meera'],
      excluded_people: ['Ravi'],
      tax_tip_mode: 'proportional',
      tip_mode: 'owner_covers',
      explanation: 'Hallucinated model explanation that should be ignored',
      assignments: [
        { item_name: 'Margherita Pizza', people: ['Asha'] },
        { item_name: 'Pasta Alfredo', people: ['Meera'] },
      ],
    },
  });
  assert.equal(error, undefined);
  assert.deepEqual(proposal.excluded, ['Ravi']);
  assert.ok(!proposal.requests.some((r) => r.name.toLowerCase() === 'ravi'), 'Ravi must have no payment request');
  assert.match(proposal.summary, /Excluded \(\$0\): Ravi/);
  assert.match(proposal.summary, /Tip covered by Sam/);
  assert.ok(!proposal.summary.includes('Hallucinated'), 'Server-side summary must replace model explanation');
  assert.ok(proposal.assumptions.length > 0, 'Card must have an Assumptions line');

  // Verify tip_mode: owner_covers allocated tip to Sam
  const ashaReq = proposal.requests.find((r) => r.name === 'Asha');
  const meeraReq = proposal.requests.find((r) => r.name === 'Meera');
  assert.equal(ashaReq.tip_cents, 0, 'Asha pays zero tip under owner_covers');
  assert.equal(meeraReq.tip_cents, 0, 'Meera pays zero tip under owner_covers');

  // Total check
  const sum = proposal.requests.reduce((a, r) => a + r.amount_cents, 0) + proposal.owner_share_cents;
  assert.equal(sum, Math.round(total * 100));
}

// 8) If an excluded person ends up with non-zero share, reject proposal server-side
{
  const { error } = buildProposal({
    split,
    items,
    args: {
      people: ['Asha'],
      excluded_people: ['Ravi'],
      tax_tip_mode: 'equal',
      assignments: [
        { item_name: 'Margherita Pizza', people: ['Ravi'] }, // Contradiction: Ravi is excluded but assigned an item
      ],
    },
  });
  assert.ok(error, 'Must reject proposal when excluded person has non-zero share');
  assert.match(error, /Proposal rejected: Ravi is marked as excluded/);
}

// 9) tip_mode = 'even' separates tax and tip
{
  const { proposal } = buildProposal({
    split,
    items,
    args: {
      people: ['Asha'],
      tax_tip_mode: 'proportional',
      tip_mode: 'even',
      assignments: [
        { item_name: 'Margherita Pizza', people: ['Asha'] },
        { item_name: 'Paneer Tikka', people: ['me'] },
      ],
    },
  });
  assert.equal(proposal.tip_mode, 'even');
  assert.equal(proposal.tax_mode, 'proportional');
  const asha = proposal.requests.find((r) => r.name === 'Asha');
  assert.ok(asha.tax_cents > 0);
  assert.ok(asha.tip_cents > 0);
  assert.equal(asha.tax_cents + asha.tip_cents, asha.tax_tip_cents);
}

// =========================================================================
// REGRESSION SUITE: SERVER-SIDE ROSTER, PHRASINGS, NEGATION & HANDLER MOCKS
// =========================================================================

console.log('Testing roster parsing and phrasing requirements (Requirement A & D)...');

const itemNames = items.map((i) => i.name);

// 10) Phrasing parsing tests (Requirement A)
{
  // A1: "Dinner was me, Asha, Ravi and Meera"
  const r1 = parseGroupDeclaration('Dinner was me, Asha, Ravi and Meera', itemNames);
  assert.deepEqual(r1, ['Asha', 'Ravi', 'Meera']);

  // A2: "Split everything equally between me, Asha, Ravi and Meera" (UI chip 1)
  const r2 = parseGroupDeclaration('Split everything equally between me, Asha, Ravi and Meera', itemNames);
  assert.deepEqual(r2, ['Asha', 'Ravi', 'Meera']);

  // A3: "Asha, Ravi, Meera and I"
  const r3 = parseGroupDeclaration('Asha, Ravi, Meera and I', itemNames);
  assert.deepEqual(r3, ['Asha', 'Ravi', 'Meera']);

  // A4: UI Chip 2: "Asha and Ravi shared the pizza, I had the paneer, Meera had the pasta. Garlic bread and lemonades are shared by all four of us"
  const chip2 =
    'Asha and Ravi shared the pizza, I had the paneer, Meera had the pasta. Garlic bread and lemonades are shared by all four of us';
  const r4 = parseGroupDeclaration(chip2, itemNames);
  assert.deepEqual(r4, ['Asha', 'Ravi', 'Meera']);
}

// 11) Negation and look-alikes tests (Requirement D)
{
  // "Don't add Priya"
  assert.deepEqual(extractExplicitAdds("Don't add Priya", itemNames), []);
  assert.deepEqual(extractExplicitAdds('Do not add Priya', itemNames), []);
  assert.deepEqual(extractExplicitAdds("Please don't add Priya", itemNames), []);

  // "Priya, add the tikka" -> look-alike adding item, not person
  assert.deepEqual(extractExplicitAdds('Priya, add the tikka', itemNames), []);

  // "add the tikka for Asha" -> look-alike adding item for person
  assert.deepEqual(extractExplicitAdds('add the tikka for Asha', itemNames), []);

  // "Add Priya and Karan" -> adds both
  assert.deepEqual(extractExplicitAdds('Add Priya and Karan', itemNames), ['Priya', 'Karan']);

  // "add Priya" -> adds single
  assert.deepEqual(extractExplicitAdds('add Priya', itemNames), ['Priya']);
}

// 12) Name sanitization tests (Requirement F)
{
  assert.equal(sanitizeName('Priya<script>alert(1)</script>'), 'Priyaalert');
  assert.equal(sanitizeName('   mary-jane o\'connor   '), "Mary-Jane O'Connor");
  assert.equal(sanitizeName('abcdefghijklmnopqrstuvwxyz1234567890'), 'Abcdefghijklmnopqrstuvwxyz');
  assert.equal(sanitizeName('12345!@#$'), '');
  assert.equal(sanitizeName('asha'), 'Asha');
}

// 13) Mocked agent.js handler tests (Requirement 4, G, B, E)
console.log('Testing agent.js handler with mocked Gemini and mocked DB (Requirement G)...');

function createMockRes() {
  const r = {
    statusCode: 200,
    headers: {},
    body: null,
    status(c) {
      r.statusCode = c;
      return r;
    },
    json(b) {
      r.body = b;
      return r;
    },
    setHeader(k, v) {
      r.headers[k] = v;
    },
  };
  return r;
}

// DB & Fetch Mock Harness
const splitId = '11111111-2222-3333-4444-555555555555';
const ownerKey = 'valid-secret-key';
const splitRecord = {
  id: splitId,
  owner_name: 'Sam',
  currency: 'USD',
  venue: 'Spice Cafe',
  tax: 4.64,
  tip: 5.8,
  total: 68.44,
  status: 'open',
};

const itemsDb = [
  { id: 'i1', split_id: splitId, name: 'Paneer Tikka', price: 30.0, quantity: 1 },
  { id: 'i2', split_id: splitId, name: 'Garlic Bread', price: 18.0, quantity: 1 },
  { id: 'i3', split_id: splitId, name: 'Masala Soda', price: 4.0, quantity: 1 },
  { id: 'i4', split_id: splitId, name: 'Gulab Jamun', price: 6.0, quantity: 1 },
];

let logRecords = [];
let participantsDb = [];
let geminiResponseGenerator = null;
let paypalFetchCalls = [];

const origFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const urlStr = String(url);
  if (urlStr.includes('paypal')) {
    paypalFetchCalls.push({ url: urlStr, init });
    return { ok: true, status: 200, json: async () => ({ id: 'ORD_MOCK' }) };
  }
  if (urlStr.includes('generativelanguage')) {
    if (geminiResponseGenerator) {
      return geminiResponseGenerator(urlStr, init);
    }
  }
  return origFetch ? origFetch(url, init) : { ok: true, status: 200, json: async () => ({}) };
};

const origFrom = supabase.from;
supabase.from = (table) => {
  if (table === 'split_secrets') {
    return {
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: { owner_key: ownerKey } }),
        }),
      }),
    };
  }
  if (table === 'splits') {
    return {
      select: () => ({
        eq: () => ({
          single: async () => ({ data: splitRecord }),
        }),
      }),
      update: () => ({
        eq: async () => ({ data: splitRecord, error: null }),
      }),
    };
  }
  if (table === 'items') {
    return {
      select: () => ({
        eq: () => ({
          order: () => ({ data: itemsDb }),
        }),
      }),
    };
  }
  if (table === 'participants') {
    return {
      select: () => ({
        eq: () => ({
          neq: () => ({ count: participantsDb.filter((p) => p.status !== 'paid').length }),
          data: participantsDb,
        }),
      }),
      insert: (rows) => {
        participantsDb.push(...rows);
        return {
          select: async () => ({ data: rows, error: null }),
        };
      },
      update: () => ({
        eq: async () => ({ data: null, error: null }),
      }),
    };
  }
  if (table === 'agent_log') {
    return {
      select: () => ({
        eq: () => ({
          in: () => ({
            order: () => ({ data: [...logRecords] }),
          }),
        }),
      }),
      insert: (row) => {
        const id = `log-${logRecords.length + 1}`;
        const record = { id, ...row, created_at: new Date().toISOString() };
        logRecords.push(record);
        return {
          select: () => ({
            single: async () => ({ data: { id }, error: null }),
            maybeSingle: async () => ({ data: { id }, error: null }),
          }),
        };
      },
      update: (fields) => ({
        eq: () => ({
          eq: () => ({
            eq: async () => ({ data: null, error: null }),
          }),
        }),
      }),
    };
  }
  return origFrom.call(supabase, table);
};

// 13.A) Failure Test: Priya is not in the roster (Bug reproduction)
// History has: "Dinner was me, Asha, Ravi and Meera"
// User says: "Priya had the tikka"
// Gemini tries to call propose_split with Priya in people
{
  logRecords = [
    {
      id: 'log-1',
      action: 'user_message',
      payload: { text: 'Dinner was me, Asha, Ravi and Meera' },
      created_at: '2026-11-08T10:00:00Z',
    },
    {
      id: 'log-2',
      action: 'proposal',
      reasoning: 'Initial proposal for Asha, Ravi, Meera and Sam',
      payload: {
        summary: 'Split across Asha, Ravi, Meera, Sam (you).',
        requests: [
          { name: 'Asha', amount_cents: 2000, lines: [{ name: 'Paneer Tikka', cents: 2000 }] },
          { name: 'Ravi', amount_cents: 2000, lines: [] },
          { name: 'Meera', amount_cents: 2000, lines: [] },
        ],
      },
      status: 'pending',
      created_at: '2026-11-08T10:00:01Z',
    },
  ];
  participantsDb = [];
  paypalFetchCalls = [];

  // Gemini returns a propose_split tool call that includes Priya
  geminiResponseGenerator = () => ({
    ok: true,
    status: 200,
    json: async () => ({
      candidates: [
        {
          content: {
            parts: [
              {
                functionCall: {
                  name: 'propose_split',
                  args: {
                    people: ['Asha', 'Meera', 'Priya'], // Priya added by LLM
                    tax_tip_mode: 'proportional',
                    explanation: 'Priya had the tikka',
                    assignments: [{ item_name: 'Paneer Tikka', people: ['Priya'] }],
                  },
                },
              },
            ],
          },
        },
      ],
    }),
  });

  const res = createMockRes();
  await agentHandler(
    {
      method: 'POST',
      body: { splitId, ownerKey, message: 'Priya had the tikka' },
    },
    res
  );

  assert.equal(res.statusCode, 200);

  // Assert clarification message was returned
  const lastAgentMsg = [...logRecords].reverse().find((l) => l.action === 'agent_message');
  assert.ok(lastAgentMsg, 'Agent message must be logged');
  assert.equal(
    lastAgentMsg.payload.text,
    "I don't see Priya in this split. Who was at dinner? Say 'add Priya' to include her."
  );

  // REQUIREMENT G ASSERTIONS:
  // 1) Zero inserts to agent_log with action 'proposal' and status 'pending'
  const newPendingProposals = logRecords.filter((l) => l.action === 'proposal' && l.status === 'pending' && l.id !== 'log-2');
  assert.equal(newPendingProposals.length, 0, 'Must record zero pending proposals in failure case');

  // 2) Zero inserts to participants
  assert.equal(participantsDb.length, 0, 'Must record zero participant inserts in failure case');

  // 3) Zero PayPal fetches
  assert.equal(paypalFetchCalls.length, 0, 'Must record zero PayPal fetches in failure case');
}

// 13.B) Failure Test: No roster has been established (Requirement B)
// History is empty. User immediately sends "Priya had the tikka".
{
  logRecords = [];
  participantsDb = [];
  paypalFetchCalls = [];

  geminiResponseGenerator = () => ({
    ok: true,
    status: 200,
    json: async () => ({
      candidates: [
        {
          content: {
            parts: [
              {
                functionCall: {
                  name: 'propose_split',
                  args: {
                    people: ['Priya'],
                    tax_tip_mode: 'proportional',
                    explanation: 'Priya had the tikka',
                    assignments: [{ item_name: 'Paneer Tikka', people: ['Priya'] }],
                  },
                },
              },
            ],
          },
        },
      ],
    }),
  });

  const res = createMockRes();
  await agentHandler(
    {
      method: 'POST',
      body: { splitId, ownerKey, message: 'Priya had the tikka' },
    },
    res
  );

  assert.equal(res.statusCode, 200);

  // Assert Requirement B reply: "Who was at dinner?"
  const lastAgentMsg = [...logRecords].reverse().find((l) => l.action === 'agent_message');
  assert.ok(lastAgentMsg);
  assert.equal(lastAgentMsg.payload.text, 'Who was at dinner?');

  // Assert ZERO proposals, participants, or PayPal calls
  const pendingProposals = logRecords.filter((l) => l.action === 'proposal' && l.status === 'pending');
  assert.equal(pendingProposals.length, 0, 'Zero proposals when no roster established');
  assert.equal(participantsDb.length, 0);
  assert.equal(paypalFetchCalls.length, 0);
}

// 13.C) Success Test: Explicit "add Priya" is allowed (Requirement 4)
// User explicitly says "add Priya".
{
  logRecords = [
    {
      id: 'log-1',
      action: 'user_message',
      payload: { text: 'Dinner was me, Asha, Ravi and Meera' },
      created_at: '2026-11-08T10:00:00Z',
    },
  ];
  participantsDb = [];
  paypalFetchCalls = [];

  geminiResponseGenerator = () => ({
    ok: true,
    status: 200,
    json: async () => ({
      candidates: [
        {
          content: {
            parts: [
              {
                functionCall: {
                  name: 'propose_split',
                  args: {
                    people: ['Asha', 'Ravi', 'Meera', 'Priya'],
                    tax_tip_mode: 'proportional',
                    explanation: 'Added Priya',
                    assignments: [{ item_name: 'Paneer Tikka', people: ['Priya'] }],
                  },
                },
              },
            ],
          },
        },
      ],
    }),
  });

  const res = createMockRes();
  await agentHandler(
    {
      method: 'POST',
      body: { splitId, ownerKey, message: 'add Priya' },
    },
    res
  );

  assert.equal(res.statusCode, 200);

  // Assert proposal was successfully created
  const createdProposal = logRecords.find((l) => l.action === 'proposal' && l.status === 'pending');
  assert.ok(createdProposal, 'Explicit "add Priya" must allow proposal creation');
  assert.ok(createdProposal.payload.requests.some((r) => r.name === 'Priya'), 'Priya must be in the proposal requests');
}

// 13.D) Item Reassignment Test (Requirement 3 & E)
// Previous proposal had Paneer Tikka assigned to Asha.
// New instruction reassigns Paneer Tikka to Meera.
// Must show the move in Assumptions: "Paneer Tikka reassigned from Asha to Meera."
{
  logRecords = [
    {
      id: 'log-1',
      action: 'user_message',
      payload: { text: 'Dinner was me, Asha and Meera. Asha had the Paneer Tikka.' },
      created_at: '2026-11-08T10:00:00Z',
    },
    {
      id: 'log-2',
      action: 'proposal',
      reasoning: 'Asha had Paneer Tikka',
      payload: {
        summary: 'Split across Asha, Meera, Sam (you).',
        assignments: [{ item_name: 'Paneer Tikka', people: ['Asha'] }],
        requests: [{ name: 'Asha', amount_cents: 3500, lines: [{ name: 'Paneer Tikka', cents: 3000 }] }],
      },
      status: 'pending',
      created_at: '2026-11-08T10:00:01Z',
    },
  ];
  participantsDb = [];
  paypalFetchCalls = [];

  geminiResponseGenerator = () => ({
    ok: true,
    status: 200,
    json: async () => ({
      candidates: [
        {
          content: {
            parts: [
              {
                functionCall: {
                  name: 'propose_split',
                  args: {
                    people: ['Asha', 'Meera'],
                    tax_tip_mode: 'proportional',
                    explanation: 'Moved Paneer Tikka to Meera',
                    assignments: [{ item_name: 'Paneer Tikka', people: ['Meera'] }],
                  },
                },
              },
            ],
          },
        },
      ],
    }),
  });

  const res = createMockRes();
  await agentHandler(
    {
      method: 'POST',
      body: { splitId, ownerKey, message: 'Actually Meera had the Paneer Tikka' },
    },
    res
  );

  assert.equal(res.statusCode, 200);

  const newProp = logRecords.find((l) => l.action === 'proposal' && l.status === 'pending' && l.id !== 'log-2');
  assert.ok(newProp, 'New proposal must be created');
  assert.ok(
    newProp.payload.assumptions.includes('Paneer Tikka reassigned from Asha to Meera.'),
    `Assumptions must state reassignment move, got: "${newProp.payload.assumptions}"`
  );
}

// Restore globals
globalThis.fetch = origFetch;
supabase.from = origFrom;

console.log('agent-tools + receipt: all tests passed');
