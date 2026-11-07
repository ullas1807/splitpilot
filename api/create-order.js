import { randomUUID } from 'node:crypto';
import { supabase } from './_lib/supabase.js';
import { paypalFetch } from './_lib/paypal.js';
import { UUID_RE } from './_lib/http.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { participantId } = req.body || {};
    if (!participantId || !UUID_RE.test(String(participantId))) {
      return res.status(400).json({ error: 'Valid participantId required' });
    }

    // SECURITY: the amount comes from the database, never from the browser.
    const { data: p, error } = await supabase
      .from('participants')
      .select('id, name, share, status, paypal_order_id, split:splits(id, title, currency, status)')
      .eq('id', participantId)
      .maybeSingle();

    if (error || !p) return res.status(404).json({ error: 'Payment request not found' });

    // Reject paid, refunded or settled payment requests
    if (p.status === 'paid') return res.status(409).json({ error: 'Already paid' });
    if (p.status === 'refunded') return res.status(409).json({ error: 'Payment was refunded' });
    if (p.split?.status === 'settled') return res.status(409).json({ error: 'Split is already settled' });
    if (p.status !== 'pending' && p.status !== 'failed') {
      return res.status(409).json({ error: 'Payment request is not in a payable state' });
    }

    const value = Number(p.share).toFixed(2);
    const currency = p.split?.currency || 'USD';

    // Avoid creating multiple uncontrolled active orders for one participant:
    // If an existing order was created, verify if it is still active and reusable.
    if (p.paypal_order_id) {
      try {
        const existingOrder = await paypalFetch(`/v2/checkout/orders/${p.paypal_order_id}`);
        if (existingOrder && (existingOrder.status === 'CREATED' || existingOrder.status === 'APPROVED')) {
          const unit = existingOrder.purchase_units?.[0];
          if (unit?.amount?.currency_code === currency && unit?.amount?.value === value) {
            return res.status(200).json({ id: existingOrder.id });
          }
        }
      } catch {
        // If the existing order expired or was invalid on PayPal, create a new one below
      }
    }

    const order = await paypalFetch('/v2/checkout/orders', {
      method: 'POST',
      requestId: `order-${p.id}-${randomUUID()}`,
      body: {
        intent: 'CAPTURE',
        purchase_units: [
          {
            reference_id: p.id,
            custom_id: p.id, // comes back on the webhook so we know who paid
            description: `${p.split.title} - ${p.name}'s share`.slice(0, 127),
            amount: { currency_code: currency, value },
          },
        ],
      },
    });

    // Check the Supabase update result when saving paypal_order_id
    const { data: updated, error: updateErr } = await supabase
      .from('participants')
      .update({ paypal_order_id: order.id })
      .eq('id', p.id)
      .select('id, paypal_order_id')
      .maybeSingle();

    if (updateErr || !updated || updated.paypal_order_id !== order.id) {
      console.error('Failed to associate PayPal order with participant', updateErr);
      return res.status(500).json({ error: 'Failed to record PayPal order' });
    }

    return res.status(200).json({ id: order.id });
  } catch (err) {
    console.error('create-order failed', err.details || err.message);
    return res.status(500).json({ error: 'Could not create PayPal order' });
  }
}
