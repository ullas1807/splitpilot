// Run with: npm run test:agent  (offline: checks tool-call -> proposal logic and guardrails)
import assert from 'node:assert/strict';
import fs from 'node:fs';

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

const split = { owner_name: 'Sam', currency: 'USD', tax: 4.64, tip: 5.8 };
const items = [
  { name: 'Garlic Bread', line_total: 18.0 },
  { name: 'Paneer Tikka', line_total: 30.0 },
  { name: 'Masala Soda', line_total: 4.0 },
  { name: 'Gulab Jamun', line_total: 6.0 },
];
const total = 18 + 30 + 4 + 6 + 4.64 + 5.8;

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
        { item_name: 'garlic bread', people: ['Asha', 'Ravi'] },
        { item_name: 'paneer', people: ['me'] },
        { item_name: 'Gulab Jamun', people: ['Meera'] },
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
        { item_name: 'Paneer Tikka', people: ['Asha'] },
        { item_name: 'Garlic Bread', people: ['Meera'] },
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
        { item_name: 'Paneer Tikka', people: ['Ravi'] }, // Contradiction: Ravi is excluded but assigned an item
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
        { item_name: 'Garlic Bread', people: ['Asha'] },
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

// 10) Phrasing parsing tests & exact suggestion chips from src/components/AgentFeed.jsx (Requirement A & Item 9 & Step 5)
{
  // A1: "Dinner was me, Asha, Ravi and Meera"
  const r1 = parseGroupDeclaration('Dinner was me, Asha, Ravi and Meera', itemNames);
  assert.deepEqual(r1, ['Asha', 'Ravi', 'Meera']);

  // A2: "Split everything equally between me, Asha, Ravi and Meera"
  const r2 = parseGroupDeclaration('Split everything equally between me, Asha, Ravi and Meera', itemNames);
  assert.deepEqual(r2, ['Asha', 'Ravi', 'Meera']);

  // A3: "Asha, Ravi, Meera and I"
  const r3 = parseGroupDeclaration('Asha, Ravi, Meera and I', itemNames);
  assert.deepEqual(r3, ['Asha', 'Ravi', 'Meera']);

  // Read the exact chip strings from AgentFeed.jsx by regex (do not import JSX)
  const feedSrc = fs.readFileSync(new URL('../src/components/AgentFeed.jsx', import.meta.url), 'utf8');
  const chipMatch = feedSrc.match(/: \['([^']+)', '([^']+)'\]/);
  assert.ok(chipMatch, 'Suggestion chips must be found in AgentFeed.jsx');
  const chip1FromSource = chipMatch[1];
  const chip2FromSource = chipMatch[2];

  assert.equal(chip1FromSource, 'Split everything equally between me, Asha, Ravi and Meera');
  assert.equal(
    chip2FromSource,
    'Dinner was me, Asha, Ravi and Meera. Asha had the paneer tikka, Ravi and I shared the garlic bread, Meera had the gulab jamun. The masala soda is shared by all four of us.'
  );

  // Both chip texts produce expected roster through buildRoster() with the sample receipt items:
  const rosterChip1 = buildRoster({ ownerName: 'Sam', history: [], currentMessage: chip1FromSource, items });
  assert.deepEqual(rosterChip1, ['Sam', 'Asha', 'Ravi', 'Meera']);

  const rosterChip2 = buildRoster({ ownerName: 'Sam', history: [], currentMessage: chip2FromSource, items });
  assert.deepEqual(rosterChip2, ['Sam', 'Asha', 'Ravi', 'Meera']);

  // New greeting example from create-split.js produces expected roster:
  const greetingExample = 'Dinner was me, Asha and Ravi. Asha had the garlic bread, Ravi and I shared the paneer tikka.';
  const rosterGreeting = buildRoster({ ownerName: 'Sam', history: [], currentMessage: greetingExample, items });
  assert.deepEqual(rosterGreeting, ['Sam', 'Asha', 'Ravi']);

  // The item names in chip 2 resolve to the four receipt items with no ambiguity and no unknown item:
  const chip2Assignments = [
    { item_name: 'paneer tikka', people: ['Asha'] },
    { item_name: 'garlic bread', people: ['Ravi', 'me'] },
    { item_name: 'gulab jamun', people: ['Meera'] },
    { item_name: 'masala soda', people: ['me', 'Asha', 'Ravi', 'Meera'] },
  ];
  const propChip2 = buildProposal({
    split,
    items,
    args: {
      people: ['Asha', 'Ravi', 'Meera'],
      tax_tip_mode: 'proportional',
      tip_mode: 'proportional',
      assignments: chip2Assignments,
    },
    roster: rosterChip2,
  });
  assert.equal(propChip2.error, undefined, 'Chip 2 assignments must have no unknown items or ambiguity');

  // Run the chip-2 assignment through the real split-math and assert shares sum to exactly 6844 cents:
  // (Asha: Paneer Tikka; Ravi and owner: Garlic Bread; Meera: Gulab Jamun; Masala Soda shared by all four; tip proportional, tax proportional)
  const { computeShares } = await import('../api/_lib/split-math.js');
  const chip2Shares = computeShares({
    people: ['Sam', 'Asha', 'Ravi', 'Meera'],
    itemCents: [1800, 3000, 400, 600], // Garlic Bread 1800, Paneer Tikka 3000, Masala Soda 400, Gulab Jamun 600
    itemNames: ['Garlic Bread', 'Paneer Tikka', 'Masala Soda', 'Gulab Jamun'],
    assigned: [
      ['Ravi', 'Sam'], // Garlic Bread
      ['Asha'], // Paneer Tikka
      ['Sam', 'Asha', 'Ravi', 'Meera'], // Masala Soda
      ['Meera'], // Gulab Jamun
    ],
    taxCents: 464,
    tipCents: 580,
    mode: 'proportional',
    tipMode: 'proportional',
    ownerName: 'Sam',
  });

  const sumChip2 = chip2Shares.reduce((a, s) => a + s.totalCents, 0);
  assert.equal(sumChip2, 6844, 'Chip 2 shares must sum to exactly 6844 cents');

  // Hand-computed reference: Asha 36.58, Ravi 11.80, Meera 8.26, owner 11.80
  const ashaShare = chip2Shares.find((s) => s.name === 'Asha');
  const raviShare = chip2Shares.find((s) => s.name === 'Ravi');
  const meeraShare = chip2Shares.find((s) => s.name === 'Meera');
  const ownerShare = chip2Shares.find((s) => s.name === 'Sam');

  assert.equal(ashaShare.totalCents, 3658, 'Asha must pay 36.58 (3658 cents)');
  assert.equal(raviShare.totalCents, 1180, 'Ravi must pay 11.80 (1180 cents)');
  assert.equal(meeraShare.totalCents, 826, 'Meera must pay 8.26 (826 cents)');
  assert.equal(ownerShare.totalCents, 1180, 'Owner must pay 11.80 (1180 cents)');
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

// 12) Name sanitization tests (Requirement F & Item 9)
{
  assert.equal(sanitizeName('Priya<script>alert(1)</script>'), 'Priyaalert');
  assert.equal(sanitizeName('   mary-jane o\'connor   '), "Mary-Jane O'Connor");
  assert.equal(sanitizeName('abcdefghijklmnopqrstuvwxyz1234567890'), 'Abcdefghijklmnopqrstuvwxyz');
  assert.equal(sanitizeName('12345!@#$'), '');
  assert.equal(sanitizeName('asha'), 'Asha');

  // Max 30 chars limit truncation
  const longName = 'Alexander-Maximilian Montgomery-Smith';
  const sanitizedLong = sanitizeName(longName, 30);
  assert.equal(sanitizedLong, 'Alexander-Maximilian Montgomer');
  assert.ok(sanitizedLong.length <= 30);

  // Letters, spaces, hyphens, apostrophes only
  assert.equal(sanitizeName("O'Connor-Smith 99!"), "O'Connor-Smith");

  // Roster max 12 (LIMITS.maxPeople)
  const manyAttendees = Array.from({ length: 15 }, (_, i) => `Person${String.fromCharCode(65 + i)}`);
  const cappedRoster = buildRoster({
    ownerName: 'Sam',
    history: [{ action: 'user_message', payload: { text: `Dinner was me, ${manyAttendees.join(', ')}` } }],
    items,
  });
  assert.equal(cappedRoster.length, 12, 'Roster must cap at LIMITS.maxPeople (12)');
}

// 12b) Chronological replay & retroactive addition protection in buildRoster
{
  // Pre-declaration explicit add with later declaration & persisted DB participants
  const history = [
    { action: 'user_message', payload: { text: 'add Priya' } },
    { action: 'agent_message', payload: { text: 'Who was at dinner?' } },
    { action: 'user_message', payload: { text: 'Dinner was me, Asha, Ravi and Meera' } },
  ];
  const existingParticipants = [
    { name: 'Asha' },
    { name: 'Ravi' },
    { name: 'Meera' },
  ];
  const roster = buildRoster({
    ownerName: 'Sam',
    history,
    items,
    existingParticipants,
  });
  assert.deepEqual(roster, ['Sam', 'Asha', 'Ravi', 'Meera']);
  assert.ok(!roster.includes('Priya'), 'Priya from pre-declaration message must never be added retroactively');

  // Pre-declaration explicit add with existing DB participants only
  const roster2 = buildRoster({
    ownerName: 'Sam',
    history: [{ action: 'user_message', payload: { text: 'add Priya' } }],
    items,
    existingParticipants: [{ name: 'Asha' }, { name: 'Meera' }],
  });
  assert.deepEqual(roster2, ['Sam', 'Asha', 'Meera']);
  assert.ok(!roster2.includes('Priya'), 'Priya must not be accepted retroactively');

  // Post-declaration explicit add is accepted
  const roster3 = buildRoster({
    ownerName: 'Sam',
    history: [
      { action: 'user_message', payload: { text: 'Dinner was me and Asha' } },
      { action: 'user_message', payload: { text: 'add Priya' } },
    ],
    items,
  });
  assert.deepEqual(roster3, ['Sam', 'Asha', 'Priya']);

  // Declaration + add in single message
  const roster4 = buildRoster({
    ownerName: 'Sam',
    history: [],
    currentMessage: 'Dinner was me and Asha. Please add Priya.',
    items,
  });
  assert.deepEqual(roster4, ['Sam', 'Asha', 'Priya']);

  // Explicit add alone without prior roster returns owner only
  const roster5 = buildRoster({
    ownerName: 'Sam',
    history: [],
    currentMessage: 'add Priya',
    items,
  });
  assert.deepEqual(roster5, ['Sam']);
}

// 12c) Later Declarations Rule (Item 7)
// Rule: "allow only names literally typed by the user".
// Later group declarations add attendees literally typed by the user in that message.
{
  const histLater = [
    { action: 'user_message', payload: { text: 'Dinner was me, Asha and Ravi' } },
    { action: 'user_message', payload: { text: 'Actually dinner was me, Asha, Ravi and Meera' } },
  ];
  const rosterLater = buildRoster({ ownerName: 'Sam', history: histLater, items });
  assert.deepEqual(rosterLater, ['Sam', 'Asha', 'Ravi', 'Meera'], 'Later declaration adds literally typed user name Meera');
}

// 12d) DB Baseline & Mismatch Reporting (Item 8)
// If persisted participants exist in DB but history has no declaration,
// allow explicit adds from the CURRENT message only; history adds are discarded.
{
  const historyWithAdd = [{ action: 'user_message', payload: { text: 'add Priya' } }];
  const dbParticipants = [{ name: 'Asha' }, { name: 'Ravi' }, { name: 'Meera' }];

  // Explicit add from CURRENT message allowed:
  const r1 = buildRoster({
    ownerName: 'Sam',
    history: historyWithAdd,
    currentMessage: 'add Karan',
    items,
    existingParticipants: dbParticipants,
  });
  assert.deepEqual(
    r1,
    ['Sam', 'Asha', 'Ravi', 'Meera', 'Karan'],
    'DB baseline allows explicit add from CURRENT message, while discarding unanchored history add'
  );
  assert.ok(!r1.includes('Priya'), 'Priya from pre-baseline history must be discarded');

  // Without current add:
  const r2 = buildRoster({
    ownerName: 'Sam',
    history: historyWithAdd,
    currentMessage: 'Split the bill',
    items,
    existingParticipants: dbParticipants,
  });
  assert.deepEqual(r2, ['Sam', 'Asha', 'Ravi', 'Meera']);
  assert.ok(!r2.includes('Priya'));
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
      select: () => {
        let rows = [...logRecords];
        const query = {
          eq: (col, val) => {
            rows = rows.filter((r) => r[col] === undefined || r[col] === val || (r.payload && r.payload[col] === val));
            return query;
          },
          in: (col, vals) => {
            rows = rows.filter((r) => vals.includes(r[col]));
            return query;
          },
          order: (col, { ascending = true } = {}) => {
            rows.sort((a, b) => {
              const valA = a[col] ?? '';
              const valB = b[col] ?? '';
              if (valA < valB) return ascending ? -1 : 1;
              if (valA > valB) return ascending ? 1 : -1;
              return 0;
            });
            return query;
          },
          limit: (n) => {
            rows = rows.slice(0, n);
            return query;
          },
          get data() {
            return rows;
          },
          then: (resolve) => resolve({ data: rows, error: null }),
        };
        return query;
      },
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

// =========================================================================
// REQUIRED TESTS (a through g): through actual api/agent.js handler with mocked Gemini & DB
// =========================================================================

// Test a: Empty history, no participants, message "add Priya", Gemini proposes a split containing Priya -> "Who was at dinner?", nothing created.
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
                    explanation: 'Add Priya',
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

  const lastAgentMsg = [...logRecords].reverse().find((l) => l.action === 'agent_message');
  assert.ok(lastAgentMsg, 'Agent message must be logged');
  assert.equal(lastAgentMsg.payload.text, 'Who was at dinner?');

  // Assert mock recorded zero pending proposal inserts, zero participant inserts, zero PayPal fetches
  const pendingProps = logRecords.filter((l) => l.action === 'proposal' && l.status === 'pending');
  assert.equal(pendingProps.length, 0, 'Must record zero pending proposals in failure case');
  assert.equal(participantsDb.length, 0, 'Must record zero participant inserts in failure case');
  assert.equal(paypalFetchCalls.length, 0, 'Must record zero PayPal fetches in failure case');
}

// Test b: Ordering exploit (Item 7): user sends "add Priya" first (rejected, no roster), then "Dinner was me, Asha, Ravi and Meera". Priya must NOT be in the roster.
{
  // Turn 1: "add Priya" was rejected with "Who was at dinner?"
  logRecords = [
    {
      id: 'log-1',
      action: 'user_message',
      payload: { text: 'add Priya' },
      created_at: '2026-11-08T10:00:00Z',
    },
    {
      id: 'log-2',
      action: 'agent_message',
      payload: { text: 'Who was at dinner?' },
      created_at: '2026-11-08T10:00:01Z',
    },
  ];
  participantsDb = [];
  paypalFetchCalls = [];

  // Turn 2: User sends "Dinner was me, Asha, Ravi and Meera"
  // If Gemini tries to include Priya, it must be rejected because Priya is NOT in the roster!
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
                    people: ['Asha', 'Ravi', 'Meera', 'Priya'], // Maliciously includes Priya from turn 1
                    tax_tip_mode: 'proportional',
                    explanation: 'Split for group',
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
      body: { splitId, ownerKey, message: 'Dinner was me, Asha, Ravi and Meera' },
    },
    res
  );

  assert.equal(res.statusCode, 200);

  const lastAgentMsg = [...logRecords].reverse().find((l) => l.action === 'agent_message');
  assert.ok(lastAgentMsg);
  // Must reject Priya because Priya was never part of the established roster!
  assert.equal(
    lastAgentMsg.payload.text,
    "I don't see Priya in this split. Who was at dinner? Say 'add Priya' to include her."
  );

  const pendingProps = logRecords.filter((l) => l.action === 'proposal' && l.status === 'pending');
  assert.equal(pendingProps.length, 0, 'Zero pending proposals when Priya is included');
  assert.equal(participantsDb.length, 0);
  assert.equal(paypalFetchCalls.length, 0);

  // Now verify that a clean proposal with Asha, Ravi, Meera succeeds and excludes Priya:
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
                    people: ['Asha', 'Ravi', 'Meera'],
                    tax_tip_mode: 'proportional',
                    explanation: 'Split for group',
                  },
                },
              },
            ],
          },
        },
      ],
    }),
  });

  const resOk = createMockRes();
  await agentHandler(
    {
      method: 'POST',
      body: { splitId, ownerKey, message: 'Dinner was me, Asha, Ravi and Meera' },
    },
    resOk
  );
  assert.equal(resOk.statusCode, 200);
  const okProp = logRecords.find((l) => l.action === 'proposal' && l.status === 'pending');
  assert.ok(okProp);
  assert.ok(!okProp.payload.requests.some((r) => r.name.toLowerCase() === 'priya'), 'Priya must NOT be in the roster');
}

