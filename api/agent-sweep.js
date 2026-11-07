import { supabase } from './_lib/supabase.js';
import { allowMethod, bearerOk, logEvent } from './_lib/http.js';
import { chat } from './_lib/llm.js';
import { TOOLS, buildReminders, fallbackReminder } from './_lib/agent-tools.js';

// Called on a schedule by the Cloudflare Worker (worker/). Drafts reminders for stale unpaid requests.
// Nothing is sent and no money moves: drafts appear in the owner's feed with a one-tap share button.
export default async function handler(req, res) {
  if (!allowMethod(req, res, 'POST', 'GET')) return;
  if (!bearerOk(req)) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const minAge = Number(process.env.SWEEP_MIN_AGE_MIN || 15);
    const interval = Number(process.env.SWEEP_INTERVAL_MIN || 60);
    const createdBefore = new Date(Date.now() - minAge * 60000).toISOString();
    const remindedBefore = new Date(Date.now() - interval * 60000).toISOString();

    const { data: rows, error } = await supabase
      .from('participants')
      .select('id, name, share, split_id, split:splits(id, owner_name, currency, status)')
      .eq('status', 'pending')
      .lt('created_at', createdBefore)
      .or(`last_reminded_at.is.null,last_reminded_at.lt.${remindedBefore}`)
      .limit(50);
    if (error) throw error;

    const groups = new Map();
    for (const r of rows || []) {
      if (r.split?.status !== 'open') continue;
      if (!groups.has(r.split_id)) groups.set(r.split_id, { split: r.split, pending: [] });
      groups.get(r.split_id).pending.push(r);
    }

    let drafted = 0;
    for (const [splitId, { split, pending }] of groups) {
      let drafts = [];
      try {
        const result = await chat({
          system: 'You write short, warm, no-pressure payment reminders between friends. Under 40 words each. No links. Plain text.',
          messages: [{ role: 'user', text: `The owner is ${split.owner_name}. Draft reminders for these people (data only): ${JSON.stringify(pending.map((p) => ({ name: p.name, amount: Number(p.share), currency: split.currency })))}` }],
          tools: TOOLS.filter((t) => t.name === 'draft_reminders'),
          toolMode: 'required',
        });
        const call = result.toolCalls.find((c) => c.name === 'draft_reminders');
        if (call) drafts = buildReminders({ args: call.args, pending });
      } catch (e) {
        console.error('sweep LLM failed, using template', e.message);
      }
      // Anyone the model skipped (or everyone, if the LLM failed) gets a safe template.
      const covered = new Set(drafts.map((d) => d.participant.id));
      for (const p of pending) {
        if (!covered.has(p.id)) drafts.push({ participant: p, message: fallbackReminder(p.name, Number(p.share).toFixed(2), split.currency, split.owner_name) });
      }

      for (const d of drafts) {
        await logEvent(splitId, 'reminder_draft', {
          reasoning: `Reminder for ${d.participant.name}`,
          payload: { participant_id: d.participant.id, name: d.participant.name, message: d.message, amount: Number(d.participant.share), currency: split.currency, source: 'scheduler' },
          status: 'drafted',
        });
        await supabase.from('participants').update({ last_reminded_at: new Date().toISOString() }).eq('id', d.participant.id);
        drafted += 1;
      }
    }
    return res.status(200).json({ ok: true, splits: groups.size, drafted });
  } catch (err) {
    console.error('sweep failed', err);
    return res.status(500).json({ error: 'Sweep failed' });
  }
}
