// Webhook body reading + refund capture-id extraction. Offline.
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';

process.env.SUPABASE_URL ||= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';
const { getRawBody } = await import('../api/_lib/raw-body.js');
const { refundCaptureId } = await import('../api/_lib/paypal.js');

const payload = '{"id":"EVT1","event_type":"X","amount":10.50,"note":"caf\u00e9"}';
const quick = { timeoutMs: 400 };
const stream = (str) => { const r = Readable.from([Buffer.from(str)]); r.body = undefined; return r; };

// A) bodyParser disabled: raw stream, bytes must come back EXACTLY (10.50 must not become 10.5)
assert.equal(await getRawBody(stream(payload), quick), payload);

// B) split across several chunks
const chunked = Readable.from([Buffer.from(payload.slice(0, 10)), Buffer.from(payload.slice(10))]); chunked.body = undefined;
assert.equal(await getRawBody(chunked, quick), payload);

// C) string / Buffer bodies
assert.equal(await getRawBody({ body: payload }), payload);
assert.equal(await getRawBody({ body: Buffer.from(payload) }), payload);

// D) parser already ran and consumed the stream: must NOT hang, must return JSON
const parsed = Readable.from([]); parsed.body = JSON.parse(payload);
await new Promise((r) => { parsed.resume(); parsed.on('end', r); });
const t0 = Date.now();
const out = await getRawBody(parsed, quick);
assert.ok(Date.now() - t0 < 300, 'must return immediately, not wait for a timeout');
assert.deepEqual(JSON.parse(out), JSON.parse(payload));

// E) consumed stream with no body: fail fast with a clear error
const dead = Readable.from([]); dead.body = undefined;
await new Promise((r) => { dead.resume(); dead.on('end', r); });
await assert.rejects(getRawBody(dead, quick), /already consumed/);

// F) oversize payload is rejected
const big = Readable.from([Buffer.alloc(2000, 'a')]); big.body = undefined;
await assert.rejects(getRawBody(big, { limit: 1000, timeoutMs: 400 }), /too large/);

// G) stalled stream times out instead of hanging forever
const stalled = new Readable({ read() {} }); stalled.body = undefined;
await assert.rejects(getRawBody(stalled, { timeoutMs: 100 }), /Timed out/);

// Refund events: resource.id is the REFUND id. The capture id is in the "up" link.
const refund = {
  id: 'REFUND123',
  links: [
    { href: 'https://api.sandbox.paypal.com/v2/payments/refunds/REFUND123', rel: 'self' },
    { href: 'https://api.sandbox.paypal.com/v2/payments/captures/CAPTURE456', rel: 'up' },
  ],
};
assert.equal(refundCaptureId(refund), 'CAPTURE456');
assert.equal(refundCaptureId({ id: 'R', supplementary_data: { related_ids: { capture_id: 'CAP9' } } }), 'CAP9');
assert.equal(refundCaptureId({ id: 'R', links: [] }), null, 'never fall back to the refund id');
assert.equal(refundCaptureId(), null);

console.log('raw-body + refund id: all tests passed');
