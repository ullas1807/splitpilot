import { supabase } from './supabase.js';
import { logEvent } from './http.js';

// Idempotent: safe to call from BOTH capture-order and the webhook. First writer wins.
export async function markPaid({ participantId, captureId }) {
  const { data, error } = await supabase
    .from('participants')
    .update({ status: 'paid', paypal_capture_id: captureId, paid_at: new Date().toISOString() })
    .eq('id', participantId)
    .neq('status', 'paid')
    .select('id, split_id, name, share')
    .maybeSingle();

  if (error) throw error;
  if (!data) return { alreadyPaid: true };

  try {
    await logEvent(data.split_id, 'payment_received', {
      reasoning: `${data.name} paid their share`,
      payload: { participant_id: data.id, name: data.name, amount: Number(data.share), capture_id: captureId },
    });
  } catch (e) {
    console.error('log payment failed', e); // never fail the payment because of logging
  }

  const { count } = await supabase
    .from('participants')
    .select('id', { count: 'exact', head: true })
    .eq('split_id', data.split_id)
    .neq('status', 'paid');

  if (count === 0) {
    await supabase.from('splits').update({ status: 'settled' }).eq('id', data.split_id);
    try {
      await logEvent(data.split_id, 'settled', { reasoning: 'Everyone has paid. This split is settled.' });
    } catch (e) {
      console.error('log settled failed', e);
    }
  }
  return { alreadyPaid: false, splitId: data.split_id };
}
