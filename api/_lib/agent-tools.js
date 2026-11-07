import { LIMITS, sanitizeText } from './http.js';
import { computeShares } from './split-math.js';
import { toCents } from './receipt.js';

export const TOOLS = [
  {
    name: 'propose_split',
    description:
      'Propose how to split the receipt between people. This NEVER moves money: it creates a proposal the owner must approve. Say only WHO had WHAT; the server calculates all amounts.',
    parameters: {
      type: 'object',
      properties: {
        people: { type: 'array', items: { type: 'string' }, description: 'Names of everyone who shared the bill, excluding the owner.' },
        owner_participates: { type: 'boolean', description: 'False only if the owner paid but did not eat or drink anything.' },
        assignments: {
          type: 'array',
          description: 'Items consumed by specific people. Use "me" for the owner. Items not listed are shared equally by everyone.',
          items: {
            type: 'object',
            properties: {
              item_name: { type: 'string' },
              people: { type: 'array', items: { type: 'string' } },
            },
            required: ['item_name', 'people'],
          },
        },
        tax_tip_mode: { type: 'string', enum: ['proportional', 'equal'], description: 'proportional = tax and tip follow what each person ordered; equal = split evenly.' },
        explanation: { type: 'string', description: 'One or two plain sentences explaining the split to the owner.' },
      },
      required: ['people', 'tax_tip_mode', 'explanation'],
    },
  },
  {
    name: 'draft_reminders',
    description: 'Draft short, friendly payment reminders for people whose payment is still pending. This only writes text; nothing is sent automatically.',
    parameters: {
      type: 'object',
      properties: {
        reminders: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              participant_name: { type: 'string' },
              message: { type: 'string', description: 'Friendly, under 40 words, no links, no pressure.' },
            },
            required: ['participant_name', 'message'],
          },
        },
      },
      required: ['reminders'],
    },
  },
];

const OWNER_ALIASES = /^(me|i|myself|self|owner|my)$/i;

export function buildProposal({ split, items, args }) {
  const owner = split.owner_name;
  const ownerKey = owner.toLowerCase();
  const ownerParticipates = args.owner_participates !== false;
  const canon = new Map();

  const addPerson = (raw) => {
    let name = sanitizeText(raw, 40);
    if (!name) return null;
    if (OWNER_ALIASES.test(name)) name = owner;
    // Models sometimes emit lowercase names; show them nicely ("asha" -> "Asha").
    if (name === name.toLowerCase()) name = name.replace(/(^|\s)(\p{L})/gu, (_, sp, ch) => sp + ch.toUpperCase());
    const key = name.toLowerCase();
    if (key === ownerKey && !ownerParticipates) return null;
    if (!canon.has(key)) canon.set(key, key === ownerKey ? owner : name);
    return canon.get(key);
  };

  if (ownerParticipates) addPerson(owner);
  (Array.isArray(args.people) ? args.people : []).forEach(addPerson);

  const itemNames = items.map((i) => i.name);
  const itemCents = items.map((i) => toCents(i.line_total));
  const assignedSets = items.map(() => new Set());
  const unmatched = [];

  const findItem = (name) => {
    const q = sanitizeText(name, 80).toLowerCase();
    if (!q) return -1;
    let idx = itemNames.findIndex((n) => n.toLowerCase() === q);
    if (idx < 0) idx = itemNames.findIndex((n) => n.toLowerCase().includes(q) || q.includes(n.toLowerCase()));
    return idx;
  };

  for (const a of Array.isArray(args.assignments) ? args.assignments : []) {
    const idx = findItem(a?.item_name);
    const names = (Array.isArray(a?.people) ? a.people : []).map(addPerson).filter(Boolean);
    if (idx < 0) { unmatched.push(sanitizeText(a?.item_name, 40)); continue; }
    names.forEach((n) => assignedSets[idx].add(n));
  }

  const people = [...canon.values()];
  if (people.length > LIMITS.maxPeople) return { error: `Guardrail: I can split between at most ${LIMITS.maxPeople} people.` };

  const mode = args.tax_tip_mode === 'equal' ? 'equal' : 'proportional';
  const taxCents = toCents(split.tax);
  const tipCents = toCents(split.tip);
  let shares;
  try {
    shares = computeShares({ people, itemCents, itemNames, assigned: assignedSets.map((s) => [...s]), taxCents, tipCents, mode });
  } catch (e) {
    return { error: `Could not compute the split: ${e.message}` };
  }

  const totalCents = itemCents.reduce((a, b) => a + b, 0) + taxCents + tipCents;
  const requests = shares.filter((s) => s.name.toLowerCase() !== ownerKey && s.totalCents > 0);
  if (!requests.length) return { error: 'I need at least one other person to request money from. Who shared the meal with you?' };
  if (totalCents / 100 > LIMITS.maxSplitTotal) return { error: `Guardrail: bills over ${LIMITS.maxSplitTotal} ${split.currency} need manual handling.` };
  const tooBig = requests.find((r) => r.totalCents / 100 > LIMITS.maxPerPerson);
  if (tooBig) return { error: `Guardrail: ${tooBig.name}'s share would exceed the per-person limit of ${LIMITS.maxPerPerson} ${split.currency}.` };

  const ownerShare = shares.find((s) => s.name.toLowerCase() === ownerKey);
  return {
    proposal: {
      currency: split.currency,
      total_cents: totalCents,
      owner_name: owner,
      owner_share_cents: ownerShare ? ownerShare.totalCents : 0,
      mode,
      requests: requests.map((r) => ({
        name: r.name,
        amount_cents: r.totalCents,
        items_cents: r.itemsCents,
        tax_tip_cents: r.taxTipCents,
        lines: r.lines,
      })),
      unmatched,
    },
  };
}

export function buildReminders({ args, pending }) {
  const byName = new Map(pending.map((p) => [p.name.toLowerCase(), p]));
  const out = [];
  for (const r of Array.isArray(args.reminders) ? args.reminders : []) {
    const p = byName.get(String(r?.participant_name || '').toLowerCase().trim());
    if (!p) continue;
    const message = sanitizeText(String(r?.message || '').replace(/https?:\/\/\S+/g, ''), 280);
    if (message) out.push({ participant: p, message });
  }
  return out;
}

export function fallbackReminder(name, amount, currency, owner) {
  return `Hi ${name}! Quick nudge about your share (${amount} ${currency}) from our bill. Here's the link whenever you get a moment. Thanks! - ${owner}`;
}