// Test c: No roster + exclusion only (Item 5):
// Empty history, message "Ravi didn't eat" -> "Who was at dinner?", no proposal.
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
                    people: ['Sam'],
                    excluded_people: ['Ravi'],
                    tax_tip_mode: 'proportional',
                    explanation: "Ravi didn't eat",
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
      body: { splitId, ownerKey, message: "Ravi didn't eat" },
    },
    res
  );

  assert.equal(res.statusCode, 200);

  const lastAgentMsg = [...logRecords].reverse().find((l) => l.action === 'agent_message');
  assert.ok(lastAgentMsg);
  assert.equal(lastAgentMsg.payload.text, 'Who was at dinner?');

  const pendingProps = logRecords.filter((l) => l.action === 'proposal' && l.status === 'pending');
  assert.equal(pendingProps.length, 0, 'Zero pending proposals on exclusion with no roster');
  assert.equal(participantsDb.length, 0);
  assert.equal(paypalFetchCalls.length, 0);
}

// Test d: Declaration + add in one message (Item 6):
// "Dinner was me, Asha, Ravi and Meera. Add Priya." -> roster of five (Sam, Asha, Ravi, Meera, Priya).
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
                    people: ['Asha', 'Ravi', 'Meera', 'Priya'],
                    tax_tip_mode: 'proportional',
                    explanation: 'Split for 5',
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
      body: { splitId, ownerKey, message: 'Dinner was me, Asha, Ravi and Meera. Add Priya.' },
    },
    res
  );

  assert.equal(res.statusCode, 200);

  const prop = logRecords.find((l) => l.action === 'proposal' && l.status === 'pending');
  assert.ok(prop, 'Proposal must be created for declaration + add in one message');
  assert.equal(prop.payload.requests.length, 4); // Asha, Ravi, Meera, Priya (plus owner Sam = 5)
  assert.ok(prop.payload.requests.some((r) => r.name === 'Priya'));
}

