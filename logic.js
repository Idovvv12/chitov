// Pure logic shared by app.js (browser) and test.js (node).
const KCAL_FLOOR = 2200;   // growing teen: never target below this
const KCAL_PER_KG = 7700;
const DEFICIT = 300;
const EAT_BACK = 0.75;     // eat back 75% of sport burn, buffer for estimate error

// MET values from the Compendium of Physical Activities. Base activity factor
// (1.45) already covers daily life + 3 calisthenics sessions; these are extra.
const SPORTS = [
  ['אולטימייט פריסבי (משחק)', 8.0],
  ['גולף (הליכה עם תיק)', 4.3],
  ['כדורגל', 7.0],
  ['כדורסל', 6.5],
  ['ריצה', 9.8],
  ['אופניים', 7.0],
  ['שחייה', 6.0],
  ['טניס', 7.3],
  ['הליכה מהירה', 4.3],
  ['אימון כוח נוסף', 5.0],
];

function bmr({ weight, height, age, sex }) {
  return 10 * weight + 6.25 * height - 5 * age + (sex === 'f' ? -161 : 5);
}

function macros(kcal, weight) {
  const p = Math.round(weight * 2 / 5) * 5;
  const f = Math.max(70, Math.round(kcal * 0.25 / 9));
  const c = Math.max(0, Math.round((kcal - p * 4 - f * 9) / 4));
  return { kcal, p, f, c, fib: 30 };
}

function calcTargets(profile) {
  const tdee = Math.round(bmr(profile) * profile.activity);
  const kcal = Math.max(KCAL_FLOOR, Math.round((tdee - DEFICIT) / 50) * 50);
  return { tdee, ...macros(kcal, profile.weight) };
}

// Net extra kcal to eat for a sport session (MET - 1 removes resting burn already in base).
function sportBonus(weight, met, minutes) {
  return Math.round((met - 1) * weight * minutes / 60 * EAT_BACK / 10) * 10;
}

// Day target = base + sport bonus; extra calories go to carbs (fuel).
function dayTargets(targets, bonus) {
  return { ...targets, kcal: targets.kcal + bonus, c: targets.c + Math.round(bonus / 4) };
}

function dayKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function addDays(key, n) {
  const d = new Date(key + 'T12:00:00');
  d.setDate(d.getDate() + n);
  return dayKey(d);
}

function avg(arr) {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
}

function range(from, to) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

// Weekly check-in: compare this week's average weight with last week's, and
// logged intake, to estimate real TDEE and nudge base calories by ±100.
function weeklyCheckin({ weights, intake, kcal }, today) {
  const wk = (from, to) => range(from, to).map(d => weights[d]).filter(Boolean);
  const prev = wk(addDays(today, -13), addDays(today, -7));
  const cur = wk(addDays(today, -6), today);
  const eaten = range(addDays(today, -13), today).map(d => intake[d] || 0).filter(k => k >= 1200);
  if (prev.length < 3 || cur.length < 3 || eaten.length < 7) {
    return { ready: false, prev: prev.length, cur: cur.length, eaten: eaten.length };
  }
  const rate = avg(cur) - avg(prev); // kg per week, negative = losing
  const avgIn = Math.round(avg(eaten));
  const tdee = Math.round(avgIn - rate * KCAL_PER_KG / 7);
  let next = kcal;
  if (rate > -0.2) next -= 100;       // too slow / gaining
  else if (rate < -0.6) next += 100;  // too fast, muscle at risk
  return { ready: true, rate, avgIn, tdee, kcal: Math.max(KCAL_FLOOR, next) };
}

function dayScore(t, target, slots) {
  let s = t.p >= target.p - 10 ? 40 : Math.round(40 * t.p / target.p);
  const off = Math.abs(t.kcal - target.kcal);
  s += off <= 150 ? 40 : off <= 400 ? 20 : 0;
  s += Math.round(Math.min(slots, 3) / 3 * 20);
  return s;
}

// Consecutive days where ok(day) holds; today counts only once it's hit.
function streak(ok, today) {
  let d = ok(today) ? today : addDays(today, -1), n = 0;
  while (ok(d)) { n++; d = addDays(d, -1); }
  return n;
}

if (typeof module !== 'undefined') {
  module.exports = { KCAL_FLOOR, SPORTS, bmr, macros, calcTargets, sportBonus, dayTargets, dayKey, addDays, range, weeklyCheckin, dayScore, streak };
}
