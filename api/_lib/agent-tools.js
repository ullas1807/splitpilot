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

export const OWNER_ALIASES = /^(me|i|myself|self|owner|my)$/i;

const SELF_OR_GROUP_WORDS = new Set([
  'me', 'i', 'myself', 'self', 'owner', 'my', 'we', 'us', 'all', 'everyone',
  'all of us', 'four of us', 'three of us', 'both of us'
]);

const STOPWORDS = new Set([
  'dinner', 'lunch', 'brunch', 'breakfast', 'meal', 'food', 'bill', 'receipt',
  'split', 'everything', 'item', 'items', 'order', 'orders', 'tax', 'tip',
  'total', 'subtotal', 'share', 'shares', 'shared', 'sharing',
  'had', 'ate', 'drank', 'ordered', 'got', 'took', 'paid', 'covered',
  'equally', 'evenly', 'proportionally', 'proportional', 'equal',
  'between', 'among', 'with', 'and', 'or', 'for', 'to', 'from',
  'the', 'a', 'an', 'this', 'that', 'these', 'those',
  'yes', 'no', 'ok', 'okay', 'please', 'thanks', 'thank',
  'you', 'your', 'yours', 'he', 'she', 'they', 'them', 'their', 'his', 'her',
  'who', 'what', 'where', 'when', 'why', 'how',
  'not', 'never', 'dont', "don't", 'add', 'added', 'adding', 'include', 'included'
]);

/**
 * Sanitize names (max 30 chars, letters/spaces/hyphens/apostrophes only, title-cased if all lowercase).
 */
