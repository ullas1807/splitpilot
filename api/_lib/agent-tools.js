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
        people: {
          type: 'array',
          items: { type: 'string' },
          description: 'Names of people who shared or participated in the bill, excluding the owner.',
        },
        excluded_people: {
          type: 'array',
          items: { type: 'string' },
          description: 'People explicitly mentioned as not eating, drinking, or participating (must end up with $0 share).',
        },
        owner_participates: {
          type: 'boolean',
          description: 'False only if the owner paid but did not eat or drink anything.',
        },
        assignments: {
          type: 'array',
          description:
            'Items consumed by specific people. Use "me" for the owner. Items not listed are shared equally by all active, non-excluded eaters.',
          items: {
            type: 'object',
            properties: {
              item_name: { type: 'string' },
              people: { type: 'array', items: { type: 'string' } },
            },
            required: ['item_name', 'people'],
          },
        },
        tax_tip_mode: {
          type: 'string',
          enum: ['proportional', 'equal'],
          description: 'Tax distribution mode: proportional = tax follows items ordered; equal = split evenly.',
        },
        tip_mode: {
          type: 'string',
          enum: ['proportional', 'even', 'owner_covers'],
          description:
            'Tip distribution mode: proportional = tip follows items ordered; even = split evenly among eaters; owner_covers = owner covers entire tip.',
        },
        assumptions: {
          type: 'string',
          description: 'Brief statement of assumptions made (e.g. unassigned items shared by eaters, tip covered by owner).',
        },
        explanation: {
          type: 'string',
          description: 'One or two plain sentences explaining the split to the owner.',
        },
      },
      required: ['people'],
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

export function generateProposalSummary({ owner, requests, ownerShareCents, tipMode, taxMode, excluded }) {
  const parts = [];
  const payingNames = requests.map((r) => r.name);
  if (ownerShareCents > 0 || payingNames.length === 0) {
    payingNames.push(`${owner} (you)`);
  }

  parts.push(`Split across ${payingNames.join(', ')}.`);

  if (tipMode === 'owner_covers') {
    parts.push(`Tip covered by ${owner}.`);
  } else if (tipMode === 'even') {
    parts.push('Tip split evenly.');
  } else if (tipMode === 'proportional') {
    parts.push('Tip split in proportion to orders.');
  }

  if (taxMode === 'equal') {
    parts.push('Tax split evenly.');
  } else {
    parts.push('Tax split proportionally.');
  }

  if (excluded && excluded.length > 0) {
    parts.push(`Excluded ($0): ${excluded.join(', ')}.`);
  }

  return parts.join(' ');
}

