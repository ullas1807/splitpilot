import assert from 'node:assert/strict';

// Set minimal env required for imports
process.env.SUPABASE_URL ||= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';
process.env.CRON_SECRET = 'valid-cron-secret-12345';

const { supabase } = await import('../api/_lib/supabase.js');
const { default: sweepHandler } = await import('../api/agent-sweep.js');

console.log('Running test-sweep.mjs...');

function mockRes() {
  const r = {
    statusCode: 200,
    body: null,
    status(code) {
      r.statusCode = code;
      return r;
    },
    json(data) {
      r.body = data;
      return r;
    },
  };
  return r;
}

// Track global calls to verify no unauthorized or unexpected network calls (especially PayPal)
let paypalCalls = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  const urlStr = String(url);
  if (urlStr.includes('paypal.com')) {
    paypalCalls += 1;
    throw new Error('Unexpected PayPal call during reminder sweep!');
  }
  return originalFetch(url, opts);
};

// 1. Method verification: GET rejected with 405
{
  const res = mockRes();
  await sweepHandler({ method: 'GET', headers: { authorization: 'Bearer valid-cron-secret-12345' } }, res);
  assert.equal(res.statusCode, 405, 'GET must be rejected with 405 Method Not Allowed');
}

// 2. Auth: Missing or wrong secret gives 401 and zero DB or LLM calls
{
  let dbCalled = false;
  const origFrom = supabase.from;
  supabase.from = () => {
    dbCalled = true;
    return origFrom.call(supabase);
  };

  // Missing Authorization header
  const resMissing = mockRes();
  await sweepHandler({ method: 'POST', headers: {} }, resMissing);
  assert.equal(resMissing.statusCode, 401);
  assert.equal(dbCalled, false, 'Missing secret must do zero DB work');

  // Wrong secret
  const resWrong = mockRes();
  await sweepHandler({ method: 'POST', headers: { authorization: 'Bearer wrong-secret' } }, resWrong);
  assert.equal(resWrong.statusCode, 401);
  assert.equal(dbCalled, false, 'Wrong secret must do zero DB work');

  // Unset CRON_SECRET in environment
  const savedSecret = process.env.CRON_SECRET;
  delete process.env.CRON_SECRET;
  const resUnset = mockRes();
  await sweepHandler({ method: 'POST', headers: { authorization: 'Bearer valid-cron-secret-12345' } }, resUnset);
  assert.equal(resUnset.statusCode, 401, 'Unset CRON_SECRET must refuse with 401');
  assert.equal(dbCalled, false, 'Unset CRON_SECRET must do zero DB work');
  process.env.CRON_SECRET = savedSecret;

  supabase.from = origFrom;
}

