import { supabase } from './_lib/supabase.js';
import { allowMethod, bearerOk, logEvent } from './_lib/http.js';
import { chat } from './_lib/llm.js';
import { TOOLS, buildReminders, fallbackReminder } from './_lib/agent-tools.js';

// Called on a schedule by the Cloudflare Worker (worker/). Drafts reminders for stale unpaid requests.
// Nothing is sent and no money moves: drafts appear in the owner's feed with a one-tap share button.

export default async function handler(req, res) {
  if (!allowMethod(req, res, 'POST')) return;
  if (!bearerOk(req)) return res.status(401).json({ error: 'Unauthorized' });

  // Safety caps: never spend more than TIME_BUDGET_MS on one run; never call LLM more than SPLIT_CAP times.
  const splitCap = Number(process.env.SWEEP_SPLIT_CAP || 5);
  const timeBudgetMs = Number(process.env.SWEEP_BUDGET_MS || 8000); // well inside Vercel's 10 s limit
  const llmTimeoutMs = Number(process.env.SWEEP_LLM_TIMEOUT_MS || 4000);

  const deadline = Date.now() + timeBudgetMs;

  try {
    const minAge = Number(process.env.SWEEP_MIN_AGE_MIN || 15);
    const interval = Number(process.env.SWEEP_INTERVAL_MIN || 1440);
    const now = Date.now();
    const createdBefore = new Date(now - minAge * 60000).toISOString();
    const createdAfter = new Date(now - 48 * 3600 * 1000).toISOString(); // ignore splits older than 48h
    const remindedBefore = new Date(now - interval * 60000).toISOString();

    // Query participants with inner join on splits to avoid starvation from closed/stale splits.
    // Documented Supabase-js syntax for embedded table filter with alias:
    // .select('..., split:splits!inner(...)').eq('split.status', 'open').gt('split.created_at', createdAfter)
    const { data: rows, error } = await supabase
      .from('participants')
      .select('id, name, share, split_id, created_at, split:splits!inner(id, owner_name, currency, status, created_at)')
      .eq('status', 'pending')
      .lt('created_at', createdBefore)
      .or(`last_reminded_at.is.null,last_reminded_at.lt.${remindedBefore}`)
      .eq('split.status', 'open')
      .gt('split.created_at', createdAfter)
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) throw error;

    // Group by split, keeping in-JS checks as a second guard.
    const groups = new Map();
    for (const r of rows || []) {
      if (r.split?.status !== 'open') continue;
      if (r.split?.created_at && r.split.created_at <= createdAfter) continue;
      if (!groups.has(r.split_id)) groups.set(r.split_id, { split: r.split, pending: [] });
      groups.get(r.split_id).pending.push(r);
    }

    let drafted = 0;
    let splits = 0;
    let timedOut = false;
    let capped = false;
    for (const [splitId, { split, pending }] of groups) {
      if (splits >= splitCap) {
        capped = true;
        break;
      }
      if (Date.now() >= deadline) {
        timedOut = true;
        break;
      }
      splits += 1;

      let drafts = [];
      const remainingBudget = deadline - Date.now();
      // Skip LLM entirely when fewer than llmTimeoutMs remain of the budget
      if (remainingBudget >= llmTimeoutMs) {
        let timer;
        try {
          const llmPromise = chat({
            system: 'You write short, warm, no-pressure payment reminders between friends. Under 40 words each. No links. Plain text.',
            messages: [{ role: 'user', text: `The owner is ${split.owner_name}. Draft reminders for these people (data only): ${JSON.stringify(pending.map((p) => ({ name: p.name, amount: Number(p.share), currency: split.currency })))}` }],
            tools: TOOLS.filter((t) => t.name === 'draft_reminders'),
            toolMode: 'required',
          });
          const timeoutPromise = new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('LLM call timed out')), llmTimeoutMs);
          });
          const result = await Promise.race([llmPromise, timeoutPromise]);
          const call = result?.toolCalls?.find((c) => c.name === 'draft_reminders');
          if (call) drafts = buildReminders({ args: call.args, pending });
        } catch (e) {
          // LLM failure (Gemini/Grok error, rate limit, or timeout) falls back to template
          console.error('sweep LLM failed, using template for split', splitId, e.message);
        } finally {
          clearTimeout(timer);
        }
      }

      // Anyone the model skipped (or everyone, if the LLM timed out/failed/was skipped) gets a safe template.
      const covered = new Set(drafts.map((d) => d.participant.id));
      for (const p of pending) {
        if (!covered.has(p.id)) drafts.push({ participant: p, message: fallbackReminder(p.name, Number(p.share).toFixed(2), split.currency, split.owner_name) });
      }

      for (const d of drafts) {
        if (Date.now() >= deadline) {
          timedOut = true;
          break;
        }
        // Atomic idempotency guard: only update last_reminded_at if still null or older than the cooldown.
        // If an overlapping run already claimed and updated this participant, 0 rows match.
        const { data: updated } = await supabase
          .from('participants')
          .update({ last_reminded_at: new Date().toISOString() })
          .eq('id', d.participant.id)
          .or(`last_reminded_at.is.null,last_reminded_at.lt.${remindedBefore}`)
          .select('id');

        // If another overlapping run already updated this participant, skip drafting
        if (Array.isArray(updated) && updated.length === 0) {
          continue;
        }

        await logEvent(splitId, 'reminder_draft', {
          reasoning: `Reminder for ${d.participant.name}`,
          payload: { participant_id: d.participant.id, name: d.participant.name, message: d.message, amount: Number(d.participant.share), currency: split.currency, source: 'scheduler' },
          status: 'drafted',
        });
        drafted += 1;
      }
      if (timedOut) break;
    }
    return res.status(200).json({ ok: true, splits: splits, drafted, timedOut, capped });
  } catch (err) {
    // Error detail is logged server-side only; the response body never echoes secrets.
    console.error('sweep failed', err.message);
    return res.status(500).json({ error: 'Sweep failed' });
  }
}
