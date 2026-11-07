// Sandbox by default. Set PAYPAL_ENV=live ONLY for real production use (not for this hackathon).
const BASE =
  process.env.PAYPAL_ENV === 'live'
    ? 'https://api-m.paypal.com'
    : 'https://api-m.sandbox.paypal.com';

let cached = { token: null, expiresAt: 0 };

export async function getAccessToken() {
  if (cached.token && Date.now() < cached.expiresAt) return cached.token;

  const auth = Buffer.from(
    `${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`
  ).toString('base64');

  const res = await fetch(`${BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });

  if (!res.ok) throw new Error(`PayPal auth failed (${res.status})`);
  const data = await res.json();
  cached = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in - 60) * 1000,
  };
  return cached.token;
}

export async function paypalFetch(path, { method = 'GET', body, rawBody, requestId } = {}) {
  const token = await getAccessToken();
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
  if (requestId) headers['PayPal-Request-Id'] = requestId; // idempotency key

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: rawBody !== undefined ? rawBody : (body ? JSON.stringify(body) : undefined),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.message || `PayPal error ${res.status}`);
    err.status = res.status;
    err.details = data;
    throw err;
  }
  return data;
}

export async function verifyWebhookSignature(headers, rawBody) {
  const webhookId = process.env.PAYPAL_WEBHOOK_ID;
  if (!webhookId) {
    console.warn('PAYPAL_WEBHOOK_ID is not configured');
    return false;
  }

  // Preserve the exact raw webhook_event JSON string without reserializing
  const postBody =
    JSON.stringify({
      auth_algo: headers['paypal-auth-algo'],
      cert_url: headers['paypal-cert-url'],
      transmission_id: headers['paypal-transmission-id'],
      transmission_sig: headers['paypal-transmission-sig'],
      transmission_time: headers['paypal-transmission-time'],
      webhook_id: webhookId,
    }).slice(0, -1) + `,"webhook_event":${rawBody.trim()}}`;

  const result = await paypalFetch('/v1/notifications/verify-webhook-signature', {
    method: 'POST',
    rawBody: postBody,
  });

  return result.verification_status === 'SUCCESS';
}

// PAYMENT.CAPTURE.REFUNDED: resource.id is the refund's own id. The original capture id is in the
// "up" link (.../v2/payments/captures/<CAPTURE_ID>), or in supplementary_data when present.
export function refundCaptureId(resource = {}) {
  const fromRelated = resource.supplementary_data?.related_ids?.capture_id;
  if (fromRelated) return fromRelated;
  const up = (resource.links || []).find((l) => l?.rel === 'up' && /\/captures\/([A-Za-z0-9]+)/.test(l.href || ''));
  const m = up?.href.match(/\/captures\/([A-Za-z0-9]+)/);
  return m ? m[1] : null;
}