// Test e: Negation and look-alike phrasings do not add anyone:
{
  // e1: "Don't add Priya"
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
                    explanation: 'Try add Priya',
                  },
                },
              },
            ],
          },
        },
      ],
    }),
  });

  const resE1 = createMockRes();
  await agentHandler(
    {
      method: 'POST',
      body: { splitId, ownerKey, message: "Don't add Priya" },
    },
    resE1
  );

  assert.equal(resE1.statusCode, 200);
  const msgE1 = [...logRecords].reverse().find((l) => l.action === 'agent_message');
  assert.equal(msgE1.payload.text, "I don't see Priya in this split. Who was at dinner? Say 'add Priya' to include her.");
  assert.equal(logRecords.filter((l) => l.action === 'proposal' && l.status === 'pending').length, 0);

  // e2: "Priya, add the tikka"
  const resE2 = createMockRes();
  await agentHandler(
    {
      method: 'POST',
      body: { splitId, ownerKey, message: 'Priya, add the tikka' },
    },
    resE2
  );
  assert.equal(resE2.statusCode, 200);
  const msgE2 = [...logRecords].reverse().find((l) => l.action === 'agent_message');
  assert.equal(msgE2.payload.text, "I don't see Priya in this split. Who was at dinner? Say 'add Priya' to include her.");
  assert.equal(logRecords.filter((l) => l.action === 'proposal' && l.status === 'pending').length, 0);

  // e3 (Item 5): Direct buildRoster() assertions for non-adding / look-alike phrasings
  // For "add the tikka for Asha", "Don't add Priya", "Priya, add the tikka" and "Priya had the tikka",
  // the roster equals exactly {Sam, Asha, Ravi, Meera}.
  const baseHist = [
    {
      id: 'log-1',
      action: 'user_message',
      payload: { text: 'Dinner was me, Asha, Ravi and Meera' },
      created_at: '2026-11-08T10:00:00Z',
    },
  ];
  const expectedFour = ['Sam', 'Asha', 'Ravi', 'Meera'];
  assert.deepEqual(buildRoster({ ownerName: 'Sam', history: baseHist, currentMessage: 'add the tikka for Asha', items }), expectedFour);
  assert.deepEqual(buildRoster({ ownerName: 'Sam', history: baseHist, currentMessage: "Don't add Priya", items }), expectedFour);
  assert.deepEqual(buildRoster({ ownerName: 'Sam', history: baseHist, currentMessage: 'Priya, add the tikka', items }), expectedFour);
  assert.deepEqual(buildRoster({ ownerName: 'Sam', history: baseHist, currentMessage: 'Priya had the tikka', items }), expectedFour);
}

