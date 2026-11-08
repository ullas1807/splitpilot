import { randomBytes } from 'node:crypto';
import { supabase } from './_lib/supabase.js';
import { allowMethod, sanitizeText, logEvent, LIMITS } from './_lib/http.js';
import { normalizeReceipt, CURRENCIES } from './_lib/receipt.js';
import { sanitizeName } from './_lib/agent-tools.js';

const inRange = (n, min, max) => typeof n === 'number' && Number.isFinite(n) && n >= min && n <= max;

export default async function handler(req, res) {
  if (!allowMethod(req, res, 'POST')) return;
  try {
    const b = req.body || {};
    const owner_name = sanitizeText(b.owner_name, 40);
    if (!owner_name) return res.status(400).json({ error: 'Please enter your name.' });
    const currency = CURRENCIES.includes(b.currency) ? b.currency : 'USD';

    const r = normalizeReceipt({ items: b.items, tax: b.tax, tip: b.tip });
    if (!r.items.length) return res.status(400).json({ error: 'Add at least one item with a price.' });
    if (r.total > LIMITS.maxSplitTotal) return res.status(400).json({ error: `Bills over ${LIMITS.maxSplitTotal} ${currency} are not supported in this demo.` });

    const venue = sanitizeText(b.venue, 80);
    const lat = inRange(b.lat, -90, 90) ? b.lat : null;
    const lng = inRange(b.lng, -180, 180) ? b.lng : null;
    const receipt_path = typeof b.receipt_path === 'string' && /^[\w-]+\.(jpg|png|webp)$/.test(b.receipt_path) ? b.receipt_path : null;

    const { data: split, error } = await supabase
      .from('splits')
      .insert({
        owner_name, title: venue || 'Group bill', venue: venue || null, lat, lng, currency,
        subtotal: r.subtotal, tax: r.tax, tip: r.tip, total: r.total, receipt_path,
      })
      .select('id')
      .single();
    if (error) throw error;

    const { error: itemsErr } = await supabase
      .from('items')
      .insert(r.items.map((i) => ({ split_id: split.id, name: i.name, price: i.line_total, quantity: i.quantity })));
    if (itemsErr) {
      await supabase.from('splits').delete().eq('id', split.id);
      throw itemsErr;
    }

    const ownerKey = randomBytes(24).toString('hex');
    const { error: secretErr } = await supabase.from('split_secrets').insert({ split_id: split.id, owner_key: ownerKey });
    if (secretErr) {
      await supabase.from('splits').delete().eq('id', split.id);
      throw secretErr;
    }

    let exampleText = 'Dinner was me, Asha and Ravi. Asha had the first item, Ravi and I shared the second.';
    if (Array.isArray(r.items) && r.items.length >= 2) {
      const item1 = sanitizeName(r.items[0]?.name, 30).toLowerCase();
      const item2 = sanitizeName(r.items[1]?.name, 30).toLowerCase();
      if (item1 && item2) {
        exampleText = `Dinner was me, Asha and Ravi. Asha had the ${item1}, Ravi and I shared the ${item2}.`;
      }
    } else if (Array.isArray(r.items) && r.items.length === 1) {
      const item1 = sanitizeName(r.items[0]?.name, 30).toLowerCase();
      if (item1) {
        exampleText = `Dinner was me, Asha and Ravi. We shared the ${item1}.`;
      }
    }

    await logEvent(split.id, 'agent_message', {
      payload: { text: `Receipt loaded: ${r.items.length} items, total ${r.total.toFixed(2)} ${currency}. Tell me who was at dinner and who had what, for example "${exampleText}" I'll draft a split for you to approve.` },
    });

    return res.status(200).json({ splitId: split.id, ownerKey });
  } catch (err) {
    console.error('create-split failed', err);
    return res.status(500).json({ error: 'Could not create the split.' });
  }
}
