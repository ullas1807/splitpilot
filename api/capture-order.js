import { supabase } from './_lib/supabase.js';
import { paypalFetch } from './_lib/paypal.js';
import { markPaid } from './_lib/payments.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { orderId } = req.body || {};
    if (!orderId) return res.status(400).json({ error: 'orderId required' });

    // Only capture orders that WE created and belong to a recorded participant
    const { data: p, error: pErr } = await supabase
      .from('participants')
      .select('id, share, status, paypal_order_id, split_id, split:splits(currency)')
      .eq('paypal_order_id', orderId)
      .maybeSingle();

    if (pErr) throw pErr;
    if (!p) return res.status(404).json({ error: 'Unknown order' });
    if (p.status === 'paid') return res.status(200).json({ status: 'COMPLETED', alreadyPaid: true });

    const result = await paypalFetch(`/v2/checkout/orders/${orderId}/capture`, {
      method: 'POST',
      requestId: `capture-${orderId}`,
    });

    const capture = result.purchase_units?.[0]?.payments?.captures?.[0];
    if (!capture || capture.status !== 'COMPLETED') {
      return res.status(202).json({ status: capture?.status || result.status });
    }

    // Defense in depth: confirm captured amount matches the share exactly in integer cents
    const captureCents = Math.round(Number(capture.amount?.value) * 100);
    const shareCents = Math.round(Number(p.share) * 100);
    if (!Number.isFinite(captureCents) || captureCents !== shareCents) {
      console.error('Amount mismatch', { captureCents, shareCents });
      return res.status(409).json({ error: 'Amount mismatch' });
    }

    // Verify capture currency_code matches the split currency
    const splitCurrency = p.split?.currency;
    if (!splitCurrency || capture.amount?.currency_code !== splitCurrency) {
      console.error('Currency mismatch', { captureCurrency: capture.amount?.currency_code, splitCurrency });
      return res.status(409).json({ error: 'Currency mismatch' });
    }

    await markPaid({ participantId: p.id, captureId: capture.id });
    return res.status(200).json({ status: 'COMPLETED', captureId: capture.id });
  } catch (err) {
    console.error('capture-order failed', err.details || err.message);
    const declined = err.details?.details?.[0]?.issue === 'INSTRUMENT_DECLINED';
    return res
      .status(declined ? 422 : 500)
      .json({ error: declined ? 'Payment method declined, please try again' : 'Capture failed' });
  }
}