// Test f: The clarification from (a) is not treated as roster evidence next turn:
{
  logRecords = [
    {
      id: 'log-1',
      action: 'user_message',
      payload: { text: 'add Priya' },
      created_at: '2026-11-08T10:00:00Z',
    },
    {
      id: 'log-2',
      action: 'agent_message',
      payload: { text: "Who was at dinner? Say 'add Priya' to include her." },
      created_at: '2026-11-08T10:00:01Z',
    },
    {
      id: 'log-3',
      action: 'user_message',
      payload: { text: 'Dinner was me, Asha and Meera' },
      created_at: '2026-11-08T10:00:02Z',
    },
    {
      id: 'log-4',
      action: 'agent_message',
      payload: { text: 'Here is my proposed split...' },
      created_at: '2026-11-08T10:00:03Z',
    },
  ];
  participantsDb = [];
  paypalFetchCalls = [];

  // Next turn: user asks for split, LLM includes Priya:
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
                    people: ['Asha', 'Meera', 'Priya'],
                    tax_tip_mode: 'proportional',
                    explanation: 'Split',
                  },
                },
              },
            ],
          },
        },
      ],
    }),
  });

  const resF = createMockRes();
  await agentHandler(
    {
      method: 'POST',
      body: { splitId, ownerKey, message: 'Split the bill' },
    },
    resF
  );

  assert.equal(resF.statusCode, 200);
  const msgF = [...logRecords].reverse().find((l) => l.action === 'agent_message');
  assert.equal(msgF.payload.text, "I don't see Priya in this split. Who was at dinner? Say 'add Priya' to include her.");
  assert.equal(logRecords.filter((l) => l.action === 'proposal' && l.status === 'pending').length, 0);
  assert.equal(participantsDb.length, 0);
  assert.equal(paypalFetchCalls.length, 0);
}

