import assert from 'node:assert/strict';

process.env.SUPABASE_URL ||= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';
process.env.PAYPAL_CLIENT_ID ||= 'test-client-id';
process.env.PAYPAL_CLIENT_SECRET ||= 'test-client-secret';
process.env.PAYPAL_WEBHOOK_ID ||= 'test-webhook-id';

// Intercept globalThis.fetch for PayPal API calls
const origFetch = globalThis.fetch;
let mockFetchHandler = null;

globalThis.fetch = async (url, init) => {
  const urlStr = String(url);
  // Default mock for PayPal oauth token
  if (urlStr.includes('/v1/oauth2/token')) {
    const data = { access_token: 'mock-token', expires_in: 3600 };
    return {
      ok: true,
      status: 200,
      json: async () => data,
      text: async () => JSON.stringify(data),
    };
  }
  if (mockFetchHandler) {
    const res = await mockFetchHandler(urlStr, init);
    if (res) {
      return {
        ...res,
        text: res.text || (async () => JSON.stringify(await res.json())),
      };
    }
  }
  return {
    ok: true,
    status: 200,
    json: async () => ({}),
    text: async () => '{}',
  };
};

const { default: splitHandler } = await import('../api/split.js');
const { default: participantHandler } = await import('../api/participant.js');
const { default: agentFeedHandler } = await import('../api/agent-feed.js');
const { default: captureOrderHandler } = await import('../api/capture-order.js');
const { default: createOrderHandler } = await import('../api/create-order.js');
const { default: webhookHandler } = await import('../api/paypal-webhook.js');
const { supabase } = await import('../api/_lib/supabase.js');

function mockRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(data) {
      res.body = data;
      return res;
    },
    setHeader(k, v) {
      res.headers[k] = v;
      return res;
    },
    end() {
      return res;
    },
  };
  return res;
}

// 1. Test participant handler
console.log('Testing api/participant.js...');
{
  const res = mockRes();
  await participantHandler({ method: 'GET', query: { id: 'not-a-uuid' } }, res);
  assert.equal(res.statusCode, 404, 'Invalid UUID must return 404');
  assert.equal(res.body.error, 'Participant not found');

  const resPost = mockRes();
  await participantHandler({ method: 'POST', query: { id: '11111111-1111-1111-1111-111111111111' } }, resPost);
  assert.equal(resPost.statusCode, 405, 'POST to participant must return 405');

  const origFrom = supabase.from;
  supabase.from = (table) => {
    if (table === 'participants') {
      return {
        select: () => ({
          eq: (col, val) => ({
            maybeSingle: async () => {
              if (val === '11111111-1111-1111-1111-111111111111') {
                return {
                  data: {
                    id: val,
                    name: 'Alice',
                    share: 25.5,
                    status: 'pending',
                    paypal_order_id: 'SECRET_ORDER_123',
                    paypal_capture_id: 'SECRET_CAPTURE_123',
                    split: {
                      title: 'Dinner',
                      venue: 'Bistro',
                      currency: 'USD',
                      owner_name: 'Bob',
                      receipt_path: 'private/secret.jpg',
                    },
                  },
                  error: null,
                };
              }
              return { data: null, error: null };
            },
          }),
        }),
      };
    }
    return origFrom.call(supabase, table);
  };

  const resFound = mockRes();
  await participantHandler({ method: 'GET', query: { id: '11111111-1111-1111-1111-111111111111' } }, resFound);
  assert.equal(resFound.statusCode, 200);
  assert.equal(resFound.body.id, '11111111-1111-1111-1111-111111111111');
  assert.equal(resFound.body.name, 'Alice');
  assert.equal(resFound.body.share, 25.5);
  assert.equal(resFound.body.status, 'pending');
  assert.deepEqual(resFound.body.split, {
    title: 'Dinner',
    venue: 'Bistro',
    currency: 'USD',
    owner_name: 'Bob',
  });
  assert.equal(resFound.body.paypal_order_id, undefined, 'Must not expose paypal_order_id');
  assert.equal(resFound.body.paypal_capture_id, undefined, 'Must not expose paypal_capture_id');
  assert.equal(resFound.body.split.receipt_path, undefined, 'Must not expose receipt_path');

  const resNotFound = mockRes();
  await participantHandler({ method: 'GET', query: { id: '22222222-2222-2222-2222-222222222222' } }, resNotFound);
  assert.equal(resNotFound.statusCode, 404);

  supabase.from = origFrom;
}

