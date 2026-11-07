import { supabase } from './_lib/supabase.js';
import { allowMethod, assertOwner, UUID_RE } from './_lib/http.js';

export default async function handler(req, res) {
  if (!allowMethod(req, res, 'POST')) return;

  try {
    const { splitId, ownerKey } = req.body || {};

    if (!UUID_RE.test(String(splitId || ''))) {
      return res.status(400).json({ error: 'Invalid split id' });
    }

    if (!(await assertOwner(splitId, ownerKey))) {
      return res.status(403).json({ error: 'Only the owner can view the agent feed.' });
    }

    const { data, error } = await supabase
      .from('agent_log')
      .select('*')
      .eq('split_id', splitId)
      .order('created_at', { ascending: true });

    if (error) throw error;

    return res.status(200).json({ entries: data || [] });
  } catch (err) {
    console.error('agent-feed failed', err);
    return res.status(500).json({ error: 'Could not load the agent feed.' });
  }
}