// Test g: Roster derivation with more than eight prior user messages still finds the original declaration:
{
  logRecords = [
    {
      id: 'log-g-1',
      action: 'user_message',
      payload: { text: 'Dinner was me, Asha, Ravi and Meera' },
      created_at: '2026-11-08T10:00:00Z',
    },
    { id: 'log-g-2', action: 'agent_message', payload: { text: 'Got it' }, created_at: '2026-11-08T10:00:01Z' },
    { id: 'log-g-3', action: 'user_message', payload: { text: 'message 2' }, created_at: '2026-11-08T10:00:02Z' },
    { id: 'log-g-4', action: 'user_message', payload: { text: 'message 3' }, created_at: '2026-11-08T10:00:03Z' },
    { id: 'log-g-5', action: 'user_message', payload: { text: 'message 4' }, created_at: '2026-11-08T10:00:04Z' },
    { id: 'log-g-6', action: 'user_message', payload: { text: 'message 5' }, created_at: '2026-11-08T10:00:05Z' },
    { id: 'log-g-7', action: 'user_message', payload: { text: 'message 6' }, created_at: '2026-11-08T10:00:06Z' },
    { id: 'log-g-8', action: 'user_message', payload: { text: 'message 7' }, created_at: '2026-11-08T10:00:07Z' },
    { id: 'log-g-9', action: 'user_message', payload: { text: 'message 8' }, created_at: '2026-11-08T10:00:08Z' },
    { id: 'log-g-10', action: 'user_message', payload: { text: 'message 9' }, created_at: '2026-11-08T10:00:09Z' },
    { id: 'log-g-11', action: 'user_message', payload: { text: 'message 10' }, created_at: '2026-11-08T10:00:10Z' },
  ];
  participantsDb = [];
  paypalFetchCalls = [];

  // Demonstrate .limit(8) on mock Supabase dropping original declaration (Item 6):
  const cappedQuery = await supabase.from('agent_log').select('*').in('action', ['user_message']).order('created_at', { ascending: false }).limit(8);
  const cappedRoster = buildRoster({ ownerName: 'Sam', history: cappedQuery.data.reverse(), currentMessage: 'Split everything equally', items });
  assert.deepEqual(cappedRoster, ['Sam'], 'Capping history at 8 rows drops the declaration and returns owner only');

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
                    people: ['Asha', 'Ravi', 'Meera'],
                    tax_tip_mode: 'proportional',
                    explanation: 'Split for group',
                  },
                },
              },
            ],
          },
        },
      ],
    }),
  });

  const resG = createMockRes();
  await agentHandler(
    {
      method: 'POST',
      body: { splitId, ownerKey, message: 'Split everything equally' },
    },
    resG
  );

  assert.equal(resG.statusCode, 200);

  const propG = logRecords.find((l) => l.action === 'proposal' && l.status === 'pending');
  assert.ok(propG, 'Must find original declaration despite >8 prior user messages');
  assert.equal(propG.payload.requests.length, 3);
  assert.deepEqual(
    propG.payload.requests.map((r) => r.name).sort(),
    ['Asha', 'Meera', 'Ravi']
  );
}