// 2. Test agent-feed handler
console.log('Testing api/agent-feed.js...');
{
  const resGet = mockRes();
  await agentFeedHandler({ method: 'GET', body: { splitId: '11111111-1111-1111-1111-111111111111', ownerKey: 'secret' } }, resGet);
  assert.equal(resGet.statusCode, 405, 'GET to agent-feed must return 405');

  const resInvalidId = mockRes();
  await agentFeedHandler({ method: 'POST', body: { splitId: 'bad-id', ownerKey: 'secret' } }, resInvalidId);
  assert.equal(resInvalidId.statusCode, 400);

  const origFrom = supabase.from;
  supabase.from = (table) => {
    if (table === 'split_secrets') {
      return {
        select: () => ({
          eq: (col, val) => ({
            maybeSingle: async () => {
              if (val === '11111111-1111-1111-1111-111111111111') {
                return { data: { owner_key: 'correct-key' } };
              }
              return { data: null };
            },
          }),
        }),
      };
    }
    if (table === 'agent_log') {
      return {
        select: () => ({
          eq: (col, val) => ({
            order: () => ({
              data: [
                { id: 'log-1', split_id: val, action: 'user_message', payload: { text: 'hi' } },
              ],
              error: null,
            }),
          }),
        }),
      };
    }
    return origFrom.call(supabase, table);
  };

  const resWrongKey = mockRes();
  await agentFeedHandler({ method: 'POST', body: { splitId: '11111111-1111-1111-1111-111111111111', ownerKey: 'wrong-key' } }, resWrongKey);
  assert.equal(resWrongKey.statusCode, 403, 'Wrong ownerKey must return 403');

  const resOk = mockRes();
  await agentFeedHandler({ method: 'POST', body: { splitId: '11111111-1111-1111-1111-111111111111', ownerKey: 'correct-key' } }, resOk);
  assert.equal(resOk.statusCode, 200);
  assert.equal(resOk.body.entries.length, 1);
  assert.equal(resOk.body.entries[0].action, 'user_message');

  supabase.from = origFrom;
}

