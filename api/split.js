import { supabase } from './_lib/supabase.js';
import { allowMethod, assertOwner, UUID_RE } from './_lib/http.js';

export default async function handler(req, res) {
  if (!allowMethod(req, res, 'GET', 'POST')) return;
  try {
    const isPost = req.method === 'POST';
    const id = isPost ? (req.body?.id || req.query?.id) : req.query?.id;
    const ownerKey = isPost ? (req.body?.ownerKey || req.body?.key) : null;

    if (!UUID_RE.test(String(id || ''))) return res.status(400).json({ error: 'Invalid split id' });

    const { data: split } = await supabase
      .from('splits')
      .select('id, owner_name, title, venue, lat, lng, currency, subtotal, tax, tip, total, receipt_path, status, created_at')
      .eq('id', id)
      .maybeSingle();

    if (!split) return res.status(404).json({ error: 'Split not found' });

    const isOwner = ownerKey ? await assertOwner(id, ownerKey) : false;
    const [{ data: items }, { data: participants }] = await Promise.all([
      supabase.from('items').select('id, name, price, quantity').eq('split_id', id).order('name'),
      supabase.from('participants').select('id, name, share, status, paid_at, last_reminded_at').eq('split_id', id).order('name'),
    ]);

    let receiptUrl = null;
    if (isOwner && split.receipt_path) {
      const { data } = await supabase.storage.from('receipts').createSignedUrl(split.receipt_path, 3600);
      receiptUrl = data?.signedUrl || null;
    }

    const { receipt_path, ...publicSplit } = split;

    return res.status(200).json({
      split: publicSplit,
      items: items || [],
      participants: participants || [],
      isOwner,
      receiptUrl,
    });
  } catch (err) {
    console.error('split failed', err);
    return res.status(500).json({ error: 'Could not load the split.' });
  }
}