// Test h (Item 3): Propose_split version with persisted DB participants & historical pre-declaration add
{
  logRecords = [
    {
      id: 'log-h-1',
      action: 'user_message',
      payload: { text: 'add Priya' },
      created_at: '2026-11-08T10:00:00Z',
    },
    {
      id: 'log-h-2',
      action: 'agent_message',
      payload: { text: 'Who was at dinner?' },
      created_at: '2026-11-08T10:00:01Z',
    },
    {
      id: 'log-h-3',
      action: 'user_message',
      payload: { text: 'Dinner was me, Asha, Ravi and Meera' },
      created_at: '2026-11-08T10:00:02Z',
    },
    {
      id: 'log-h-4',
      action: 'proposal',
      status: 'approved',
      payload: { summary: 'Split approved' },
      created_at: '2026-11-08T10:00:03Z',
    },
  ];
  // Participants persisted to DB from approved split:
  participantsDb = [
    { id: 'p1', split_id: splitId, name: 'Asha', share: 2000, status: 'pending' },
    { id: 'p2', split_id: splitId, name: 'Ravi', share: 2000, status: 'pending' },
    { id: 'p3', split_id: splitId, name: 'Meera', share: 2000, status: 'pending' },
  ];
  paypalFetchCalls = [];

  // Part 1: Gemini returns propose_split with Priya on the next turn
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
                    explanation: 'Split with Priya',
                  },
                },
              },
            ],
          },
        },
      ],
    }),
  });

  const resH1 = createMockRes();
  await agentHandler(
    {
      method: 'POST',
      body: { splitId, ownerKey, message: 'Split the bill with Priya' },
    },
    resH1
  );

  assert.equal(resH1.statusCode, 200);
  assert.equal(logRecords.filter((l) => l.action === 'proposal' && l.status === 'pending').length, 0, 'Zero pending proposals created');
  assert.equal(participantsDb.length, 3, 'Zero participant inserts');
  assert.equal(paypalFetchCalls.length, 0, 'Zero PayPal fetches');

  // Part 2: Reminders test (Asha, Ravi, Meera, Priya)
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
                  name: 'draft_reminders',
                  args: {
                    reminders: [
                      { participant_name: 'Asha', message: 'Hi Asha, gentle reminder for dinner' },
                      { participant_name: 'Ravi', message: 'Hi Ravi, gentle reminder for dinner' },
                      { participant_name: 'Meera', message: 'Hi Meera, gentle reminder for dinner' },
                      { participant_name: 'Priya', message: 'Hi Priya, gentle reminder for dinner' },
                    ],
                  },
                },
              },
            ],
          },
        },
      ],
    }),
  });

  const resH2 = createMockRes();
  await agentHandler(
    {
      method: 'POST',
      body: { splitId, ownerKey, message: 'Send reminders to everyone' },
    },
    resH2
  );

  assert.equal(resH2.statusCode, 200);
  const reminders = logRecords.filter((l) => l.action === 'reminder_draft');
  assert.equal(reminders.length, 3);
  assert.deepEqual(
    reminders.map((r) => r.payload.name).sort(),
    ['Asha', 'Meera', 'Ravi']
  );
  assert.ok(!reminders.some((r) => r.payload.name === 'Priya'), 'Priya must never receive a reminder');
  assert.equal(paypalFetchCalls.length, 0, 'Zero PayPal fetches');
}