// 3. Test split handler
console.log('Testing api/split.js...');
{
  const origFrom = supabase.from;
  const origStorage = supabase.storage;

  supabase.from = (table) => {
    if (table === 'splits') {
      return {
        select: () => ({
          eq: (col, val) => ({
            maybeSingle: async () => {
              if (val === '11111111-1111-1111-1111-111111111111') {
                return {
                  data: {
                    id: val,
                    owner_name: 'Bob',
                    title: 'Dinner',
                    venue: 'Bistro',
                    lat: null,
                    lng: null,
                    currency: 'USD',
                    subtotal: 50,
                    tax: 5,
                    tip: 10,
                    total: 65,
                    receipt_path: 'private/receipt123.jpg',
                    status: 'open',
                    created_at: new Date().toISOString(),
                  },
                };
              }
              return { data: null };
            },
          }),
        }),
      };
    }
    if (table === 'split_secrets') {
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: { owner_key: 'correct-owner-key' } }),
          }),
        }),
      };
    }
    if (table === 'items') {
      return {
        select: () => ({
          eq: () => ({
            order: async () => ({ data: [{ id: 'item-1', name: 'Garlic Bread', price: 20, quantity: 1 }] }),
          }),
        }),
      };
    }
    if (table === 'participants') {
      return {
        select: () => ({
          eq: () => ({
            order: async () => ({ data: [{ id: 'p-1', name: 'Alice', share: 20, status: 'pending' }] }),
          }),
        }),
      };
    }
    return origFrom.call(supabase, table);
  };

  supabase.storage = {
    from: () => ({
      createSignedUrl: async (path, exp) => ({ data: { signedUrl: `https://signed.url/${path}?exp=${exp}` } }),
    }),
  };

  const resGetWithQueryKey = mockRes();
  await splitHandler({ method: 'GET', query: { id: '11111111-1111-1111-1111-111111111111', key: 'correct-owner-key' } }, resGetWithQueryKey);
  assert.equal(resGetWithQueryKey.statusCode, 200);
  assert.equal(resGetWithQueryKey.body.isOwner, false, 'GET must ignore key in query');
  assert.equal(resGetWithQueryKey.body.receiptUrl, null, 'Public response must not include receiptUrl');
  assert.equal(resGetWithQueryKey.body.split.receipt_path, undefined, 'Public response must not expose receipt_path');

  const resPostOwner = mockRes();
  await splitHandler({ method: 'POST', body: { id: '11111111-1111-1111-1111-111111111111', ownerKey: 'correct-owner-key' } }, resPostOwner);
  assert.equal(resPostOwner.statusCode, 200);
  assert.equal(resPostOwner.body.isOwner, true, 'POST with valid ownerKey must verify owner');
  assert.ok(resPostOwner.body.receiptUrl.includes('https://signed.url/'), 'Verified owner must get signed receiptUrl');
  assert.equal(resPostOwner.body.split.receipt_path, undefined, 'Must not expose internal receipt_path even to owner');

  const resPostBadOwner = mockRes();
  await splitHandler({ method: 'POST', body: { id: '11111111-1111-1111-1111-111111111111', ownerKey: 'wrong-key' } }, resPostBadOwner);
  assert.equal(resPostBadOwner.statusCode, 200);
  assert.equal(resPostBadOwner.body.isOwner, false);
  assert.equal(resPostBadOwner.body.receiptUrl, null);

  supabase.from = origFrom;
  supabase.storage = origStorage;
}