export function buildProposal({ split, items, args = {} }) {
  const owner = split.owner_name;
  const ownerKey = owner.toLowerCase();

  // Validate roster: if no participants specified, return clarification
  if (!Array.isArray(args.people) || args.people.length === 0) {
    return { error: 'I need to know who shared the meal with you. Who should be included in the split?' };
  }

  const tipMode = args.tip_mode || (args.tax_tip_mode === 'equal' ? 'even' : 'proportional');
  const ownerParticipates = args.owner_participates !== false || tipMode === 'owner_covers';
  const canon = new Map();

  const addPerson = (raw) => {
    let name = sanitizeText(raw, 40);
    if (!name) return null;
    if (OWNER_ALIASES.test(name)) name = owner;
    if (name === name.toLowerCase()) name = name.replace(/(^|\s)(\p{L})/gu, (_, sp, ch) => sp + ch.toUpperCase());
    const key = name.toLowerCase();
    if (key === ownerKey && !ownerParticipates) return null;
    if (!canon.has(key)) canon.set(key, key === ownerKey ? owner : name);
    return canon.get(key);
  };

  if (ownerParticipates) addPerson(owner);
  args.people.forEach(addPerson);

  const excludedPeople = (Array.isArray(args.excluded_people) ? args.excluded_people : [])
    .map((p) => {
      let name = sanitizeText(p, 40);
      if (OWNER_ALIASES.test(name)) name = owner;
      return name;
    })
    .filter(Boolean);

  // Add excluded people to canon so we can accurately verify their shares
  excludedPeople.forEach(addPerson);

  const declaredPeople = new Set(
    args.people.map((p) => p.toLowerCase().trim()).concat(excludedPeople.map((p) => p.toLowerCase().trim()))
  );

  const itemNames = items.map((i) => i.name);
  const itemCents = items.map((i) => toCents(i.line_total));
  const assignedSets = items.map(() => new Set());
  const unmatched = [];

  const findItem = (name) => {
    const q = sanitizeText(name, 80).toLowerCase();
    if (!q) return { index: -1 };
    const exactIdx = itemNames.findIndex((n) => n.toLowerCase() === q);
    if (exactIdx >= 0) return { index: exactIdx };

    const matches = [];
    itemNames.forEach((n, idx) => {
      const nl = n.toLowerCase();
      if (nl.includes(q) || q.includes(nl)) {
        matches.push({ name: n, index: idx });
      }
    });

    if (matches.length > 1) {
      return { ambiguous: true, matches: matches.map((m) => m.name) };
    }
    if (matches.length === 1) {
      return { index: matches[0].index };
    }
    return { index: -1 };
  };

  for (const a of Array.isArray(args.assignments) ? args.assignments : []) {
    const res = findItem(a?.item_name);
    if (res.ambiguous) {
      return {
        error: `Ambiguous item "${a.item_name}" matches multiple items (${res.matches.join(', ')}). Please clarify which one you mean.`,
      };
    }
    const idx = res.index;
    if (idx < 0) {
      unmatched.push(sanitizeText(a?.item_name, 40));
      continue;
    }

    const assignedNames = Array.isArray(a?.people) ? a.people : [];
    for (const rawName of assignedNames) {
      const trimmed = sanitizeText(rawName, 40).trim();
      if (!trimmed) continue;
      const isOwner = OWNER_ALIASES.test(trimmed) || trimmed.toLowerCase() === ownerKey;
      if (!isOwner && !declaredPeople.has(trimmed.toLowerCase())) {
        return {
          error: `I don't recognize "${trimmed}". Please clarify who shared the bill.`,
        };
      }
      const canonName = addPerson(trimmed);
      if (canonName) assignedSets[idx].add(canonName);
    }
  }

  const people = [...canon.values()];
  if (people.length > LIMITS.maxPeople) {
    return { error: `Guardrail: I can split between at most ${LIMITS.maxPeople} people.` };
  }

  const taxMode = args.tax_tip_mode === 'equal' ? 'equal' : 'proportional';
  const taxCents = toCents(split.tax);
  const tipCents = toCents(split.tip);
  let shares;

  try {
    shares = computeShares({
      people,
      itemCents,
      itemNames,
      assigned: assignedSets.map((s) => [...s]),
      taxCents,
      tipCents,
      mode: taxMode,
      tipMode,
      ownerName: owner,
      excludedPeople,
    });
  } catch (e) {
    return { error: `Could not compute the split: ${e.message}` };
  }

  // Server-side validation: if an excluded person ends up with a non-zero share, reject the proposal
  for (const rawName of excludedPeople) {
    const key = rawName.toLowerCase();
    const s = shares.find((sh) => sh.name.toLowerCase() === key);
    if (s && s.totalCents > 0) {
      return {
        error: `Proposal rejected: ${s.name} is marked as excluded but was assigned a non-zero share (${(s.totalCents / 100).toFixed(2)} ${split.currency}).`,
      };
    }
  }

  const totalCents = itemCents.reduce((a, b) => a + b, 0) + taxCents + tipCents;
  const requests = shares.filter((s) => s.name.toLowerCase() !== ownerKey && s.totalCents > 0);

  if (!requests.length) {
    return { error: 'I need at least one other person to request money from. Who shared the meal with you?' };
  }
  if (totalCents / 100 > LIMITS.maxSplitTotal) {
    return { error: `Guardrail: bills over ${LIMITS.maxSplitTotal} ${split.currency} need manual handling.` };
  }
  const tooBig = requests.find((r) => r.totalCents / 100 > LIMITS.maxPerPerson);
  if (tooBig) {
    return { error: `Guardrail: ${tooBig.name}'s share would exceed the per-person limit of ${LIMITS.maxPerPerson} ${split.currency}.` };
  }

  const ownerShare = shares.find((s) => s.name.toLowerCase() === ownerKey);
  const ownerShareCents = ownerShare ? ownerShare.totalCents : 0;

  // Generate card summary server-side from computed shares (no model prose)
  const canonicalExcluded = [...new Set(excludedPeople.map((p) => canon.get(p.toLowerCase()) || p))];
  const summary = generateProposalSummary({
    owner,
    requests,
    ownerShareCents,
    tipMode,
    taxMode,
    currency: split.currency,
    excluded: canonicalExcluded,
  });

  // Derive Assumptions line for the card
  const unassignedItems = items
    .filter((_, idx) => assignedSets[idx].size === 0)
    .map((i) => i.name);
  const assumptionsParts = [];
  if (args.assumptions && typeof args.assumptions === 'string') {
    assumptionsParts.push(sanitizeText(args.assumptions, 250));
  } else {
    if (unassignedItems.length > 0) {
      assumptionsParts.push(`Unassigned items (${unassignedItems.join(', ')}) shared equally among active eaters.`);
    }
    if (tipMode === 'owner_covers') {
      assumptionsParts.push(`Owner (${owner}) covers the tip.`);
    } else if (tipMode === 'even') {
      assumptionsParts.push('Tip split evenly among active eaters.');
    }
    if (canonicalExcluded.length > 0) {
      assumptionsParts.push(`${canonicalExcluded.join(', ')} excluded with $0 share.`);
    }
  }
  const assumptionsText = assumptionsParts.join(' ');

  return {
    proposal: {
      currency: split.currency,
      total_cents: totalCents,
      owner_name: owner,
      owner_share_cents: ownerShareCents,
      mode: taxMode,
      tip_mode: tipMode,
      tax_mode: taxMode,
      summary,
      assumptions: assumptionsText,
      excluded: canonicalExcluded,
      requests: requests.map((r) => ({
        name: r.name,
        amount_cents: r.totalCents,
        items_cents: r.itemsCents,
        tax_cents: r.taxCents,
        tip_cents: r.tipCents,
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