// Test i (Item 2): Discriminating no-roster gate test through handler
// No roster, message "Split the bill", Gemini returns people: [] or only the owner.
// Expect exact reply "Who was at dinner?" with zero pending proposals, zero participants, zero PayPal fetches.
{
  logRecords = [];
  participantsDb = [];
  paypalFetchCalls = [];

  // Case i1: people: []
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
                    people: [],
                    tax_tip_mode: 'proportional',
                    explanation: 'Split with empty people',
                  },
                },
              },
            ],
          },
        },
      ],
    }),
  });

  const resI1 = createMockRes();
  await agentHandler(
    {
      method: 'POST',
      body: { splitId, ownerKey, message: 'Split the bill' },
    },
    resI1
  );

  assert.equal(resI1.statusCode, 200);
  const msgI1 = [...logRecords].reverse().find((l) => l.action === 'agent_message');
  assert.equal(msgI1.payload.text, 'Who was at dinner?', 'Must reply "Who was at dinner?" on empty people when no roster exists');
  assert.equal(logRecords.filter((l) => l.action === 'proposal' && l.status === 'pending').length, 0, 'Zero pending proposals');
  assert.equal(participantsDb.length, 0, 'Zero participant inserts');
  assert.equal(paypalFetchCalls.length, 0, 'Zero PayPal fetches');

  // Case i2: people: ['Sam'] (only owner)
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
                    people: ['Sam'],
                    tax_tip_mode: 'proportional',
                    explanation: 'Split for owner only',
                  },
                },
              },
            ],
          },
        },
      ],
    }),
  });

  const resI2 = createMockRes();
  await agentHandler(
    {
      method: 'POST',
      body: { splitId, ownerKey, message: 'Split the bill' },
    },
    resI2
  );

  assert.equal(resI2.statusCode, 200);
  const msgI2 = [...logRecords].reverse().find((l) => l.action === 'agent_message');
  assert.equal(msgI2.payload.text, 'Who was at dinner?', 'Must reply "Who was at dinner?" on owner-only when no roster exists');
  assert.equal(logRecords.filter((l) => l.action === 'proposal' && l.status === 'pending').length, 0, 'Zero pending proposals');
  assert.equal(participantsDb.length, 0, 'Zero participant inserts');
  assert.equal(paypalFetchCalls.length, 0, 'Zero PayPal fetches');
}