export function sanitizeName(value, max = 30) {
  if (!value) return '';
  let cleaned = String(value)
    .replace(/<[^>]*>/g, '')
    .replace(/[^\p{L}\s'-]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
  if (!cleaned) return '';
  if (cleaned === cleaned.toLowerCase()) {
    cleaned = cleaned.replace(/(^|[\s'-])(\p{L})/gu, (_, sp, ch) => sp + ch.toUpperCase());
  }
  return cleaned;
}

export function isValidName(str, receiptItemNames = []) {
  const s = sanitizeName(str, 30);
  if (!s || s.length < 2 || s.length > 30) return false;
  const lower = s.toLowerCase();
  if (SELF_OR_GROUP_WORDS.has(lower) || STOPWORDS.has(lower)) return false;
  if (
    receiptItemNames.some((it) => {
      const itLower = it.toLowerCase();
      if (itLower === lower || lower.includes(itLower) || itLower.includes(lower)) return true;
      const words = itLower.split(/\s+/);
      return words.includes(lower);
    })
  ) {
    return false;
  }
  if (!/^[\p{L}'-]+(?:\s+[\p{L}'-]+)?$/u.test(s)) return false;
  return true;
}

export function extractNamesFromList(text, receiptItemNames = []) {
  const norm = text
    .replace(/,\s*and\s+/gi, ', ')
    .replace(/\s+and\s+/gi, ', ')
    .replace(/\s*&\s*/g, ', ');
  return norm
    .split(',')
    .map((s) => s.trim())
    .filter((s) => isValidName(s, receiptItemNames))
    .map((s) => sanitizeName(s, 30));
}

/**
 * Deterministic detection of explicit add instructions.
 * Rejects negations ("Don't add Priya") and look-alikes ("Priya, add the tikka", "add the tikka for Asha").
 * Supports "Add Priya and Karan", "add Priya", "Please add Priya".
 */
export function extractExplicitAdds(msg, receiptItemNames = []) {
  if (!msg || typeof msg !== 'string') return [];
  // Negation check: if the sentence/clause negates adding, do not extract
  if (/\b(?:don't|dont|do\s+not|never|not|cannot|shouldn't|stop)\s+(?:add|include)\b/i.test(msg)) {
    return [];
  }
  const match = msg.match(/(?:^|[.!?;\n])\s*(?:please\s+)?(?:add|include)\s+([^.!?;\n]+)/i);
  if (!match) return [];

  let target = match[1].trim();
  // Strip trailing context like "to the split" or "to the bill"
  target = target.replace(/\s+to\s+(?:the\s+)?(?:split|bill|dinner|meal|table|group)$/i, '');

  // Look-alike checks: if target starts with an article or quantifier, it's adding an item (e.g. "add the tikka")
  if (/^(?:the|a|an|some|item|items|more|another)\s+/i.test(target)) return [];

  // Look-alike check: if target contains "for [someone]" or "to [something]", it's adding an item (e.g. "add the tikka for Asha")
  if (/\b(?:for|to)\b/i.test(target)) return [];

  return extractNamesFromList(target, receiptItemNames);
}

/**
 * Deterministic parsing of group declarations in user messages.
 * Supports:
 * - "Dinner was me, Asha, Ravi and Meera"
 * - "Split everything equally between me, Asha, Ravi and Meera"
 * - "Asha, Ravi, Meera and I"
 * - Chip 1: "Split everything equally between me, Asha, Ravi and Meera"
 * - Chip 2: "Asha and Ravi shared the pizza, I had the paneer, Meera had the pasta. Garlic bread and lemonades are shared by all four of us"
 */
export function parseGroupDeclaration(msg, receiptItemNames = []) {
  if (!msg || typeof msg !== 'string') return [];
  const found = [];

  // Pattern 1: "Dinner was me, Asha, Ravi and Meera"
  const m1 = msg.match(/(?:dinner|lunch|brunch|breakfast|meal|food|bill|split|party|table|group)\s+(?:was|is|with|for)\s+([^.!?]+)/i);
  if (m1) {
    found.push(...extractNamesFromList(m1[1], receiptItemNames));
  }

  // Pattern 2: "Split everything equally between me, Asha, Ravi and Meera" (UI Chip 1)
  const m2 = msg.match(/(?:split\s+(?:everything|all|it|the\s+bill)?\s*(?:equally|evenly)?\s*(?:between|among|with)\s+)([^.!?]+)/i);
  if (m2) {
    found.push(...extractNamesFromList(m2[1], receiptItemNames));
  }

  // Pattern 3: "Asha, Ravi, Meera and I" / "... and me"
  const m3 = msg.match(/^([A-Za-z\s,'-]+?)\s+and\s+(?:i|me)\b/i);
  if (m3) {
    found.push(...extractNamesFromList(m3[1], receiptItemNames));
  }

  // Pattern 4: Group meal sharing messages (e.g. UI Chip 2)
  // Must either contain group phrase ("shared by all", "all four of us") or have multiple sharing clauses
  const isMultiSharing =
    /\b(?:shared\s+by\s+all|all\s+(?:\w+\s+)?of\s+us|everyone)\b/i.test(msg) ||
    (msg.includes(',') && /\b(?:shared|had)\b/i.test(msg));

  if (isMultiSharing) {
    const clauses = msg.split(/[.,;!?\n]+/);
    const clauseNames = [];
    for (const clause of clauses) {
      const trimmed = clause.trim();
      if (!trimmed) continue;
      const shareMatch = trimmed.match(/^([A-Za-z\s'-]+?)\s+(?:shared|split|ate|ordered)\b/i);
      if (shareMatch) {
        clauseNames.push(...extractNamesFromList(shareMatch[1], receiptItemNames));
      }
      const hadMatch = trimmed.match(/^([A-Za-z\s'-]+?)\s+had\b/i);
      if (hadMatch) {
        clauseNames.push(...extractNamesFromList(hadMatch[1], receiptItemNames));
      }
    }
    // Only accept if multiple attendees were declared (not a single individual assignment like "Priya had the tikka")
    if (clauseNames.length >= 2 || /\b(?:shared\s+by\s+all|all\s+(?:\w+\s+)?of\s+us)\b/i.test(msg)) {
      found.push(...clauseNames);
    }
  }

  // Pattern 5: General "between / among / with [people]"
  const m5 = msg.match(/\b(?:between|among|with)\s+([A-Za-z\s,'-]+?)(?:\s*\.|\s*$|\s*,\s*(?:split|shared|tax|tip))/i);
  if (m5) {
    found.push(...extractNamesFromList(m5[1], receiptItemNames));
  }

  return [...new Set(found)];
}

/**
 * Builds the attendee roster server-side from all user messages and DB state.
 * Max roster size: 12.
 */
export function buildRoster({ ownerName, history = [], currentMessage = '', items = [], existingParticipants = [] }) {
  const itemNames = (items || []).map((i) => i.name || '');
  const owner = sanitizeName(ownerName, 30);
  const rosterMap = new Map();

  if (owner) {
    rosterMap.set(owner.toLowerCase(), owner);
  }

  // Include any existing participants already saved in database
  for (const p of existingParticipants || []) {
    const s = sanitizeName(p.name, 30);
    if (s && !rosterMap.has(s.toLowerCase())) {
      rosterMap.set(s.toLowerCase(), s);
    }
  }

  // Chronologically scan all prior user messages from history
  const priorUserMessages = (history || [])
    .filter((h) => h.action === 'user_message')
    .map((h) => String(h.payload?.text || ''));

  for (const text of priorUserMessages) {
    const declared = parseGroupDeclaration(text, itemNames);
    for (const d of declared) {
      if (!rosterMap.has(d.toLowerCase())) rosterMap.set(d.toLowerCase(), d);
    }
    const added = extractExplicitAdds(text, itemNames);
    for (const a of added) {
      if (!rosterMap.has(a.toLowerCase())) rosterMap.set(a.toLowerCase(), a);
    }
  }

  const hadPriorRoster = rosterMap.size > (owner ? 1 : 0);

  // Scan current user message:
  // - If no roster was established yet, check if current message is a group declaration
  if (!hadPriorRoster && currentMessage) {
    const declared = parseGroupDeclaration(currentMessage, itemNames);
    for (const d of declared) {
      if (!rosterMap.has(d.toLowerCase())) rosterMap.set(d.toLowerCase(), d);
    }
  }

  // - Requirement 2: Only allow a new name if the latest user message explicitly adds them!
  if (currentMessage) {
    const added = extractExplicitAdds(currentMessage, itemNames);
    for (const a of added) {
      if (!rosterMap.has(a.toLowerCase())) rosterMap.set(a.toLowerCase(), a);
    }
  }

  return [...rosterMap.values()].slice(0, LIMITS.maxPeople);
}

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

export function buildProposal({ split, items, args = {}, roster, prevProposal }) {
  const owner = sanitizeName(split.owner_name, 30);
  const ownerKey = owner.toLowerCase();

  // If roster is provided, enforce server-side roster rules:
  if (roster !== undefined && roster !== null) {
    const rosterAttendees = roster.filter((n) => n.toLowerCase() !== ownerKey);
    // Requirement B: If no roster has been established, return "Who was at dinner?" and create no proposal.
    if (rosterAttendees.length === 0) {
      return { error: 'Who was at dinner?' };
    }

    const rosterSet = new Set(roster.map((n) => n.toLowerCase().trim()));

    // Check args.people against roster
    for (const raw of Array.isArray(args.people) ? args.people : []) {
      const s = sanitizeName(raw, 30);
      if (!s) continue;
      if (s.toLowerCase() !== ownerKey && !rosterSet.has(s.toLowerCase())) {
        return { error: `I don't see ${s} in this split. Who was at dinner? Say 'add ${s}' to include her.` };
      }
    }

    // Check args.excluded_people against roster
    for (const raw of Array.isArray(args.excluded_people) ? args.excluded_people : []) {
      const s = sanitizeName(raw, 30);
      if (!s) continue;
      if (s.toLowerCase() !== ownerKey && !rosterSet.has(s.toLowerCase())) {
        return { error: `I don't see ${s} in this split. Who was at dinner? Say 'add ${s}' to include her.` };
      }
    }

    // Check args.assignments against roster
    for (const a of Array.isArray(args.assignments) ? args.assignments : []) {
      for (const raw of Array.isArray(a?.people) ? a.people : []) {
        const s = sanitizeName(raw, 30);
        if (!s) continue;
        if (!OWNER_ALIASES.test(s) && s.toLowerCase() !== ownerKey && !rosterSet.has(s.toLowerCase())) {
          return { error: `I don't see ${s} in this split. Who was at dinner? Say 'add ${s}' to include her.` };
        }
      }
    }
  }

  // Validate roster: if no participants specified, return clarification
  if (!Array.isArray(args.people) || args.people.length === 0) {
    return { error: 'I need to know who shared the meal with you before allocating items.' };
  }

  const tipMode = args.tip_mode || (args.tax_tip_mode === 'equal' ? 'even' : 'proportional');
  const ownerParticipates = args.owner_participates !== false || tipMode === 'owner_covers';
  const canon = new Map();

  const addPerson = (raw) => {
    let name = sanitizeName(raw, 30);
    if (!name) return null;
    if (OWNER_ALIASES.test(name)) name = owner;
    const key = name.toLowerCase();
    if (key === ownerKey && !ownerParticipates) return null;
    if (!canon.has(key)) canon.set(key, key === ownerKey ? owner : name);
    return canon.get(key);
  };

  if (ownerParticipates) addPerson(owner);
  args.people.forEach(addPerson);

  const excludedPeople = (Array.isArray(args.excluded_people) ? args.excluded_people : [])
    .map((p) => {
      let name = sanitizeName(p, 30);
      if (OWNER_ALIASES.test(name)) name = owner;
      return name;
    })
    .filter(Boolean);

  // Add excluded people to canon so we can accurately verify their shares
  excludedPeople.forEach(addPerson);

  const declaredPeople = new Set(
    args.people.map((p) => sanitizeName(p, 30).toLowerCase()).concat(excludedPeople.map((p) => p.toLowerCase()))
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
      const trimmed = sanitizeName(rawName, 30);
      if (!trimmed) continue;
      const isOwner = OWNER_ALIASES.test(trimmed) || trimmed.toLowerCase() === ownerKey;
      if (!isOwner && !declaredPeople.has(trimmed.toLowerCase())) {
        return {
          error: `I don't recognize "${trimmed}" in this meal. Please list who shared it first.`,
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
  const canonicalExcluded = [...new Set(excludedPeople.map((p) => canon.get(p.toLowerCase()) || p))].map((n) =>
    sanitizeName(n, 30)
  );
  const summary = generateProposalSummary({
    owner,
    requests: requests.map((r) => ({ ...r, name: sanitizeName(r.name, 30) })),
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

  // Check for reassigned items from previous proposal (Requirements 3 & E)
  if (prevProposal) {
    const prevItemAssigned = new Map();
    if (Array.isArray(prevProposal.assignments) && prevProposal.assignments.length > 0) {
      for (const a of prevProposal.assignments) {
        const q = String(a?.item_name || '').toLowerCase().trim();
        if (q) {
          prevItemAssigned.set(q, (a.people || []).map((p) => sanitizeName(p, 30)));
        }
      }
    } else if (Array.isArray(prevProposal.requests)) {
      for (const r of prevProposal.requests) {
        for (const l of r.lines || []) {
          const q = String(l?.name || '').toLowerCase().trim();
          if (q) {
            const cur = prevItemAssigned.get(q) || [];
            cur.push(sanitizeName(r.name, 30));
            prevItemAssigned.set(q, cur);
          }
        }
      }
    }

    for (let idx = 0; idx < items.length; idx++) {
      const itName = items[idx].name;
      const q = itName.toLowerCase().trim();
      const prevEaters = prevItemAssigned.get(q) || [];
      const currEaters = [...assignedSets[idx]];

      if (prevEaters.length > 0 && currEaters.length > 0) {
        const removed = prevEaters.filter((p) => !currEaters.some((c) => c.toLowerCase() === p.toLowerCase()));
        const added = currEaters.filter((c) => !prevEaters.some((p) => p.toLowerCase() === c.toLowerCase()));
        if (removed.length > 0 && added.length > 0) {
          assumptionsParts.push(`${itName} reassigned from ${removed.join(', ')} to ${added.join(', ')}.`);
        }
      }
    }
  }

  if (args.assumptions && typeof args.assumptions === 'string') {
    assumptionsParts.unshift(sanitizeText(args.assumptions, 250));
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
      assignments: (Array.isArray(args.assignments) ? args.assignments : []).map((a) => ({
        item_name: a.item_name,
        people: (Array.isArray(a?.people) ? a.people : []).map((p) => sanitizeName(p, 30)),
      })),
      requests: requests.map((r) => ({
        name: sanitizeName(r.name, 30),
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
  return `Hi ${sanitizeName(name, 30)}! Quick nudge about your share (${amount} ${currency}) from our bill. Here's the link whenever you get a moment. Thanks! - ${sanitizeName(owner, 30)}`;
}
