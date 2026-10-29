// Run: node test.js
const assert = require('assert');
const L = require('./logic.js');

const ido = { weight: 75, height: 183, age: 16, sex: 'm', activity: 1.45 };
const t = L.calcTargets(ido);
assert.ok(Math.abs(t.tdee - 2637) < 5, 'tdee ' + t.tdee);
assert.strictEqual(t.kcal, 2350);
assert.strictEqual(t.p, 150);
assert.strictEqual(t.f, 70);
assert.strictEqual(t.c, 280);
assert.strictEqual(L.calcTargets({ ...ido, weight: 55, activity: 1.2 }).kcal, L.KCAL_FLOOR, 'floor clamp');

// 2h ultimate at 75kg: (8-1)*75*2 = 1050 burned, 75% eaten back
assert.strictEqual(L.sportBonus(75, 8, 120), 790);
assert.strictEqual(L.dayTargets(t, 790).kcal, 3140);

assert.strictEqual(L.addDays('2026-12-31', 1), '2027-01-01');
assert.strictEqual(L.addDays('2026-03-01', -1), '2026-02-28');

// Check-in: weight flat → cut 100; losing 1kg/wk → add 100; never below floor; no data → not ready.
const today = '2026-11-14';
const days = L.range(L.addDays(today, -13), today);
const intake = Object.fromEntries(days.map(d => [d, 2400]));
const flat = Object.fromEntries(days.map(d => [d, 75]));
let c = L.weeklyCheckin({ weights: flat, intake, kcal: 2350 }, today);
assert.ok(c.ready && c.kcal === 2250 && c.tdee === 2400, JSON.stringify(c));
const fast = Object.fromEntries(days.map((d, i) => [d, i < 7 ? 76 : 75]));
c = L.weeklyCheckin({ weights: fast, intake, kcal: 2350 }, today);
assert.ok(c.ready && c.kcal === 2450 && c.tdee === 3500, JSON.stringify(c));
assert.strictEqual(L.weeklyCheckin({ weights: flat, intake, kcal: 2250 }, today).kcal, L.KCAL_FLOOR);
assert.strictEqual(L.weeklyCheckin({ weights: {}, intake, kcal: 2350 }, today).ready, false);

assert.strictEqual(L.dayScore({ kcal: 2350, p: 150 }, t, 4), 100);
assert.strictEqual(L.dayScore({ kcal: 3000, p: 75 }, t, 1), 20 + 0 + 7);

const hit = new Set(['2026-11-12', '2026-11-13']);
assert.strictEqual(L.streak(d => hit.has(d), today), 2, 'today pending still counts yesterday');
hit.add(today);
assert.strictEqual(L.streak(d => hit.has(d), today), 3);

// Countdown: 75 → 70 kg with a 287 kcal/day plan; an on-target day removes exactly one day.
const planned = 2637 - 2350;
const g = b => L.goalDays({ fromKg: 75, goalKg: 70, banked: b, planned });
assert.strictEqual(g(0), 135);
assert.strictEqual(g(L.dayCredit(2637, 2350, planned)), 134, 'on target → -1 day');
assert.ok(g(L.dayCredit(2637, 3137, planned)) > 135, 'overeating adds days');
assert.strictEqual(L.dayCredit(2637, 1500, planned), planned * 1.5, 'under-eating credit is capped');
assert.strictEqual(L.dayCredit(2637, 600, planned), 0, 'untracked day = no credit');
assert.strictEqual(g(5 * 7700), 0);

console.log('logic ok');
