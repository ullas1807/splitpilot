// All money math happens here, in integer cents. The LLM never calculates amounts.

// Split `total` cents across n people; the remainder cents rotate starting at `offset`.
export function distribute(total, n, offset = 0) {
  const base = Math.floor(total / n);
  const rem = total - base * n;
  const out = Array(n).fill(base);
  for (let k = 0; k < rem; k++) out[(offset + k) % n] += 1;
  return out;
}

/**
 * people:     string[]                 everyone sharing the bill
 * itemCents:  number[]                 line totals in cents
 * itemNames:  string[]
 * assigned:   (string[] | null)[]      who shared each item (null/empty = everyone)
 * taxCents, tipCents: number
 * mode: 'proportional' | 'equal'
 * Returns [{ name, itemsCents, taxTipCents, totalCents, lines:[{name,cents}] }]
 * Guarantee: sum(totalCents) === sum(itemCents) + taxCents + tipCents
 */
export function computeShares({ people, itemCents, itemNames = [], assigned = [], taxCents = 0, tipCents = 0, mode = 'proportional' }) {
  if (!people.length) throw new Error('No people to split between');
  const index = new Map(people.map((p, i) => [p.toLowerCase(), i]));
  const shares = people.map((name) => ({ name, itemsCents: 0, taxTipCents: 0, totalCents: 0, lines: [] }));

  itemCents.forEach((cents, idx) => {
    let group = (assigned[idx] || []).map((n) => index.get(String(n).toLowerCase())).filter((i) => i !== undefined);
    group = [...new Set(group)];
    if (!group.length) group = people.map((_, i) => i);
    const parts = distribute(cents, group.length, idx);
    group.forEach((personIdx, k) => {
      shares[personIdx].itemsCents += parts[k];
      shares[personIdx].lines.push({ name: itemNames[idx] || `Item ${idx + 1}`, cents: parts[k] });
    });
  });

  const taxTip = taxCents + tipCents;
  const subtotal = shares.reduce((a, s) => a + s.itemsCents, 0);
  let tt;
  if (mode === 'equal' || subtotal === 0) {
    tt = distribute(taxTip, people.length, itemCents.length);
  } else {
    const raw = shares.map((s) => (taxTip * s.itemsCents) / subtotal);
    tt = raw.map(Math.floor);
    let left = taxTip - tt.reduce((a, b) => a + b, 0);
    const order = raw.map((r, i) => ({ i, frac: r - Math.floor(r) })).sort((a, b) => b.frac - a.frac || a.i - b.i);
    for (let k = 0; k < left && k < order.length; k++) tt[order[k].i] += 1;
  }

  shares.forEach((s, i) => {
    s.taxTipCents = tt[i];
    s.totalCents = s.itemsCents + s.taxTipCents;
  });

  const expected = itemCents.reduce((a, b) => a + b, 0) + taxTip;
  const actual = shares.reduce((a, s) => a + s.totalCents, 0);
  if (actual !== expected) throw new Error(`Split mismatch: ${actual} != ${expected}`);
  return shares;
}
