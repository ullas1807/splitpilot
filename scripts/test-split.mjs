// Run with: npm test   (verifies the money math is exact)
import assert from 'node:assert/strict';
import { computeShares, distribute } from '../api/_lib/split-math.js';

// distribute: remainders add up exactly
for (let total = 0; total < 500; total += 7) {
  for (let n = 1; n <= 9; n++) assert.equal(distribute(total, n, 3).reduce((a, b) => a + b, 0), total);
}

// Scenario: the sample receipt
const people = ['You', 'Asha', 'Ravi', 'Meera'];
const items = [
  { name: 'Margherita Pizza', cents: 1400 },
  { name: 'Paneer Tikka', cents: 1150 },
  { name: 'Pasta Alfredo', cents: 1300 },
  { name: 'Garlic Bread', cents: 650 },
  { name: 'Lemonade x3', cents: 900 },
];
const assigned = [['Asha', 'Ravi'], ['You'], ['Meera'], null, ['You', 'Asha', 'Meera']];
for (const mode of ['proportional', 'equal']) {
  const shares = computeShares({
    people, itemCents: items.map((i) => i.cents), itemNames: items.map((i) => i.name),
    assigned, taxCents: 432, tipCents: 800, mode,
  });
  const sum = shares.reduce((a, s) => a + s.totalCents, 0);
  assert.equal(sum, 1400 + 1150 + 1300 + 650 + 900 + 432 + 800, `sum mismatch in ${mode}`);
}

// Fuzz: random bills always sum exactly
for (let t = 0; t < 2000; t++) {
  const n = 1 + Math.floor(Math.random() * 8);
  const ppl = Array.from({ length: n }, (_, i) => `P${i}`);
  const cnt = 1 + Math.floor(Math.random() * 10);
  const itemCents = Array.from({ length: cnt }, () => 1 + Math.floor(Math.random() * 9000));
  const assignedR = itemCents.map(() => (Math.random() < 0.5 ? null : ppl.filter(() => Math.random() < 0.5)));
  const tax = Math.floor(Math.random() * 2000), tip = Math.floor(Math.random() * 3000);
  const mode = Math.random() < 0.5 ? 'equal' : 'proportional';
  const shares = computeShares({ people: ppl, itemCents, assigned: assignedR, taxCents: tax, tipCents: tip, mode });
  assert.equal(shares.reduce((a, s) => a + s.totalCents, 0), itemCents.reduce((a, b) => a + b, 0) + tax + tip);
  shares.forEach((s) => assert.ok(s.totalCents >= 0));
}
console.log('split-math: all tests passed');