// Test j (Item 4): Restored explicit add with established roster
// Established roster in history + later user message "add Priya" lets Priya into the proposal
{
  logRecords = [
    {
      id: 'log-1',
      action: 'user_message',
      payload: { text: 'Dinner was me, Asha and Meera' },
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
                    people: ['Asha', 'Meera', 'Priya'],
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

  const resJ = createMockRes();
  await agentHandler(
    {
      method: 'POST',
      body: { splitId, ownerKey, message: 'add Priya' },
    },
    resJ
  );

  assert.equal(resJ.statusCode, 200);
  const createdProposal = logRecords.find((l) => l.action === 'proposal' && l.status === 'pending');
  assert.ok(createdProposal, 'Explicit "add Priya" must allow proposal creation');
  assert.ok(createdProposal.payload.requests.some((r) => r.name === 'Priya'), 'Priya must be in the proposal requests');
}

// Test k (Item 4): Restored item reassignment move stated in Assumptions
// Previous proposal had Paneer Tikka assigned to Asha.
// New instruction reassigns Paneer Tikka to Meera.
// Proposal must state "Paneer Tikka reassigned from Asha to Meera." in Assumptions.
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

  const resK = createMockRes();
  await agentHandler(
    {
      method: 'POST',
      body: { splitId, ownerKey, message: 'Actually Meera had the Paneer Tikka' },
    },
    resK
  );

  assert.equal(resK.statusCode, 200);
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
