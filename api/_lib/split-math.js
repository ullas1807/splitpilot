// All money math happens here, in integer cents. The LLM never calculates amounts.

// Split `total` cents across n people; the remainder cents rotate starting at `offset`.
export function distribute(total, n, offset = 0) {
  if (n <= 0) return [];
  const base = Math.floor(total / n);
  const rem = total - base * n;
  const out = Array(n).fill(base);
  for (let k = 0; k < rem; k++) out[(offset + k) % n] += 1;
  return out;
}

/**
 * people:         string[]                 everyone sharing the bill
 * itemCents:      number[]                 line totals in cents
 * itemNames:      string[]
 * assigned:       (string[] | null)[]      who shared each item (null/empty = everyone except excluded)
 * taxCents, tipCents: number
 * mode:           'proportional' | 'equal' (tax allocation mode)
 * tipMode:        'proportional' | 'even' | 'owner_covers'
 * ownerName:      string (database split owner)
 * excludedPeople: string[] (people explicitly not participating, must receive 0 share)
 *
 * Returns [{ name, itemsCents, taxCents, tipCents, taxTipCents, totalCents, lines:[{name,cents}] }]
 * Guarantee: sum(totalCents) === sum(itemCents) + taxCents + tipCents
 */
export function computeShares({
  people,
  itemCents,
  itemNames = [],
  assigned = [],
  taxCents = 0,
  tipCents = 0,
  mode = 'proportional',
  tipMode,
  ownerName,
  excludedPeople = [],
}) {
  if (!people.length) throw new Error('No people to split between');

  const excludedSet = new Set((excludedPeople || []).map((p) => String(p).toLowerCase().trim()));
  const index = new Map(people.map((p, i) => [p.toLowerCase(), i]));
  const shares = people.map((name) => ({
    name,
    itemsCents: 0,
    taxCents: 0,
    tipCents: 0,
    taxTipCents: 0,
    totalCents: 0,
    lines: [],
  }));

  // Non-excluded participant indices
  const nonExcludedIndices = people
    .map((name, i) => (!excludedSet.has(name.toLowerCase()) ? i : -1))
    .filter((i) => i >= 0);

  // 1. Assign items (unassigned items are NEVER silently assigned to excluded participants)
  itemCents.forEach((cents, idx) => {
    let group = (assigned[idx] || [])
      .map((n) => index.get(String(n).toLowerCase()))
      .filter((i) => i !== undefined);
    group = [...new Set(group)];

    if (!group.length) {
      group = nonExcludedIndices;
    }

    if (!group.length) {
      throw new Error(`No non-excluded participants available to share item "${itemNames[idx] || idx + 1}"`);
    }

    const parts = distribute(cents, group.length, idx);
    group.forEach((personIdx, k) => {
      shares[personIdx].itemsCents += parts[k];
      shares[personIdx].lines.push({ name: itemNames[idx] || `Item ${idx + 1}`, cents: parts[k] });
    });
  });

  const subtotal = shares.reduce((a, s) => a + s.itemsCents, 0);

  // 2. Separate TAX allocation
  const taxAlloc = Array(people.length).fill(0);
  if (taxCents > 0 && nonExcludedIndices.length > 0) {
    if (mode === 'equal' || subtotal === 0) {
      const parts = distribute(taxCents, nonExcludedIndices.length, itemCents.length);
      nonExcludedIndices.forEach((personIdx, k) => {
        taxAlloc[personIdx] = parts[k];
      });
    } else {
      const raw = shares.map((s) =>
        excludedSet.has(s.name.toLowerCase()) || subtotal === 0 ? 0 : (taxCents * s.itemsCents) / subtotal
      );
      const floored = raw.map(Math.floor);
      let left = taxCents - floored.reduce((a, b) => a + b, 0);
      const order = raw
        .map((r, i) => ({ i, frac: r - Math.floor(r) }))
        .filter((o) => !excludedSet.has(people[o.i].toLowerCase()))
        .sort((a, b) => b.frac - a.frac || a.i - b.i);
      for (let k = 0; k < left && k < order.length; k++) {
        floored[order[k].i] += 1;
      }
      floored.forEach((v, i) => {
        taxAlloc[i] = v;
      });
    }
  }

  // 3. Separate TIP allocation (independent tip_mode)
  const resolvedTipMode = tipMode || (mode === 'equal' ? 'even' : 'proportional');
  const tipAlloc = Array(people.length).fill(0);

  if (tipCents > 0) {
    if (resolvedTipMode === 'owner_covers') {
      const ownerKey = String(ownerName || '').toLowerCase().trim();
      const ownerIdx = index.get(ownerKey);
      if (ownerIdx !== undefined) {
        tipAlloc[ownerIdx] = tipCents;
      } else if (nonExcludedIndices.length > 0) {
        const parts = distribute(tipCents, nonExcludedIndices.length, itemCents.length + 1);
        nonExcludedIndices.forEach((personIdx, k) => {
          tipAlloc[personIdx] = parts[k];
        });
      }
    } else if (resolvedTipMode === 'even' || resolvedTipMode === 'equal' || subtotal === 0) {
      if (nonExcludedIndices.length > 0) {
        const parts = distribute(tipCents, nonExcludedIndices.length, itemCents.length + 1);
        nonExcludedIndices.forEach((personIdx, k) => {
          tipAlloc[personIdx] = parts[k];
        });
      }
    } else {
      // Proportional tip mode
      const raw = shares.map((s) =>
        excludedSet.has(s.name.toLowerCase()) || subtotal === 0 ? 0 : (tipCents * s.itemsCents) / subtotal
      );
      const floored = raw.map(Math.floor);
      let left = tipCents - floored.reduce((a, b) => a + b, 0);
      const order = raw
        .map((r, i) => ({ i, frac: r - Math.floor(r) }))
        .filter((o) => !excludedSet.has(people[o.i].toLowerCase()))
        .sort((a, b) => b.frac - a.frac || a.i - b.i);
      for (let k = 0; k < left && k < order.length; k++) {
        floored[order[k].i] += 1;
      }
      floored.forEach((v, i) => {
        tipAlloc[i] = v;
      });
    }
  }

  // Combine items, tax and tip
  shares.forEach((s, i) => {
    s.taxCents = taxAlloc[i];
    s.tipCents = tipAlloc[i];
    s.taxTipCents = s.taxCents + s.tipCents;
    s.totalCents = s.itemsCents + s.taxTipCents;
  });

  const expected = itemCents.reduce((a, b) => a + b, 0) + taxCents + tipCents;
  const actual = shares.reduce((a, s) => a + s.totalCents, 0);
  if (actual !== expected) throw new Error(`Split mismatch: ${actual} != ${expected}`);

  return shares;
}