// 4. Test capture-order endpoint currency and amount verification
console.log('Testing api/capture-order.js...');
{
  const origFrom = supabase.from;
  let markedPaidCalled = false;

  supabase.from = (table) => {
    if (table === 'participants') {
      return {
        select: (cols, opts) => ({
          eq: (col, val) => ({
            maybeSingle: async () => {
              if (val === 'ORDER_123') {
                return {
                  data: {
                    id: 'p-1',
                    share: 25.5,
                    status: 'pending',
                    paypal_order_id: 'ORDER_123',
                    split_id: 's-1',
                    split: { currency: 'USD' },
                  },
                  error: null,
                };
              }
              return { data: null, error: null };
            },
            neq: () => ({ count: 0, error: null }),
          }),
        }),
        update: () => ({
          eq: () => ({
            neq: () => ({
              select: () => ({
                maybeSingle: async () => {
                  markedPaidCalled = true;
                  return { data: { id: 'p-1', split_id: 's-1', name: 'Alice', share: 25.5 }, error: null };
                },
              }),
            }),
          }),
        }),
      };
    }
    if (table === 'agent_log') {
      return {
        insert: () => ({
          select: () => ({
            single: async () => ({ data: { id: 'log-1' }, error: null }),
          }),
        }),
      };
    }
    if (table === 'splits') {
      return {
        update: () => ({
          eq: async () => ({ error: null }),
        }),
      };
    }
    return origFrom.call(supabase, table);
  };

  // Case A: Currency mismatch (split is USD, capture returned EUR)
  markedPaidCalled = false;
  mockFetchHandler = async (url) => {
    if (url.includes('/capture')) {
      const data = {
        status: 'COMPLETED',
        purchase_units: [
          {
            payments: {
              captures: [
                { id: 'CAP_1', status: 'COMPLETED', amount: { currency_code: 'EUR', value: '25.50' } },
              ],
            },
          },
        ],
      };
      return {
        ok: true,
        status: 200,
        json: async () => data,
      };
    }
  };

  const resCurMismatch = mockRes();
  await captureOrderHandler({ method: 'POST', body: { orderId: 'ORDER_123' } }, resCurMismatch);
  assert.equal(resCurMismatch.statusCode, 409, 'Currency mismatch must return 409');
  assert.equal(resCurMismatch.body.error, 'Currency mismatch');
  assert.equal(markedPaidCalled, false, 'Payment must NOT be marked paid on currency mismatch');

  // Case B: Amount mismatch (share is 25.50, capture returned 20.00)
  markedPaidCalled = false;
  mockFetchHandler = async (url) => {
    if (url.includes('/capture')) {
      const data = {
        status: 'COMPLETED',
        purchase_units: [
          {
            payments: {
              captures: [
                { id: 'CAP_2', status: 'COMPLETED', amount: { currency_code: 'USD', value: '20.00' } },
              ],
            },
          },
        ],
      };
      return {
        ok: true,
        status: 200,
        json: async () => data,
      };
    }
  };

  const resAmtMismatch = mockRes();
  await captureOrderHandler({ method: 'POST', body: { orderId: 'ORDER_123' } }, resAmtMismatch);
  assert.equal(resAmtMismatch.statusCode, 409, 'Amount mismatch must return 409');
  assert.equal(resAmtMismatch.body.error, 'Amount mismatch');
  assert.equal(markedPaidCalled, false, 'Payment must NOT be marked paid on amount mismatch');

  // Case C: Status not COMPLETED (e.g. PENDING)
  markedPaidCalled = false;
  mockFetchHandler = async (url) => {
    if (url.includes('/capture')) {
      const data = {
        status: 'PENDING',
        purchase_units: [
          {
            payments: {
              captures: [
                { id: 'CAP_3', status: 'PENDING', amount: { currency_code: 'USD', value: '25.50' } },
              ],
            },
          },
        ],
      };
      return {
        ok: true,
        status: 200,
        json: async () => data,
      };
    }
  };

  const resPending = mockRes();
  await captureOrderHandler({ method: 'POST', body: { orderId: 'ORDER_123' } }, resPending);
  assert.equal(resPending.statusCode, 202);
  assert.equal(markedPaidCalled, false);

  // Case D: Valid capture with matching amount and currency -> marked paid
  markedPaidCalled = false;
  mockFetchHandler = async (url) => {
    if (url.includes('/capture')) {
      const data = {
        status: 'COMPLETED',
        purchase_units: [
          {
            payments: {
              captures: [
                { id: 'CAP_OK', status: 'COMPLETED', amount: { currency_code: 'USD', value: '25.50' } },
              ],
            },
          },
        ],
      };
      return {
        ok: true,
        status: 200,
        json: async () => data,
      };
    }
  };

  const resOk = mockRes();
  await captureOrderHandler({ method: 'POST', body: { orderId: 'ORDER_123' } }, resOk);
  assert.equal(resOk.statusCode, 200);
  assert.equal(markedPaidCalled, true, 'Payment must be marked paid when all checks pass');

  supabase.from = origFrom;
  mockFetchHandler = null;
}

