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

// Scenario: excluded person (Ravi didn't eat) must NOT receive unassigned items, tax or tip
{
  const testPeople = ['Sam', 'Asha', 'Ravi'];
  const testItems = [1000, 2000, 500]; // Item 1 (Asha), Item 2 (Sam), Item 3 (unassigned)
  const testAssigned = [['Asha'], ['Sam'], null];
  const shares = computeShares({
    people: testPeople,
    itemCents: testItems,
    assigned: testAssigned,
    taxCents: 350,
    tipCents: 500,
    mode: 'proportional',
    tipMode: 'proportional',
    ownerName: 'Sam',
    excludedPeople: ['Ravi'],
  });

  const ravi = shares.find((s) => s.name === 'Ravi');
  assert.equal(ravi.itemsCents, 0, 'Excluded person must not receive unassigned items');
  assert.equal(ravi.taxCents, 0, 'Excluded person must not pay tax');
  assert.equal(ravi.tipCents, 0, 'Excluded person must not pay tip');
  assert.equal(ravi.totalCents, 0, 'Excluded person total must be exactly 0');

  const totalSum = shares.reduce((a, s) => a + s.totalCents, 0);
  assert.equal(totalSum, 1000 + 2000 + 500 + 350 + 500, 'Sum must match exact total bill');
}

// Scenario: tip_mode = 'owner_covers'
{
  const testPeople = ['Sam', 'Asha', 'Meera'];
  const testItems = [1000, 2000];
  const testAssigned = [['Asha'], ['Meera']];
  const shares = computeShares({
    people: testPeople,
    itemCents: testItems,
    assigned: testAssigned,
    taxCents: 300,
    tipCents: 600,
    mode: 'proportional',
    tipMode: 'owner_covers',
    ownerName: 'Sam',
  });

  const sam = shares.find((s) => s.name === 'Sam');
  const asha = shares.find((s) => s.name === 'Asha');
  const meera = shares.find((s) => s.name === 'Meera');

  assert.equal(sam.tipCents, 600, 'Owner covers entire tip');
  assert.equal(asha.tipCents, 0, 'Asha pays 0 tip');
  assert.equal(meera.tipCents, 0, 'Meera pays 0 tip');
  assert.equal(asha.taxCents + meera.taxCents, 300, 'Tax is still allocated proportionally');

  const totalSum = shares.reduce((a, s) => a + s.totalCents, 0);
  assert.equal(totalSum, 1000 + 2000 + 300 + 600, 'Sum must match total');
}

// Scenario: tip_mode = 'even' with proportional tax
{
  const testPeople = ['Sam', 'Asha'];
  const testItems = [1000, 3000]; // 1:3 ratio
  const testAssigned = [['Sam'], ['Asha']];
  const shares = computeShares({
    people: testPeople,
    itemCents: testItems,
    assigned: testAssigned,
    taxCents: 400,
    tipCents: 500,
    mode: 'proportional',
    tipMode: 'even',
    ownerName: 'Sam',
  });

  const sam = shares.find((s) => s.name === 'Sam');
  const asha = shares.find((s) => s.name === 'Asha');

  assert.equal(sam.taxCents, 100, 'Tax is proportional (Sam 25%)');
  assert.equal(asha.taxCents, 300, 'Tax is proportional (Asha 75%)');
  assert.equal(sam.tipCents + asha.tipCents, 500, 'Tip sums to 500');
  assert.equal(Math.abs(sam.tipCents - asha.tipCents) <= 1, true, 'Tip is split evenly');
}

// Fuzz: random bills always sum exactly across all modes and excluded combinations
for (let t = 0; t < 2000; t++) {
  const n = 2 + Math.floor(Math.random() * 7);
  const ppl = Array.from({ length: n }, (_, i) => `P${i}`);
  const owner = ppl[0];
  const cnt = 1 + Math.floor(Math.random() * 10);
  const itemCents = Array.from({ length: cnt }, () => 1 + Math.floor(Math.random() * 9000));
  const excluded = Math.random() < 0.3 ? [ppl[ppl.length - 1]] : [];
  const nonExcluded = ppl.filter((p) => !excluded.includes(p));

  const assignedR = itemCents.map(() =>
    Math.random() < 0.5 ? null : nonExcluded.filter(() => Math.random() < 0.5)
  );

  const tax = Math.floor(Math.random() * 2000);
  const tip = Math.floor(Math.random() * 3000);
  const mode = Math.random() < 0.5 ? 'equal' : 'proportional';
  const tipModes = ['proportional', 'even', 'owner_covers'];
  const tipMode = tipModes[Math.floor(Math.random() * tipModes.length)];

  const shares = computeShares({
    people: ppl,
    itemCents,
    assigned: assignedR,
    taxCents: tax,
    tipCents: tip,
    mode,
    tipMode,
    ownerName: owner,
    excludedPeople: excluded,
  });

  assert.equal(
    shares.reduce((a, s) => a + s.totalCents, 0),
    itemCents.reduce((a, b) => a + b, 0) + tax + tip
  );
  shares.forEach((s) => assert.ok(s.totalCents >= 0));

  if (excluded.length > 0) {
    const exShare = shares.find((s) => s.name === excluded[0]);
    assert.equal(exShare.totalCents, 0, 'Excluded participant with no assigned items must receive 0');
  }
}
console.log('split-math: all tests passed');