// 3. Bound check: cap on splits, default 3-day window, capped and timedOut flags
{
  const now = Date.now();
  const recentSplitDate = new Date(now - 1 * 86400000).toISOString(); // 1 day old (inside 3-day default window)
  const oldSplitDate = new Date(now - 5 * 86400000).toISOString();   // 5 days old (outside 3-day window)

  // 7 splits: 1 old (>3 days), 6 recent (to test cap of 5)
  const splits = [];
  for (let i = 1; i <= 6; i++) {
    splits.push({
      id: `split-${i}`,
      owner_name: `Owner${i}`,
      currency: 'USD',
      status: 'open',
      created_at: recentSplitDate,
    });
  }
  splits.push({
    id: 'split-old',
    owner_name: 'OldOwner',
    currency: 'USD',
    status: 'open',
    created_at: oldSplitDate,
  });

  const participants = [];
  splits.forEach((s, idx) => {
    participants.push({
      id: `part-${idx + 1}`,
      name: `Person${idx + 1}`,
      share: 25.0,
      split_id: s.id,
      split: s,
      status: 'pending',
      created_at: s.created_at,
      last_reminded_at: null,
    });
  });

  const loggedEvents = [];
  const updatedParticipants = [];

  const origFrom = supabase.from;
  supabase.from = (table) => {
    if (table === 'participants') {
      const queryBuilder = {
        select: () => queryBuilder,
        eq: () => queryBuilder,
        lt: () => queryBuilder,
        gt: () => queryBuilder,
        or: () => queryBuilder,
        order: () => queryBuilder,
        limit: async () => ({ data: participants, error: null }),
        update: (fields) => ({
          eq: (col, val) => ({
            or: (cond) => ({
              select: async () => {
                updatedParticipants.push({ id: val, ...fields });
                return { data: [{ id: val, ...fields }] };
              },
            }),
          }),
        }),
      };
      return queryBuilder;
    }
    if (table === 'agent_log') {
      return {
        insert: (row) => {
          loggedEvents.push(row);
          return {
            select: () => ({
              single: async () => ({ data: { id: `log-${loggedEvents.length}` }, error: null }),
            }),
          };
        },
      };
    }
    return origFrom.call(supabase, table);
  };

  const res = mockRes();
  await sweepHandler({ method: 'POST', headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  // Cap check: out of 6 recent splits, only SPLIT_CAP (5) should be processed
  assert.equal(res.body.splits, 5, 'Must cap at 5 splits per run');
  assert.equal(res.body.capped, true, 'capped flag must be true when split cap is reached');
  assert.equal(res.body.timedOut, false, 'timedOut flag must remain false when cap is reached without timeout');
  assert.equal(loggedEvents.length, 5, 'Must draft exactly 5 reminders (1 per capped split)');
  // Age check: split-old must not have any logged drafts
  assert.ok(!loggedEvents.some((l) => l.split_id === 'split-old'), 'Splits older than 3 days must be skipped');

  supabase.from = origFrom;
}

// 4. Starvation test: 60 stale or closed pending participants + 3 fresh ones in open splits
{
  const now = Date.now();
  const freshDate = new Date(now - 1 * 86400000).toISOString(); // 1 day old (open, recent)
  const staleDate = new Date(now - 10 * 86400000).toISOString(); // 10 days old

  const allDbParticipants = [];

  // 30 participants from closed splits
  for (let i = 1; i <= 30; i++) {
    allDbParticipants.push({
      id: `part-closed-${i}`,
      name: `ClosedPerson${i}`,
      share: 10.0,
      split_id: `split-closed-${i}`,
      created_at: freshDate,
      split: { id: `split-closed-${i}`, owner_name: 'OwnerC', currency: 'USD', status: 'closed', created_at: freshDate },
      status: 'pending',
      last_reminded_at: null,
    });
  }

  // 30 participants from stale splits (>3 days old)
  for (let i = 1; i <= 30; i++) {
    allDbParticipants.push({
      id: `part-stale-${i}`,
      name: `StalePerson${i}`,
      share: 10.0,
      split_id: `split-stale-${i}`,
      created_at: staleDate,
      split: { id: `split-stale-${i}`, owner_name: 'OwnerS', currency: 'USD', status: 'open', created_at: staleDate },
      status: 'pending',
      last_reminded_at: null,
    });
  }

  // 3 fresh participants in open, recent splits
  for (let i = 1; i <= 3; i++) {
    allDbParticipants.push({
      id: `part-fresh-${i}`,
      name: `FreshPerson${i}`,
      share: 20.0,
      split_id: `split-fresh-${i}`,
      created_at: freshDate,
      split: { id: `split-fresh-${i}`, owner_name: 'OwnerF', currency: 'USD', status: 'open', created_at: freshDate },
      status: 'pending',
      last_reminded_at: null,
    });
  }

  assert.equal(allDbParticipants.length, 63, 'Total 60 stale/closed + 3 fresh participants');

  let dbFilterSplitStatus = null;
  let dbFilterSplitCreatedAt = null;
  let dbOrderedBy = null;
  const loggedEvents = [];

  const origFrom = supabase.from;
  supabase.from = (table) => {
    if (table === 'participants') {
      const q = {
        select: (cols) => q,
        eq: (col, val) => {
          if (col === 'split.status') dbFilterSplitStatus = val;
          return q;
        },
        lt: () => q,
        gt: (col, val) => {
          if (col === 'split.created_at') dbFilterSplitCreatedAt = val;
          return q;
        },
        or: () => q,
        order: (col, opts) => {
          dbOrderedBy = { col, ...opts };
          return q;
        },
        limit: async (limitCount) => {
          // Simulate the database executing the query with the inner join filters on split
          const filtered = allDbParticipants.filter((p) => {
            if (dbFilterSplitStatus && p.split?.status !== dbFilterSplitStatus) return false;
            if (dbFilterSplitCreatedAt && p.split?.created_at <= dbFilterSplitCreatedAt) return false;
            return true;
          });
          return { data: filtered.slice(0, limitCount), error: null };
        },
        update: (fields) => ({
          eq: (col, val) => ({
            or: (cond) => ({
              select: async () => ({ data: [{ id: val, ...fields }] }),
            }),
          }),
        }),
      };
      return q;
    }
    if (table === 'agent_log') {
      return {
        insert: (row) => {
          loggedEvents.push(row);
          return {
            select: () => ({
              single: async () => ({ data: { id: `log-starv-${loggedEvents.length}` }, error: null }),
            }),
          };
        },
      };
    }
    return origFrom.call(supabase, table);
  };

  const res = mockRes();
  await sweepHandler({ method: 'POST', headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(dbFilterSplitStatus, 'open', 'Database query must filter split.status = open');
  assert.ok(dbFilterSplitCreatedAt, 'Database query must filter split.created_at > createdAfter');
  assert.equal(dbOrderedBy?.col, 'created_at', 'Database query must order newest first');
  assert.equal(dbOrderedBy?.ascending, false, 'Database query must sort descending');
  assert.equal(res.body.drafted, 3, 'All 3 fresh participants must be drafted despite 60 stale/closed rows in DB');
  assert.equal(loggedEvents.length, 3);
  assert.ok(loggedEvents.every((l) => l.payload.name.startsWith('FreshPerson')));

  supabase.from = origFrom;
}

// 5. Time budget & slow LLM test: wrap in ~4000ms timeout, fall back to template, finish in budget
{
  // Test slow LLM timeout
  process.env.GEMINI_API_KEY = 'mock-key';
  process.env.SWEEP_LLM_TIMEOUT_MS = '150'; // fast timeout for test execution
  process.env.SWEEP_BUDGET_MS = '500';

  const testSplit = {
    id: 'split-slow-llm',
    owner_name: 'OwnerSlow',
    currency: 'USD',
    status: 'open',
    created_at: new Date().toISOString(),
  };

  const testParticipant = {
    id: 'part-slow-1',
    name: 'SlowPerson',
    share: 18.0,
    split_id: testSplit.id,
    split: testSplit,
    status: 'pending',
    created_at: new Date(Date.now() - 3600000).toISOString(),
    last_reminded_at: null,
  };

  const loggedEvents = [];

  const origFrom = supabase.from;
  supabase.from = (table) => {
    if (table === 'participants') {
      const q = {
        select: () => q,
        eq: () => q,
        lt: () => q,
        gt: () => q,
        or: () => q,
        order: () => q,
        limit: async () => ({ data: [testParticipant], error: null }),
        update: (fields) => ({
          eq: (col, val) => ({
            or: () => ({
              select: async () => ({ data: [{ id: val, ...fields }] }),
            }),
          }),
        }),
      };
      return q;
    }
    if (table === 'agent_log') {
      return {
        insert: (row) => {
          loggedEvents.push(row);
          return {
            select: () => ({
              single: async () => ({ data: { id: 'log-slow' }, error: null }),
            }),
          };
        },
      };
    }
    return origFrom.call(supabase, table);
  };

  // Mock fetch to simulate a slow LLM that hangs past the timeout
  globalThis.fetch = async (url, opts) => {
    const urlStr = String(url);
    if (urlStr.includes('generativelanguage.googleapis.com')) {
      await new Promise((r) => setTimeout(r, 600)); // takes 600ms, exceeding 150ms timeout
      return {
        ok: true,
        json: async () => ({ candidates: [{ content: { parts: [{ text: 'slow' }] } }] }),
      };
    }
    return originalFetch(url, opts);
  };

  const startTime = Date.now();
  const res = mockRes();
  await sweepHandler({ method: 'POST', headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } }, res);
  const elapsed = Date.now() - startTime;

  assert.equal(res.statusCode, 200, 'Must return 200');
  assert.equal(res.body.drafted, 1, 'Must still draft template reminder despite LLM timeout');
  assert.equal(loggedEvents.length, 1);
  assert.ok(loggedEvents[0].payload.message.includes('Quick nudge about your share'), 'Must fall back to template');
  assert.ok(elapsed < 450, `Must return inside budget, elapsed: ${elapsed}ms`);

  // Clean up env overrides and restore fetch
  delete process.env.SWEEP_LLM_TIMEOUT_MS;
  delete process.env.SWEEP_BUDGET_MS;
  delete process.env.GEMINI_API_KEY;
  globalThis.fetch = originalFetch;
  supabase.from = origFrom;
}

// 6. Skip LLM entirely when fewer than 4000ms remain in budget
{
  process.env.GEMINI_API_KEY = 'mock-key';
  process.env.SWEEP_LLM_TIMEOUT_MS = '4000';
  process.env.SWEEP_BUDGET_MS = '2000'; // budget is 2000ms, which is < 4000ms, so LLM must be skipped immediately

  let llmCalled = false;
  globalThis.fetch = async (url, opts) => {
    const urlStr = String(url);
    if (urlStr.includes('generativelanguage.googleapis.com')) {
      llmCalled = true;
      throw new Error('LLM should have been skipped!');
    }
    return originalFetch(url, opts);
  };

  const testSplit = {
    id: 'split-skip-llm',
    owner_name: 'OwnerSkip',
    currency: 'USD',
    status: 'open',
    created_at: new Date().toISOString(),
  };

  const testParticipant = {
    id: 'part-skip-1',
    name: 'SkipPerson',
    share: 22.0,
    split_id: testSplit.id,
    split: testSplit,
    status: 'pending',
    created_at: new Date(Date.now() - 3600000).toISOString(),
    last_reminded_at: null,
  };

  const loggedEvents = [];

  const origFrom = supabase.from;
  supabase.from = (table) => {
    if (table === 'participants') {
      const q = {
        select: () => q,
        eq: () => q,
        lt: () => q,
        gt: () => q,
        or: () => q,
        order: () => q,
        limit: async () => ({ data: [testParticipant], error: null }),
        update: (fields) => ({
          eq: (col, val) => ({
            or: () => ({
              select: async () => ({ data: [{ id: val, ...fields }] }),
            }),
          }),
        }),
      };
      return q;
    }
    if (table === 'agent_log') {
      return {
        insert: (row) => {
          loggedEvents.push(row);
          return {
            select: () => ({
              single: async () => ({ data: { id: 'log-skip' }, error: null }),
            }),
          };
        },
      };
    }
    return origFrom.call(supabase, table);
  };

  const res = mockRes();
  await sweepHandler({ method: 'POST', headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(llmCalled, false, 'LLM must not be called when budget is < 4000ms');
  assert.equal(res.body.drafted, 1, 'Template reminder must be drafted directly');
  assert.ok(loggedEvents[0].payload.message.includes('Quick nudge about your share'));

  delete process.env.SWEEP_LLM_TIMEOUT_MS;
  delete process.env.SWEEP_BUDGET_MS;
  delete process.env.GEMINI_API_KEY;
  globalThis.fetch = originalFetch;
  supabase.from = origFrom;
}

// 7. Idempotency check: overlapping run where participant was already updated skips drafting
{
  const testSplit = {
    id: 'split-idem',
    owner_name: 'Sam',
    currency: 'USD',
    status: 'open',
    created_at: new Date().toISOString(),
  };

  const testParticipant = {
    id: 'part-idem-1',
    name: 'Asha',
    share: 30.0,
    split_id: testSplit.id,
    split: testSplit,
    status: 'pending',
    created_at: new Date(Date.now() - 3600000).toISOString(),
    last_reminded_at: null,
  };

  const loggedEvents = [];

  const origFrom = supabase.from;
  supabase.from = (table) => {
    if (table === 'participants') {
      const q = {
        select: () => q,
        eq: () => q,
        lt: () => q,
        gt: () => q,
        or: () => q,
        order: () => q,
        limit: async () => ({ data: [testParticipant], error: null }),
        update: (fields) => ({
          eq: (col, val) => ({
            or: (cond) => ({
              select: async () => {
                // Simulate race: another worker updated this row first, returning empty array
                return { data: [] };
              },
            }),
          }),
        }),
      };
      return q;
    }
    if (table === 'agent_log') {
      return {
        insert: (row) => {
          loggedEvents.push(row);
          return {
            select: () => ({
              single: async () => ({ data: { id: 'log-idem' }, error: null }),
            }),
          };
        },
      };
    }
    return origFrom.call(supabase, table);
  };

  const res = mockRes();
  await sweepHandler({ method: 'POST', headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.drafted, 0, 'No draft should be logged if another worker already claimed the row');
  assert.equal(loggedEvents.length, 0, 'agent_log must remain untouched for overlapping run');

  supabase.from = origFrom;
}

// 8. Resilience: Gemini error doesn't abort the run (uses fallback template)
{
  const testSplit = {
    id: 'split-err',
    owner_name: 'Sam',
    currency: 'USD',
    status: 'open',
    created_at: new Date().toISOString(),
  };

  const testParticipant = {
    id: 'part-err-1',
    name: 'Meera',
    share: 15.0,
    split_id: testSplit.id,
    split: testSplit,
    status: 'pending',
    created_at: new Date(Date.now() - 3600000).toISOString(),
    last_reminded_at: null,
  };

  const loggedEvents = [];

  const origFrom = supabase.from;
  supabase.from = (table) => {
    if (table === 'participants') {
      const q = {
        select: () => q,
        eq: () => q,
        lt: () => q,
        gt: () => q,
        or: () => q,
        order: () => q,
        limit: async () => ({ data: [testParticipant], error: null }),
        update: (fields) => ({
          eq: (col, val) => ({
            or: (cond) => ({
              select: async () => ({ data: [{ id: val, ...fields }] }),
            }),
          }),
        }),
      };
      return q;
    }
    if (table === 'agent_log') {
      return {
        insert: (row) => {
          loggedEvents.push(row);
          return {
            select: () => ({
              single: async () => ({ data: { id: 'log-err' }, error: null }),
            }),
          };
        },
      };
    }
    return origFrom.call(supabase, table);
  };

  // Mock global fetch to fail Gemini API calls
  globalThis.fetch = async (url, opts) => {
    const urlStr = String(url);
    if (urlStr.includes('generativelanguage.googleapis.com')) {
      return {
        ok: false,
        status: 429,
        json: async () => ({ error: { message: 'Quota exceeded / rate limited' } }),
      };
    }
    return originalFetch(url, opts);
  };

  const res = mockRes();
  await sweepHandler({ method: 'POST', headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } }, res);

  assert.equal(res.statusCode, 200, 'Sweep must succeed even if Gemini fails');
  assert.equal(res.body.drafted, 1, 'Must produce fallback reminder draft');
  assert.equal(loggedEvents.length, 1);
  assert.ok(loggedEvents[0].payload.message.includes('Quick nudge about your share'), 'Fallback template must be used');

  supabase.from = origFrom;
}

// 9. Security & PayPal check: assert zero PayPal API calls were ever attempted
assert.equal(paypalCalls, 0, 'Sweep must never interact with PayPal');

// Restore fetch
globalThis.fetch = originalFetch;

console.log('test-sweep.mjs: all reminder sweep audit tests passed successfully!');