// 5. Test create-order integrity
console.log('Testing api/create-order.js...');
{
  const origFrom = supabase.from;

  // Case A: Invalid UUID format
  const resBadId = mockRes();
  await createOrderHandler({ method: 'POST', body: { participantId: 'invalid-id' } }, resBadId);
  assert.equal(resBadId.statusCode, 400);

  // Case B: Already paid / refunded / settled
  supabase.from = (table) => {
    if (table === 'participants') {
      return {
        select: () => ({
          eq: (col, val) => ({
            maybeSingle: async () => {
              if (val === '11111111-1111-1111-1111-111111111111') {
                return { data: { id: val, status: 'paid', split: { status: 'open' } } };
              }
              if (val === '22222222-2222-2222-2222-222222222222') {
                return { data: { id: val, status: 'refunded', split: { status: 'open' } } };
              }
              if (val === '33333333-3333-3333-3333-333333333333') {
                return { data: { id: val, status: 'pending', split: { status: 'settled' } } };
              }
              return { data: null };
            },
          }),
        }),
      };
    }
    return origFrom.call(supabase, table);
  };

  const resPaid = mockRes();
  await createOrderHandler({ method: 'POST', body: { participantId: '11111111-1111-1111-1111-111111111111' } }, resPaid);
  assert.equal(resPaid.statusCode, 409);
  assert.equal(resPaid.body.error, 'Already paid');

  const resRefunded = mockRes();
  await createOrderHandler({ method: 'POST', body: { participantId: '22222222-2222-2222-2222-222222222222' } }, resRefunded);
  assert.equal(resRefunded.statusCode, 409);
  assert.equal(resRefunded.body.error, 'Payment was refunded');

  const resSettled = mockRes();
  await createOrderHandler({ method: 'POST', body: { participantId: '33333333-3333-3333-3333-333333333333' } }, resSettled);
  assert.equal(resSettled.statusCode, 409);
  assert.equal(resSettled.body.error, 'Split is already settled');

  // Case C: Database update failure when recording order ID
  supabase.from = (table) => {
    if (table === 'participants') {
      return {
        select: () => ({
          eq: (col, val) => ({
            maybeSingle: async () => ({
              data: {
                id: val,
                name: 'Alice',
                share: 15.0,
                status: 'pending',
                paypal_order_id: null,
                split: { id: 's-1', title: 'Lunch', currency: 'USD', status: 'open' },
              },
            }),
          }),
        }),
        update: () => ({
          eq: () => ({
            select: () => ({
              maybeSingle: async () => ({ data: null, error: new Error('DB write failed') }),
            }),
          }),
        }),
      };
    }
    return origFrom.call(supabase, table);
  };

  mockFetchHandler = async (url) => {
    if (url.includes('/orders')) {
      const data = { id: 'ORDER_NEW_1' };
      return { ok: true, status: 200, json: async () => data };
    }
  };

  const resDbFail = mockRes();
  await createOrderHandler({ method: 'POST', body: { participantId: '44444444-4444-4444-4444-444444444444' } }, resDbFail);
  assert.equal(resDbFail.statusCode, 500, 'Must not return order ID if DB save failed');

  // Case D: Reusing active order ID if still created/approved on PayPal
  supabase.from = (table) => {
    if (table === 'participants') {
      return {
        select: () => ({
          eq: (col, val) => ({
            maybeSingle: async () => ({
              data: {
                id: val,
                name: 'Alice',
                share: 15.0,
                status: 'pending',
                paypal_order_id: 'ORDER_EXISTING_ACTIVE',
                split: { id: 's-1', title: 'Lunch', currency: 'USD', status: 'open' },
              },
            }),
          }),
        }),
      };
    }
    return origFrom.call(supabase, table);
  };

  mockFetchHandler = async (url) => {
    if (url.includes('/orders/ORDER_EXISTING_ACTIVE')) {
      const data = {
        id: 'ORDER_EXISTING_ACTIVE',
        status: 'CREATED',
        purchase_units: [{ amount: { currency_code: 'USD', value: '15.00' } }],
      };
      return {
        ok: true,
        status: 200,
        json: async () => data,
      };
    }
    throw new Error('Should not create new order');
  };

  const resReused = mockRes();
  await createOrderHandler({ method: 'POST', body: { participantId: '55555555-5555-5555-5555-555555555555' } }, resReused);
  assert.equal(resReused.statusCode, 200);
  assert.equal(resReused.body.id, 'ORDER_EXISTING_ACTIVE');

  supabase.from = origFrom;
  mockFetchHandler = null;
}

