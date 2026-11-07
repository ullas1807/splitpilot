import { supabase } from './_lib/supabase.js';
import { allowMethod, assertOwner, logEvent, sanitizeText, LIMITS } from './_lib/http.js';
import { toCents } from './_lib/receipt.js';

// THE GUARDRAIL: money requests only exist after a human clicks approve on this endpoint.
export default async function handler(req, res) {
  if (!allowMethod(req, res, 'POST')) return;
  try {
    const { splitId, ownerKey, logId, decision } = req.body || {};
    if (!(await assertOwner(splitId, ownerKey))) return res.status(403).json({ error: 'Only the owner can approve.' });
    if (!['approve', 'reject'].includes(decision)) return res.status(400).json({ error: 'Invalid decision' });

    if (decision === 'reject') {
      const { data } = await supabase.from('agent_log').update({ status: 'rejected', approved_by_human: false })
        .eq('id', logId).eq('split_id', splitId).eq('action', 'proposal').eq('status', 'pending').select('id').maybeSingle();
      if (!data) return res.status(409).json({ error: 'That proposal is no longer pending.' });
      await logEvent(splitId, 'agent_message', { payload: { text: 'No problem, I discarded that proposal. Tell me what to change.' } });
      return res.status(200).json({ ok: true });
    }

    // Atomically claim the proposal so a double-click cannot create duplicate requests.
    const { data: log } = await supabase.from('agent_log').update({ status: 'approved', approved_by_human: true })
      .eq('id', logId).eq('split_id', splitId).eq('action', 'proposal').eq('status', 'pending').select('*').maybeSingle();
    if (!log) return res.status(409).json({ error: 'That proposal is no longer pending.' });

    const revert = () => supabase.from('agent_log').update({ status: 'pending', approved_by_human: false }).eq('id', logId);

    const { data: split } = await supabase.from('splits').select('total, currency').eq('id', splitId).single();
    const requests = Array.isArray(log.payload?.requests) ? log.payload.requests : [];
    const sum = requests.reduce((a, r) => a + (Number(r.amount_cents) || 0), 0);
    const valid =
      requests.length > 0 && requests.length <= LIMITS.maxPeople &&
      requests.every((r) => Number.isInteger(r.amount_cents) && r.amount_cents > 0 && r.amount_cents / 100 <= LIMITS.maxPerPerson && sanitizeText(r.name, 40)) &&
      sum <= toCents(split.total);
    if (!valid) { await revert(); return res.status(422).json({ error: 'Proposal failed safety checks.' }); }

    const { count } = await supabase.from('participants').select('id', { count: 'exact', head: true }).eq('split_id', splitId);
    if (count > 0) { await revert(); return res.status(409).json({ error: 'Payment requests already exist.' }); }

    const { data: rows, error } = await supabase.from('participants')
      .insert(requests.map((r) => ({ split_id: splitId, name: sanitizeText(r.name, 40), share: r.amount_cents / 100 })))
      .select('id, name, share');
    if (error) { await revert(); throw error; }

    await logEvent(splitId, 'approved', {
      reasoning: `You approved ${rows.length} payment request${rows.length > 1 ? 's' : ''}`,
      payload: { count: rows.length, total_cents: sum },
    });
    return res.status(200).json({ ok: true, participants: rows });
  } catch (err) {
    console.error('approve failed', err);
    return res.status(500).json({ error: 'Could not approve.' });
  }
}
