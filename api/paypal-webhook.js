import { supabase } from './_lib/supabase.js';
import { verifyWebhookSignature, refundCaptureId } from './_lib/paypal.js';
import { getRawBody } from './_lib/raw-body.js';
import { markPaid } from './_lib/payments.js';
import { logEvent } from './_lib/http.js';

// Vercel Serverless Function configuration: disable automatic body parsing to preserve raw bytes
export const config = {
  api: {
    bodyParser: false,
  },
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  let rawBody;
  try {
    rawBody = await getRawBody(req);
  } catch (err) {
    return res.status(400).json({ error: 'Failed to read request body' });
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return res.status(400).json({ error: 'Malformed JSON payload' });
  }

  if (!event || !event.id || !event.event_type) {
    return res.status(400).json({ error: 'Invalid webhook payload structure' });
  }

  try {
    // 1) Never trust an unsigned webhook. Verify using original raw JSON payload.
    const isVerified = await verifyWebhookSignature(req.headers, rawBody);
    if (!isVerified) {
      console.warn(`Webhook signature verification failed for event ${event.id}`);
      return res.status(401).json({ error: 'Invalid signature' });
    }

    // 2) Idempotency: PayPal retries, so ignore events we've already stored.
    const { error: insertErr } = await supabase
      .from('payment_events')
      .insert({ id: event.id, type: event.event_type, payload: event });
    if (insertErr?.code === '23505') return res.status(200).json({ duplicate: true });
    if (insertErr) throw insertErr;

    // 3) Handle the events we care about. If database throws, release event id so retry works.
    try {
      const resource = event.resource || {};

      if (event.event_type === 'PAYMENT.CAPTURE.COMPLETED') {
        const captureId = resource.id;
        const captureStatus = resource.status;
        const orderId = resource.supplementary_data?.related_ids?.order_id;

        if (!captureId || captureStatus !== 'COMPLETED' || !orderId) {
          console.warn(`Webhook ${event.id}: rejected missing capture ID, non-COMPLETED status, or missing order_id`, {
            captureId,
            captureStatus,
            hasOrderId: !!orderId,
          });
          return res.status(200).json({ acknowledged: true, rejected: 'Missing required completion fields' });
        }

        // Look up participant by the stored paypal_order_id
        const { data: p, error: pErr } = await supabase
          .from('participants')
          .select('id, share, status, paypal_order_id, split_id, split:splits(currency)')
          .eq('paypal_order_id', orderId)
          .maybeSingle();

        if (pErr) throw pErr;

        if (!p) {
          console.warn(`Webhook ${event.id}: no participant found for related order ${orderId}`);
          return res.status(200).json({ acknowledged: true, rejected: 'Unknown order' });
        }

        if (p.paypal_order_id !== orderId) {
          console.warn(`Webhook ${event.id}: order ID mismatch`);
          return res.status(200).json({ acknowledged: true, rejected: 'Order ID mismatch' });
        }

        // Verify capture.amount.value against participant.share using integer cents
        const captureCents = Math.round(Number(resource.amount?.value) * 100);
        const shareCents = Math.round(Number(p.share) * 100);
        if (!Number.isFinite(captureCents) || captureCents !== shareCents) {
          console.warn(`Webhook ${event.id}: amount mismatch`, { captureCents, shareCents });
          return res.status(200).json({ acknowledged: true, rejected: 'Amount mismatch' });
        }

        // Verify capture.amount.currency_code against associated split currency
        const splitCurrency = p.split?.currency;
        if (!splitCurrency || resource.amount?.currency_code !== splitCurrency) {
          console.warn(`Webhook ${event.id}: currency mismatch`, {
            captureCurrency: resource.amount?.currency_code,
            splitCurrency,
          });
          return res.status(200).json({ acknowledged: true, rejected: 'Currency mismatch' });
        }

        // All checks passed: mark participant paid
        await markPaid({ participantId: p.id, captureId });
      } else if (event.event_type === 'PAYMENT.CAPTURE.DENIED') {
        const orderId = resource.supplementary_data?.related_ids?.order_id;
        if (orderId) {
          const { data: p, error: pErr } = await supabase
            .from('participants')
            .select('id, status')
            .eq('paypal_order_id', orderId)
            .maybeSingle();

          if (pErr) throw pErr;

          // Update only matching unpaid participant
          if (p && p.status !== 'paid' && p.status !== 'refunded') {
            await supabase.from('participants').update({ status: 'failed' }).eq('id', p.id);
          }
        }
      } else if (event.event_type === 'PAYMENT.CAPTURE.REFUNDED') {
        // For refund events resource.id is the REFUND id; the capture id is in the "up" link.
        const captureId = refundCaptureId(resource);
        if (captureId) {
          const { data: p, error: pErr } = await supabase
            .from('participants')
            .update({ status: 'refunded' })
            .eq('paypal_capture_id', captureId)
            .select('id, split_id')
            .maybeSingle();

          if (pErr) throw pErr;

          // Ensure split status remains consistent: if split was settled, reopen to 'open'
          if (p?.split_id) {
            await supabase
              .from('splits')
              .update({ status: 'open' })
              .eq('id', p.split_id)
              .eq('status', 'settled');

            try {
              await logEvent(p.split_id, 'payment_refunded', {
                reasoning: 'A payment was refunded. Split status updated to open.',
                payload: { participant_id: p.id, capture_id: captureId },
              });
            } catch (e) {
              console.error('log payment_refunded failed', e);
            }
          }
        }
      }
    } catch (handlerErr) {
      await supabase.from('payment_events').delete().eq('id', event.id);
      throw handlerErr;
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('webhook failed', err.details || err.message);
    return res.status(500).json({ error: 'Webhook processing failed' }); // PayPal will retry
  }
}