// 6. Test paypal-webhook endpoint
console.log('Testing api/paypal-webhook.js...');
{
  const origFrom = supabase.from;
  let isSigValid = true;
  let markedPaidCalled = false;

  function makeWebhookEvent({ id = 'EVT_1', eventType = 'PAYMENT.CAPTURE.COMPLETED', orderId = 'ORD_MATCH', captureId = 'CAP_1', status = 'COMPLETED', currency = 'USD', value = '25.50' } = {}) {
    return {
      id,
      event_type: eventType,
      resource: {
        id: captureId,
        status,
        amount: { currency_code: currency, value },
        supplementary_data: orderId ? { related_ids: { order_id: orderId } } : {},
      },
    };
  }

  const existingEvents = new Set();
  supabase.from = (table) => {
    if (table === 'payment_events') {
      return {
        insert: async ({ id }) => {
          if (existingEvents.has(id)) {
            return { error: { code: '23505', message: 'duplicate key' } };
          }
          existingEvents.add(id);
          return { error: null };
        },
        delete: () => ({
          eq: (col, val) => {
            existingEvents.delete(val);
            return { error: null };
          },
        }),
      };
    }
    if (table === 'participants') {
      return {
        select: (cols, opts) => ({
          eq: (col, val) => ({
            maybeSingle: async () => {
              if (val === 'ORD_MATCH') {
                return {
                  data: {
                    id: 'p-1',
                    share: 25.5,
                    status: 'pending',
                    paypal_order_id: 'ORD_MATCH',
                    split_id: 's-1',
                    split: { currency: 'USD' },
                  },
                  error: null,
                };
              }
              return { data: null, error: null };
            },
            neq: () => ({ count: 0, error: null }),
          }),
        }),
        update: () => ({
          eq: () => ({
            neq: () => ({
              select: () => ({
                maybeSingle: async () => {
                  markedPaidCalled = true;
                  return { data: { id: 'p-1', split_id: 's-1', name: 'Alice', share: 25.5 }, error: null };
                },
              }),
            }),
            select: () => ({
              maybeSingle: async () => ({ data: { id: 'p-1', split_id: 's-1' }, error: null }),
            }),
          }),
        }),
      };
    }
    if (table === 'agent_log') {
      return {
        insert: () => ({
          select: () => ({
            single: async () => ({ data: { id: 'log-1' }, error: null }),
          }),
        }),
      };
    }
    if (table === 'splits') {
      return {
        update: () => ({
          eq: () => ({
            eq: async () => ({ error: null }),
          }),
        }),
      };
    }
    return origFrom.call(supabase, table);
  };

  mockFetchHandler = async (url) => {
    if (url.includes('/verify-webhook-signature')) {
      const data = { verification_status: isSigValid ? 'SUCCESS' : 'FAILURE' };
      return {
        ok: true,
        status: 200,
        json: async () => data,
      };
    }
  };

  // Test 1: Invalid webhook signature -> 401, never mark paid
  isSigValid = false;
  markedPaidCalled = false;
  const resBadSig = mockRes();
  await webhookHandler(
    {
      method: 'POST',
      headers: { 'paypal-auth-algo': 'SHA256withRSA' },
      body: JSON.stringify(makeWebhookEvent({ id: 'EVT_BAD_SIG' })),
    },
    resBadSig
  );
  assert.equal(resBadSig.statusCode, 401, 'Invalid signature must return 401');
  assert.equal(markedPaidCalled, false, 'Must never mark paid on invalid signature');

  // Set signature verification to true for remaining tests
  isSigValid = true;

  // Test 2: Valid completed capture matched through related order ID
  markedPaidCalled = false;
  const resValid = mockRes();
  await webhookHandler(
    {
      method: 'POST',
      headers: {},
      body: JSON.stringify(makeWebhookEvent({ id: 'EVT_VALID' })),
    },
    resValid
  );
  assert.equal(resValid.statusCode, 200);
  assert.equal(resValid.body.ok, true);
  assert.equal(markedPaidCalled, true, 'Valid capture must mark participant paid');

  // Test 3: Duplicate webhook delivery -> 200 { duplicate: true }, never mark paid again
  markedPaidCalled = false;
  const resDup = mockRes();
  await webhookHandler(
    {
      method: 'POST',
      headers: {},
      body: JSON.stringify(makeWebhookEvent({ id: 'EVT_VALID' })),
    },
    resDup
  );
  assert.equal(resDup.statusCode, 200);
  assert.equal(resDup.body.duplicate, true, 'Duplicate delivery must be recognized');
  assert.equal(markedPaidCalled, false, 'Duplicate event must not trigger markPaid again');

  // Test 4: Missing related order ID -> 200 acknowledged, payment NOT marked paid
  markedPaidCalled = false;
  const resNoOrder = mockRes();
  await webhookHandler(
    {
      method: 'POST',
      headers: {},
      body: JSON.stringify(makeWebhookEvent({ id: 'EVT_NO_ORDER', orderId: null })),
    },
    resNoOrder
  );
  assert.equal(resNoOrder.statusCode, 200);
  assert.equal(resNoOrder.body.acknowledged, true);
  assert.equal(markedPaidCalled, false, 'Missing related order ID must never mark paid');

  // Test 5: Unknown/unmatched related order ID -> 200 acknowledged, payment NOT marked paid
  markedPaidCalled = false;
  const resUnknownOrder = mockRes();
  await webhookHandler(
    {
      method: 'POST',
      headers: {},
      body: JSON.stringify(makeWebhookEvent({ id: 'EVT_UNKNOWN_ORDER', orderId: 'ORD_UNKNOWN' })),
    },
    resUnknownOrder
  );
  assert.equal(resUnknownOrder.statusCode, 200);
  assert.equal(resUnknownOrder.body.acknowledged, true);
  assert.equal(markedPaidCalled, false, 'Unknown order ID must never mark paid');

  // Test 6: Amount mismatch -> 200 acknowledged, payment NOT marked paid
  markedPaidCalled = false;
  const resAmtMismatch = mockRes();
  await webhookHandler(
    {
      method: 'POST',
      headers: {},
      body: JSON.stringify(makeWebhookEvent({ id: 'EVT_AMT_MISMATCH', value: '10.00' })),
    },
    resAmtMismatch
  );
  assert.equal(resAmtMismatch.statusCode, 200);
  assert.equal(resAmtMismatch.body.acknowledged, true);
  assert.equal(markedPaidCalled, false, 'Amount mismatch must never mark paid');

  // Test 7: Currency mismatch -> 200 acknowledged, payment NOT marked paid
  markedPaidCalled = false;
  const resCurMismatch = mockRes();
  await webhookHandler(
    {
      method: 'POST',
      headers: {},
      body: JSON.stringify(makeWebhookEvent({ id: 'EVT_CUR_MISMATCH', currency: 'EUR' })),
    },
    resCurMismatch
  );
  assert.equal(resCurMismatch.statusCode, 200);
  assert.equal(resCurMismatch.body.acknowledged, true);
  assert.equal(markedPaidCalled, false, 'Currency mismatch must never mark paid');

  // Test 8: Non-COMPLETED capture status (e.g. FAILED) -> acknowledged, payment NOT marked paid
  markedPaidCalled = false;
  const resNotCompleted = mockRes();
  await webhookHandler(
    {
      method: 'POST',
      headers: {},
      body: JSON.stringify(makeWebhookEvent({ id: 'EVT_NOT_COMPLETED', status: 'FAILED' })),
    },
    resNotCompleted
  );
  assert.equal(resNotCompleted.statusCode, 200);
  assert.equal(resNotCompleted.body.acknowledged, true);
  assert.equal(markedPaidCalled, false, 'Non-completed capture status must never mark paid');

  // Restore mocks
  supabase.from = origFrom;
  mockFetchHandler = null;
  globalThis.fetch = origFetch;
}

console.log('All security, API endpoint, and PayPal payment verification tests passed successfully!');
