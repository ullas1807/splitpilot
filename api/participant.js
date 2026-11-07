import { supabase } from './_lib/supabase.js';
import { allowMethod, UUID_RE } from './_lib/http.js';

export default async function handler(req, res) {
  if (!allowMethod(req, res, 'GET')) return;

  try {
    const id = req.query.id || req.query.participantId;
    if (!UUID_RE.test(String(id || ''))) {
      return res.status(404).json({ error: 'Participant not found' });
    }

    const { data: p, error } = await supabase
      .from('participants')
      .select('id, name, share, status, split:splits(title, venue, currency, owner_name)')
      .eq('id', id)
      .maybeSingle();

    if (error || !p || !p.split) {
      return res.status(404).json({ error: 'Participant not found' });
    }

    const payload = {
      id: p.id,
      name: p.name,
      share: p.share,
      status: p.status,
      split: {
        title: p.split.title,
        venue: p.split.venue,
        currency: p.split.currency,
        owner_name: p.split.owner_name,
      },
    };

    return res.status(200).json({ ...payload, participant: payload });
  } catch (err) {
    console.error('participant failed', err);
    return res.status(500).json({ error: 'Could not load participant details.' });
  }
}
