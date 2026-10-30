'use strict';
// UI + storage. Pure nutrition math lives in logic.js; starter foods in foods.js.

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const r0 = Math.round, r1 = n => Math.round(n * 10) / 10;
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const todayKey = () => dayKey(new Date());
const norm = s => String(s || '').toLowerCase().replace(/['"׳״`]/g, '');

const GEMINI_MODEL = 'gemini-flash-latest';
const OFF = 'https://world.openfoodfacts.org';
const OFF_FIELDS = 'code,product_name,product_name_he,brands,nutriments,serving_quantity,product_quantity';
const SLOTS = [['b', 'בוקר'], ['l', 'צהריים'], ['d', 'ערב'], ['s', 'נשנושים']];
const LINES = ['הקוביות נבנות במטבח', 'עקביות מנצחת שלמות', 'חלבון קודם, השאר אחר כך', 'עוד יום טוב, עוד צעד',
  'השינה היא חלק מהאימון', 'גירעון קטן, שריר נשמר', 'הגרסה הכי חזקה שלך בדרך', 'לא מושלם. עקבי.'];

// ---------- state ----------
const KEY = 'chitov', PHOTOS = 'chitov-photos';
const DEFAULTS = () => ({
  profile: { weight: 75, height: 183, age: 16, sex: 'm', activity: 1.45, start: todayKey() },
  targets: null, foods: {}, log: {}, weights: {}, sports: {}, favs: {}, celebrated: {},
  settings: { geminiKey: '' }, lastCheckin: null, goal: null, chat: [],
});
let S = load();
function load() {
  let s = null;
  try { s = JSON.parse(localStorage.getItem(KEY)); } catch {}
  s = { ...DEFAULTS(), ...s };
  if (!s.targets) s.targets = calcTargets(s.profile);
  // ~70 kg ≈ 10–12% body fat for Ido (now ~17–19%), i.e. visible abs. Editable in settings.
  if (!s.goal) s.goal = { kg: 70, startKg: s.profile.weight, fromKg: s.profile.weight, from: s.profile.start };
  return s;
}
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(S)); }
  catch { toast('האחסון מלא – ייצא גיבוי ומחק תמונות ישנות', 6000); }
}
function loadPhotos() { try { return JSON.parse(localStorage.getItem(PHOTOS)) || []; } catch { return []; } }

let tab = 'today', viewDay = todayKey(), addSlot = slotNow(), query = '', offResults = null, chatBusy = false;

const STARTER = Object.fromEntries(FOODS.map(f => [f.id, f]));
const allFoods = () => Object.values({ ...STARTER, ...S.foods });
const getFood = id => S.foods[id] || STARTER[id] || offResults?.items.find(f => f.id === id);
// Online search results live in memory until actually logged.
const persist = food => { if (!S.foods[food.id] && !STARTER[food.id]) S.foods[food.id] = food; };

function slotNow() {
  const h = new Date().getHours() + new Date().getMinutes() / 60;
  return h < 10.5 ? 'b' : h < 15 ? 'l' : h < 18.5 ? 's' : 'd';
}

// ---------- day math ----------
function totals(day) {
  const t = { kcal: 0, p: 0, c: 0, f: 0, fib: 0 };
  for (const e of S.log[day] || []) for (const k in t) t[k] += e[k] || 0;
  return t;
}
const bonusOf = day => (S.sports[day] || []).reduce((a, s) => a + s.kcal, 0);
const targetOf = day => dayTargets(S.targets, bonusOf(day));
const proteinHit = day => totals(day).p >= targetOf(day).p - 10;
const slotsLogged = day => new Set((S.log[day] || []).map(e => e.slot)).size;

// Goal countdown: every completed day since the anchor banks its real deficit (logic.js dayCredit).
// The anchor moves to the measured trend weight at each weekly check-in, so reality corrects the estimate.
const planned = () => Math.max(100, S.targets.tdee - S.targets.kcal);
function daysLeft(upTo) {
  const banked = range(S.goal.from, upTo).reduce((a, d) => a + dayCredit(S.targets.tdee + bonusOf(d), totals(d).kcal, planned()), 0);
  return goalDays({ fromKg: S.goal.fromKg, goalKg: S.goal.kg, banked, planned: planned() });
}

function unitGrams(food, unit) {
  return unit ? ((food.units || []).find(u => u[0] === unit) || [unit, 100])[1] : 1;
}
function makeEntry(food, qty, unit, slot) {
  const g = qty * unitGrams(food, unit), k = g / 100;
  return {
    id: uid(), foodId: food.id, name: food.name, slot, qty, unit, g: r1(g),
    kcal: r0(food.kcal * k), p: r1(food.p * k), c: r1(food.c * k), f: r1(food.f * k), fib: r1((food.fib || 0) * k),
  };
}
const fmtQty = q => q === 0.5 ? '½' : String(r1(q));
const qtyLabel = e => e.unit ? `${fmtQty(e.qty)} ${e.unit}` : `${r0(e.qty)} ג'`;

function lastUse(foodId) {
  for (const d of Object.keys(S.log).sort().reverse()) {
    const e = [...S.log[d]].reverse().find(x => x.foodId === foodId);
    if (e) return e;
  }
  return null;
}
function defaultPortion(food) {
  const last = lastUse(food.id), units = food.units || [];
  if (last && (!last.unit || units.some(u => u[0] === last.unit))) return { qty: last.qty, unit: last.unit };
  return units.length ? { qty: 1, unit: units[0][0] } : { qty: 100, unit: null };
}
// A deleted food can still be edited from its log entry.
function foodFromEntry(e) {
  const k = e.g ? 100 / e.g : 0;
  return { id: e.foodId, name: e.name, kcal: r0(e.kcal * k), p: r1(e.p * k), c: r1(e.c * k), f: r1(e.f * k), fib: r1(e.fib * k), units: e.unit ? [[e.unit, e.g / e.qty]] : [] };
}

function recents() {
  const count = {};
  for (const d of Object.keys(S.log).sort().slice(-21)) for (const e of S.log[d]) count[e.foodId] = (count[e.foodId] || 0) + 1;
  return Object.keys(count).filter(getFood).sort((a, b) => count[b] - count[a]).slice(0, 15).map(getFood);
}
function searchFoods(q) {
  const words = norm(q).trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  return allFoods()
    .filter(f => { const s = norm(f.name + ' ' + (f.brand || '')); return words.every(w => s.includes(w)); })
    .sort((a, b) => (norm(b.name).startsWith(words[0]) - norm(a.name).startsWith(words[0])) || a.name.length - b.name.length)
    .slice(0, 40);
}

function addEntries(day, entries) {
  (S.log[day] ||= []).push(...entries);
  afterLog(day);
}
function afterLog(day) {
  save();
  if (proteinHit(day) && !S.celebrated[day]) {
    S.celebrated[day] = 1;
    save();
    const n = streak(proteinHit, todayKey());
    celebrate(n > 1 ? `יעד החלבון הושג! ${n} ימים ברצף 🔥` : 'יעד החלבון הושג! 🔥');
  }
}

// ---------- views ----------
const dayLabel = d => d === todayKey() ? 'היום' : d === addDays(todayKey(), -1) ? 'אתמול'
  : new Date(d + 'T12:00:00').toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'numeric' });

function ring(val, max) {
  const C = 2 * Math.PI * 52, pct = Math.min(1, val / max || 0);
  return `<svg class="ring" viewBox="0 0 120 120" aria-hidden="true">
    <circle cx="60" cy="60" r="52" class="ring-bg"/>
    <circle cx="60" cy="60" r="52" class="ring-fg ${val > max ? 'over' : ''}" stroke-dasharray="${C}" stroke-dashoffset="${C * (1 - pct)}"/>
  </svg>`;
}
function bar(label, val, max, cls) {
  return `<div class="bar ${cls}"><div class="bar-head"><span>${label}</span><span><b>${r0(val)}</b> / ${max} ג'</span></div>
    <div class="bar-track"><div style="width:${Math.min(100, val / max * 100)}%"></div></div></div>`;
}

function goalCard() {
  const today = todayKey(), y = addDays(today, -1);
  const n = daysLeft(y), was = daysLeft(addDays(today, -2)), g = S.goal;
  if (!n) return `<section class="card goal"><b>🎉 הגעת ליעד המשוער!</b><p class="small muted">שקול את עצמך כמה בקרים, ואם רוצה עוד – עדכן משקל יעד בלשונית "תוכנית".</p></section>`;
  const nowKg = g.kg + n * planned() / KCAL_PER_KG;
  const pct = Math.max(0, Math.min(100, (g.startKg - nowKg) / (g.startKg - g.kg) * 100 || 0));
  const eta = new Date(addDays(today, n) + 'T12:00:00').toLocaleDateString('he-IL', { day: 'numeric', month: 'long' });
  const msg = n < was ? `אתמול קירב אותך ב-${was - n} ${was - n === 1 ? 'יום' : 'ימים'} 🔥`
    : n > was ? `אתמול היה כבד יותר (+${n - was}) – זה בסדר, היום יום חדש.`
    : totals(y).kcal < 1200 ? 'יום לא מתועד לא מקרב – תעד הכל.' : '';
  return `<section class="card goal">
    <div class="goal-head"><div><small>ימים לקוביות (יעד ${g.kg} ק״ג)</small><b>${n}</b></div><small>≈ ${eta}</small></div>
    <div class="bar-track"><div style="width:${pct}%"></div></div>
    <p class="small muted">${msg} כל יום שנגמר על היעד = יום אחד פחות.</p>
  </section>`;
}

function viewToday() {
  const d = viewDay, today = todayKey(), t = totals(d), tg = targetOf(d);
  const left = r0(tg.kcal - t.kcal);
  const dayNum = Math.max(1, r0((new Date(today) - new Date(S.profile.start)) / 864e5) + 1);
  const score = dayScore(t, tg, slotsLogged(d));
  const pStreak = streak(proteinHit, today), lStreak = streak(x => slotsLogged(x) >= 2, today);
  const sports = S.sports[d] || [];
  const yest = S.log[addDays(d, -1)] || [];
  return `
  <header class="top">
    <div><div class="eyebrow">יום ${dayNum} בדרך לקוביות</div><h1>${LINES[dayNum % LINES.length]}</h1></div>
    <div class="score s${score >= 80 ? 'hi' : score >= 50 ? 'mid' : 'lo'}"><b>${score}</b><small>ציון</small></div>
  </header>
  <div class="daynav">
    <button data-act="day" data-n="-1" aria-label="יום קודם">›</button><span>${dayLabel(d)}</span>
    <button data-act="day" data-n="1" aria-label="יום הבא" ${d === today ? 'disabled' : ''}>‹</button>
  </div>
  ${d === today && checkinDue() ? `<button class="banner" data-act="tab" data-tab="plan">📊 בדיקה שבועית מוכנה – בוא נראה איך התקדמת</button>` : ''}
  <section class="card hero">
    <div class="ring-wrap">${ring(t.kcal, tg.kcal)}
      <div class="ring-center"><b>${Math.abs(left).toLocaleString()}</b><small>${left >= 0 ? 'קלוריות נשארו' : 'מעל היעד'}</small></div>
    </div>
    <div class="hero-side">
      ${bar('חלבון', t.p, tg.p, 'prot')}
      ${bar('פחמימות', t.c, tg.c, 'carb')}
      ${bar('שומן', t.f, tg.f, 'fat')}
      <div class="kcal-line">${r0(t.kcal).toLocaleString()} / ${tg.kcal.toLocaleString()} קל'${bonusOf(d) ? ` <span class="bonus">כולל +${bonusOf(d)} ספורט</span>` : ''}</div>
    </div>
  </section>
  <div class="pills">
    <span class="pill">🔥 חלבון ${pStreak} ${pStreak === 1 ? 'יום' : 'ימים'}</span>
    <span class="pill">📅 רישום ${lStreak} ${lStreak === 1 ? 'יום' : 'ימים'}</span>
    <span class="pill">🌾 סיבים ${r0(t.fib)}/${tg.fib}</span>
  </div>
  ${goalCard()}
  <section class="card sport">
    <div class="sport-head"><b>⚡ ספורט</b><button class="chip" data-act="sport">+ הוסף</button></div>
    ${sports.length ? sports.map(s => `<div class="sport-row"><span>${esc(s.name)} · ${s.min} דק'</span><span class="bonus">+${s.kcal} קל'</span><button class="x" data-act="delSport" data-id="${s.id}" aria-label="מחק">✕</button></div>`).join('')
      : '<p class="muted small">משחק אולטימייט / גולף? הוסף אותו וקבל עוד אוכל היום.</p>'}
  </section>
  ${SLOTS.map(([k, name]) => {
    const items = (S.log[d] || []).filter(e => e.slot === k);
    const sum = items.reduce((a, e) => a + e.kcal, 0), prot = items.reduce((a, e) => a + e.p, 0);
    const prev = yest.filter(e => e.slot === k);
    return `<section class="card slot">
      <div class="slot-head"><div><b>${name}</b>${items.length ? `<small>${r0(sum)} קל' · ${r0(prot)}ג' חלבון</small>` : ''}</div>
        <button class="add-btn" data-act="addTo" data-k="${k}" aria-label="הוסף ל${name}">+</button></div>
      ${items.map(e => `<button class="entry" data-act="entry" data-id="${e.id}"><span>${esc(e.name)}<small>${esc(qtyLabel(e))}</small></span><span class="num">${e.kcal}<small>${r0(e.p)}ג' ח'</small></span></button>`).join('')}
      ${!items.length && prev.length ? `<button class="ghost small" data-act="copy" data-k="${k}">↺ העתק מאתמול (${prev.length})</button>` : ''}
    </section>`;
  }).join('')}`;
}

function foodRow(f) {
  const p = defaultPortion(f), e = makeEntry(f, p.qty, p.unit, addSlot);
  return `<div class="row" data-act="food" data-id="${esc(f.id)}">
    <div class="row-main"><b>${esc(f.name)}</b><small>${f.brand ? esc(f.brand) + ' · ' : ''}${esc(qtyLabel(e))} · ${e.kcal} קל' · ${r0(e.p)}ג' חלבון</small></div>
    <button class="plus" data-act="quick" data-id="${esc(f.id)}" aria-label="הוסף מהר">+</button>
  </div>`;
}
const section = (title, foods) => foods.length ? `<h3>${title}</h3><div class="list">${foods.map(foodRow).join('')}</div>` : '';

function resultsHtml() {
  const newBtn = `<button class="ghost wide" data-act="newFood">+ מוצר חדש (הזנה ידנית)</button>`;
  if (!query.trim()) {
    const favs = Object.keys(S.favs).map(getFood).filter(Boolean);
    const rec = recents().filter(f => !S.favs[f.id]);
    const meals = Object.values(S.foods).filter(f => f.kind === 'meal');
    const empty = !favs.length && !rec.length && !meals.length;
    return section('⭐ מועדפים', favs) + section('🕘 אוכל לעתים קרובות', rec) + section('🍲 המנות שלי', meals)
      + (empty ? `<p class="empty">חפש, סרוק ברקוד או צלם תווית. מה שתאכל יופיע כאן – בפעם הבאה זו לחיצה אחת.</p>` : '') + newBtn;
  }
  const hits = searchFoods(query);
  let off = '';
  if (offResults?.q === query) {
    off = offResults.items.length ? section('🌐 מהמאגר העולמי', offResults.items) : '<p class="empty">לא נמצא במאגר העולמי.</p>';
  } else if (query.trim().length >= 2) {
    off = `<button class="ghost wide" data-act="offSearch">🌐 חפש "${esc(query)}" במאגר המוצרים העולמי</button>`;
  }
  return (hits.length ? `<div class="list">${hits.map(foodRow).join('')}</div>` : '<p class="empty">אין תוצאות אצלך.</p>') + off + newBtn;
}

function viewAdd() {
  return `
  <header class="top"><div><div class="eyebrow">${dayLabel(viewDay)}</div><h1>מה אכלת?</h1></div></header>
  <div class="chips">${SLOTS.map(([k, n]) => `<button class="chip ${k === addSlot ? 'on' : ''}" data-act="slot" data-k="${k}">${n}</button>`).join('')}</div>
  <div class="quick">
    <button class="big" data-act="scan"><span class="ic">▥</span>סריקת ברקוד</button>
    <button class="big" data-act="label"><span class="ic">📷</span>צילום תווית</button>
    <button class="big" data-act="newMeal"><span class="ic">🍲</span>מנה חדשה</button>
  </div>
  <input id="q" type="search" placeholder="חפש: קוטג', פיתה, במבה…" value="${esc(query)}" autocomplete="off">
  <div id="results">${resultsHtml()}</div>`;
}

function trendAt(d) {
  const v = range(addDays(d, -6), d).map(x => S.weights[x]).filter(Boolean);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}
function chart() {
  const today = todayKey(), first = Object.keys(S.weights).sort()[0] || today;
  const days = range(first > addDays(today, -59) ? first : addDays(today, -59), today);
  const pts = days.map((d, i) => ({ i, w: S.weights[d], t: S.weights[d] ? trendAt(d) : null })).filter(p => p.w);
  if (pts.length < 2) return '<p class="muted small">שקול את עצמך כל בוקר (אחרי שירותים, לפני אוכל). הגרף יופיע אחרי 2 שקילות.</p>';
  const ws = pts.flatMap(p => [p.w, p.t]);
  const lo = Math.min(...ws) - 0.3, hi = Math.max(...ws) + 0.3;
  const x = i => 8 + i / Math.max(1, days.length - 1) * 272, y = w => 8 + (hi - w) / (hi - lo) * 124;
  return `<svg class="chart" viewBox="0 0 320 140" role="img" aria-label="גרף משקל 60 יום">
    <text x="316" y="14" class="axis">${hi.toFixed(1)}</text><text x="316" y="136" class="axis">${lo.toFixed(1)}</text>
    ${pts.map(p => `<circle cx="${x(p.i)}" cy="${y(p.w)}" r="2.5" class="dot"/>`).join('')}
    <polyline class="trend" points="${pts.map(p => `${x(p.i)},${y(p.t)}`).join(' ')}"/>
  </svg>`;
}

function viewProgress() {
  const today = todayKey(), keys = Object.keys(S.weights).sort();
  const start = keys.length ? S.weights[keys[0]] : null, now = trendAt(today);
  const prevT = trendAt(addDays(today, -7));
  const week = range(addDays(today, -7), addDays(today, -1)); // last 7 complete days
  const logged = week.filter(d => (S.log[d] || []).length);
  const avgK = logged.length ? r0(logged.reduce((a, d) => a + totals(d).kcal, 0) / logged.length) : 0;
  const pDays = week.filter(proteinHit).length;
  const sportMin = week.reduce((a, d) => a + (S.sports[d] || []).reduce((b, s) => b + s.min, 0), 0);
  const photos = loadPhotos();
  const sign = n => `<span dir="ltr">${n > 0 ? '+' : ''}${n.toFixed(1)}</span>`;
  return `
  <header class="top"><div><div class="eyebrow">התקדמות</div><h1>המספרים לא משקרים</h1></div></header>
  <section class="card">
    <div class="weigh"><input id="wIn" type="number" inputmode="decimal" step="0.1" placeholder="משקל היום (ק״ג)" value="${S.weights[today] ?? ''}">
      <button class="primary" data-act="saveWeight">שמור</button></div>
    ${chart()}
    <div class="legend"><span class="dot-l"></span> שקילה <span class="line-l"></span> ממוצע 7 ימים (זה מה שקובע)</div>
  </section>
  <div class="stats">
    <div class="stat"><small>מגמה עכשיו</small><b>${now ? now.toFixed(1) : '–'}</b></div>
    <div class="stat"><small>השבוע</small><b>${now && prevT ? sign(now - prevT) : '–'}</b></div>
    <div class="stat"><small>מההתחלה</small><b>${now && start ? sign(now - start) : '–'}</b></div>
  </div>
  <section class="card">
    <h3>📋 סיכום 7 הימים האחרונים</h3>
    <p>ממוצע: <b>${avgK.toLocaleString()}</b> קל' ביום (יעד בסיס ${S.targets.kcal.toLocaleString()})</p>
    <p>יעד חלבון הושג: <b>${pDays}/7</b> ימים ${pDays >= 6 ? '💪' : ''}</p>
    <p>ספורט נוסף: <b>${sportMin}</b> דקות</p>
    <p class="muted small">יעד הקצב: ירידה של 0.25–0.5 ק״ג בשבוע. מהר יותר = מאבדים שריר.</p>
  </section>
  <section class="card">
    <div class="sport-head"><h3>📸 תמונות התקדמות</h3><button class="chip" data-act="addPhoto">+ תמונה</button></div>
    <p class="muted small">פעם בשבוע, אותו מקום, אותה תאורה, בבוקר. המראה משתנה לפני שהמשקל זז. נשמר רק בטלפון.</p>
    ${photos.length >= 2 ? `<div class="compare"><figure><img src="${photos[0].data}" alt=""><figcaption>${photos[0].date}</figcaption></figure><figure><img src="${photos.at(-1).data}" alt=""><figcaption>${photos.at(-1).date}</figcaption></figure></div>` : ''}
    <div class="thumbs">${photos.map((p, i) => `<button data-act="delPhoto" data-i="${i}" aria-label="תמונה ${p.date}"><img src="${p.data}" alt=""><small>${p.date.slice(5)}</small></button>`).join('')}</div>
  </section>`;
}

function checkin() {
  const intake = {};
  for (const d in S.log) intake[d] = totals(d).kcal;
  return weeklyCheckin({ weights: S.weights, intake, kcal: S.targets.kcal }, todayKey());
}
const checkinDue = () => (!S.lastCheckin || S.lastCheckin <= addDays(todayKey(), -7)) && checkin().ready;

function viewPlan() {
  const t = S.targets, c = checkin(), p = S.profile;
  const due = !S.lastCheckin || S.lastCheckin <= addDays(todayKey(), -7);
  let ck;
  if (!c.ready) {
    ck = `<p class="muted">צריך עוד נתונים: לפחות 3 שקילות בכל אחד מהשבועיים האחרונים (יש ${c.prev} ו-${c.cur}) ו-7 ימים מתועדים מלאים (יש ${c.eaten}).</p>`;
  } else {
    const verdict = c.rate > -0.2 ? 'ירידה איטית מדי – מורידים 100 קל\'.' : c.rate < -0.6 ? 'ירידה מהירה מדי – מוסיפים 100 קל\' כדי לשמור על שריר.' : 'בדיוק בקצב הנכון. ממשיכים ככה! 🎯';
    ck = `<p>שינוי שבועי: <b><span dir="ltr">${c.rate > 0 ? '+' : ''}${c.rate.toFixed(2)}</span> ק״ג</b> · אכלת בממוצע <b>${c.avgIn.toLocaleString()}</b></p>
      <p>שריפה אמיתית מוערכת: <b>${c.tdee.toLocaleString()}</b> קל' ביום</p>
      <p><b>${verdict}</b></p>
      ${due ? `<button class="primary wide" data-act="applyCheckin">עדכן יעד ל-${c.kcal.toLocaleString()}</button>` : `<p class="muted small">עודכן ב-${S.lastCheckin}. הבדיקה הבאה בעוד שבוע.</p>`}`;
  }
  return `
  <header class="top"><div><div class="eyebrow">התוכנית</div><h1>חיטוב בלי לאבד שריר</h1></div></header>
  <section class="card targets">
    <div class="tgrid">
      <div><b>${t.kcal.toLocaleString()}</b><small>קלוריות (בסיס)</small></div>
      <div class="prot"><b>${t.p}</b><small>חלבון ג'</small></div>
      <div class="carb"><b>${t.c}</b><small>פחמימות ג'</small></div>
      <div class="fat"><b>${t.f}</b><small>שומן ג'</small></div>
    </div>
    <p class="small">תחזוקה מוערכת ~${t.tdee.toLocaleString()} → גירעון קטן של ~300. <b>מינימום ${KCAL_FLOOR.toLocaleString()}</b> – אתה עדיין גדל, ודיאטה חזקה מדי שורפת שריר.</p>
    <p class="small">ימי ספורט: מוסיפים ⚡ בלשונית "היום" והיעד עולה אוטומטית (75% מהשריפה, כדי לא להגזים). 2 שעות אולטימייט ≈ +${sportBonus(p.weight, 8, 120)} קל'.</p>
  </section>
  <section class="card"><h3>📊 בדיקה שבועית</h3>${ck}</section>
  <section class="card">
    <h3>🎯 כמה זמן לקוביות?</h3>
    <p class="small">גירעון מתוכנן ~${planned()} קל' ביום ≈ <b>${(planned() * 7 / KCAL_PER_KG).toFixed(2)} ק״ג בשבוע</b>. מ-${S.goal.fromKg} ל-${S.goal.kg} ק״ג ≈ <b>${goalDays({ fromKg: S.goal.fromKg, goalKg: S.goal.kg, banked: 0, planned: planned() })} ימים</b>. זה לא 30 יום – ירידה מהירה יותר בגיל 16 שורפת שריר ופוגעת בגדילה.</p>
    <p class="muted small">יום על היעד = יום אחד פחות. אכלת יותר – הספירה עולה; יום לא מתועד לא נספר. בכל בדיקה שבועית הספירה מתעדכנת לפי המשקל האמיתי שלך.</p>
  </section>
  <section class="card">
    <h3>🍽️ יום לדוגמה (~2,350 קל' · ~165ג' חלבון)</h3>
    <ul class="plan">
      <li><b>בוקר:</b> 3 ביצים + 2 פרוסות לחם מלא + ירקות + 2 כפות קוטג' <span>~480 · 33ג'</span></li>
      <li><b>בבית ספר:</b> יוגורט PRO + בננה <span>~230 · 21ג'</span></li>
      <li><b>צהריים:</b> 150ג' חזה עוף + כוס אורז + סלט + כף טחינה <span>~660 · 57ג'</span></li>
      <li><b>לפני/אחרי אימון:</b> פיתה מלאה + חצי קופסת טונה + ירקות <span>~300 · 24ג'</span></li>
      <li><b>ערב:</b> שקשוקה + פרוסת לחם + 2 כפות גבינה לבנה <span>~410 · 24ג'</span></li>
      <li><b>נשנוש:</b> חופן שקדים + תפוח <span>~260 · 6ג'</span></li>
    </ul>
    <p class="muted small">ביום אולטימייט: מוסיפים פחמימות – עוד פיתה, אורז, פירות, תמרים.</p>
  </section>
  <section class="card">
    <h3>💡 מה באמת עושה את ההבדל</h3>
    <ul class="tips">
      <li><b>חלבון בכל ארוחה</b> – 30–40 ג' × 4 ארוחות עדיף על מנה ענקית אחת.</li>
      <li><b>שינה 8–9 שעות</b> – בגיל שלך זה הכלי הכי חזק לבניית שריר וירידה בשומן. בחינם.</li>
      <li><b>עומס מתקדם בקליסתניקס</b> – כל שבוע עוד חזרה או וריאציה קשה יותר (שכיבות → יהלום → ארצ'ר). זה מה שבונה שריר.</li>
      <li><b>קוביות = שומן נמוך + שרירי בטן חזקים</b> – Hanging leg raises, L-sit, פלאנק. אבל רואים אותן רק כשהשומן יורד.</li>
      <li><b>אין קיצורי דרך</b> – לא שורפי שומן, לא "דיטוקס". קריאטין – רק אחרי גיל 18 או באישור רופא. אבקת חלבון זה סתם אוכל, מותר.</li>
      <li><b>משקל קופץ ±1 ק״ג ביום</b> ממים ומלח – זה נורמלי. מסתכלים רק על הממוצע השבועי.</li>
      <li><b>שעון Garmin</b> – מעולה לדופק ולדקות אימון. את מספר הקלוריות שלו לא לוקחים (טעות של 20–50%) – מכניסים דקות ב"ספורט".</li>
      <li>כדאי להראות את התוכנית להורים / לרופא.</li>
    </ul>
  </section>
  <section class="card settings">
    <h3>⚙️ הגדרות</h3>
    <div class="grid3">
      <label>משקל<input id="pw" type="number" inputmode="decimal" step="0.1" value="${p.weight}"></label>
      <label>גובה<input id="ph" type="number" inputmode="numeric" value="${p.height}"></label>
      <label>גיל<input id="pa" type="number" inputmode="numeric" value="${p.age}"></label>
    </div>
    <label>פעילות בסיס<select id="pact">
      ${[[1.3, 'מעט פעילות'], [1.45, '3 אימונים בשבוע (ספורט נוסף מוסיפים ביום עצמו)'], [1.6, '5+ אימונים בשבוע']].map(([v, n]) => `<option value="${v}" ${p.activity === v ? 'selected' : ''}>${n}</option>`).join('')}
    </select></label>
    <label>משקל יעד (ק״ג)<input id="pg" type="number" inputmode="decimal" step="0.5" value="${S.goal.kg}"></label>
    <button class="ghost wide" data-act="saveProfile">שמור וחשב יעדים מחדש</button>
    <label>מפתח Gemini (לקריאת תוויות)<input id="gk" type="password" autocomplete="off" placeholder="AIza…" value="${esc(S.settings.geminiKey)}"></label>
    <p class="muted small">חינם מ-<a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">aistudio.google.com/apikey</a>. נשמר רק בטלפון הזה.</p>
    <button class="ghost wide" data-act="saveKey">שמור מפתח</button>
    <div class="row2"><button class="ghost" data-act="exportData">⬇ גיבוי</button><button class="ghost" data-act="importData">⬆ שחזור</button></div>
  </section>`;
}

const VIEWS = { today: viewToday, add: viewAdd, chat: viewChat, progress: viewProgress, plan: viewPlan };
function render() {
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
  $('#view').innerHTML = VIEWS[tab]();
  if (tab === 'chat') scrollTo(0, document.body.scrollHeight);
}

// ---------- sheets ----------
const dlg = $('#sheet'), body = $('#sheet-body');
function sheet(html) { body.innerHTML = html; if (!dlg.open) dlg.showModal(); body.scrollTop = 0; }
const closeSheet = () => dlg.open && dlg.close();
dlg.addEventListener('click', e => { if (e.target === dlg) closeSheet(); });
dlg.addEventListener('close', render);

function openFood(food, entry) {
  const units = food.units || [];
  let qty, unit;
  if (entry) {
    unit = units.some(u => u[0] === entry.unit) ? entry.unit : null;
    qty = entry.unit && !unit ? entry.g : entry.qty;
  } else ({ qty, unit } = defaultPortion(food));
  let slot = entry ? entry.slot : addSlot;
  sheet(`
    <h2>${esc(food.name)}</h2>
    <p class="muted small">${food.brand ? esc(food.brand) + ' · ' : ''}ל-100ג': ${r0(food.kcal)} קל' · ח' ${r1(food.p)} · פ' ${r1(food.c)} · ש' ${r1(food.f)}</p>
    ${food.barcode && !food.ok ? `<p class="warn">⚠️ ערכים מהמאגר העולמי שלא אומתו. לחץ "ערוך ערכים" והשווה לאריזה.</p>` : ''}
    <div class="macros" id="fm"></div>
    <div class="qty">
      <button type="button" id="fminus" aria-label="פחות">−</button>
      <input id="fq" type="number" inputmode="decimal" step="any" min="0" aria-label="כמות">
      <button type="button" id="fplus" aria-label="יותר">+</button>
      <select id="fu" aria-label="יחידה">${units.map(u => `<option value="${esc(u[0])}">${esc(u[0])} (${r0(u[1])}ג')</option>`).join('')}<option value="">גרם</option></select>
    </div>
    <div class="chips" id="fs">${SLOTS.map(([k, n]) => `<button type="button" class="chip" data-k="${k}">${n}</button>`).join('')}</div>
    <button class="primary wide" id="fadd" autofocus>${entry ? 'עדכן' : 'הוסף'}</button>
    <div class="row2">
      <button class="ghost" id="ffav">${S.favs[food.id] ? '★ מועדף' : '☆ למועדפים'}</button>
      <button class="ghost" id="fedit">${food.id.startsWith('s:') && !S.foods[food.id] ? '✎ ערכים מהאריזה' : '✎ ערוך ערכים'}</button>
    </div>
    ${entry ? '<button class="danger wide" id="fdel">מחק מהיומן</button>' : ''}`);
  const fq = $('#fq'), fu = $('#fu');
  const draw = (keepInput) => {
    if (!keepInput) fq.value = qty;
    fu.value = unit || '';
    const e = makeEntry(food, qty, unit, slot);
    $('#fm').innerHTML = `<div><b>${e.kcal}</b><small>קל'</small></div><div class="prot"><b>${r0(e.p)}</b><small>חלבון</small></div><div class="carb"><b>${r0(e.c)}</b><small>פחמ'</small></div><div class="fat"><b>${r0(e.f)}</b><small>שומן</small></div>`;
    document.querySelectorAll('#fs .chip').forEach(c => c.classList.toggle('on', c.dataset.k === slot));
  };
  fq.oninput = () => { qty = Math.max(0, +fq.value || 0); draw(true); };
  const step = dir => { qty = Math.max(0, r1(qty + dir * (unit ? 0.5 : 10))); draw(); };
  $('#fminus').onclick = () => step(-1);
  $('#fplus').onclick = () => step(1);
  fu.onchange = () => { const g = qty * unitGrams(food, unit); unit = fu.value || null; qty = unit ? 1 : r0(g); draw(); };
  $('#fs').onclick = e => { const k = e.target.closest('[data-k]')?.dataset.k; if (k) { slot = k; draw(); } };
  $('#fadd').onclick = () => {
    if (!(qty > 0)) return toast('כמות לא תקינה');
    const e = makeEntry(food, qty, unit, slot);
    persist(food);
    if (entry) {
      const list = S.log[viewDay];
      list[list.findIndex(x => x.id === entry.id)] = { ...e, id: entry.id };
      afterLog(viewDay);
    } else {
      addEntries(viewDay, [e]);
      toast(`✓ ${food.name} – ${e.kcal} קל'`);
      query = ''; offResults = null;
    }
    closeSheet();
  };
  $('#ffav').onclick = () => {
    persist(food);
    if (S.favs[food.id]) delete S.favs[food.id]; else S.favs[food.id] = 1;
    save(); $('#ffav').textContent = S.favs[food.id] ? '★ מועדף' : '☆ למועדפים';
  };
  $('#fedit').onclick = () => food.kind === 'meal' ? openRecipe(food) : openFoodForm(food);
  if (entry) $('#fdel').onclick = () => {
    const list = S.log[viewDay], i = list.findIndex(x => x.id === entry.id);
    const [removed] = list.splice(i, 1);
    save(); closeSheet();
    toast('נמחק', 4000, () => { list.splice(i, 0, removed); save(); render(); });
  };
  draw();
}

function quickAdd(food) {
  const p = defaultPortion(food), e = makeEntry(food, p.qty, p.unit, addSlot);
  persist(food);
  addEntries(viewDay, [e]);
  const list = S.log[viewDay];
  toast(`✓ ${food.name} (${qtyLabel(e)}) – ${e.kcal} קל'`, 4000, () => { list.splice(list.indexOf(e), 1); save(); render(); });
  render();
}

function openFoodForm(init = {}, note = '', onFood = openFood) {
  sheet(`
    <h2>${S.foods[init.id] || STARTER[init.id] ? 'עריכת מוצר' : 'מוצר חדש'}</h2>
    ${note ? `<p class="note">${esc(note)}</p>` : ''}
    <button type="button" class="primary wide" id="ffscan">📷 מלא אוטומטית מצילום התווית</button>
    <form id="ff" class="form">
      <label>שם<input name="name" required></label>
      <div class="grid2"><label>מותג<input name="brand"></label><label>ברקוד<input name="barcode" inputmode="numeric"></label></div>
      <fieldset><legend>ערכים ל-100 גרם (כמו שכתוב על האריזה)</legend>
        <div class="grid5">
          <label>קלוריות<input name="kcal" type="number" step="any" min="0" required inputmode="decimal"></label>
          <label>חלבון<input name="p" type="number" step="any" min="0" required inputmode="decimal"></label>
          <label>פחמימות<input name="c" type="number" step="any" min="0" required inputmode="decimal"></label>
          <label>שומן<input name="f" type="number" step="any" min="0" required inputmode="decimal"></label>
          <label>סיבים<input name="fib" type="number" step="any" min="0" inputmode="decimal"></label>
        </div>
      </fieldset>
      <fieldset><legend>יחידות (לא חובה)</legend>
        <div class="grid2"><label>שם<input name="u1" placeholder="גביע / פיתה / מנה"></label><label>גרם<input name="u1g" type="number" step="any" min="0" inputmode="decimal"></label></div>
        <div class="grid2"><label>שם<input name="u2" placeholder="אריזה"></label><label>גרם<input name="u2g" type="number" step="any" min="0" inputmode="decimal"></label></div>
      </fieldset>
      <p class="warn" id="ffwarn" hidden></p>
      <button class="primary wide">שמור והמשך</button>
      ${S.foods[init.id] ? '<button type="button" class="danger wide" id="ffdel">מחק מוצר</button>' : ''}
    </form>`);
  const form = $('#ff'), el = form.elements;
  // Label numbers should roughly add up: 4/4/9 kcal per gram of protein/carbs/fat (+2 for fiber).
  const check = () => {
    const k = +el.kcal.value, calc = 4 * +el.p.value + 4 * +el.c.value + 9 * +el.f.value + 2 * (+el.fib.value || 0);
    const bad = k > 20 && Math.abs(calc - k) / k > 0.2;
    $('#ffwarn').hidden = !bad;
    if (bad) $('#ffwarn').textContent = `⚠️ לפי החלבון/פחמימות/שומן יוצא ~${r0(calc)} קל', לא ${k}. כדאי לבדוק מול האריזה.`;
  };
  const fill = v => {
    for (const k of ['name', 'brand', 'barcode', 'kcal', 'p', 'c', 'f', 'fib']) if (v[k] != null && v[k] !== '') el[k].value = v[k];
    (v.units || []).slice(0, 2).forEach(([n, g], i) => { el['u' + (i + 1)].value = n; el[`u${i + 1}g`].value = g; });
    check();
  };
  fill(init);
  form.oninput = check;
  $('#ffscan').onclick = async () => {
    const v = await readLabel();
    if (!v) return;
    fill({ ...v, name: el.name.value || v.name, units: labelUnits(v) });
    toast('✓ נקרא מהתווית – בדוק שהמספרים תואמים');
  };
  form.onsubmit = ev => {
    ev.preventDefault();
    const n = k => r1(+el[k].value || 0);
    const units = [1, 2].map(i => [el['u' + i].value.trim(), +el[`u${i}g`].value]).filter(([nm, g]) => nm && g > 0);
    const barcode = el.barcode.value.trim();
    const food = {
      id: init.id || (barcode ? 'b:' + barcode : 'u:' + uid()),
      name: el.name.value.trim(), brand: el.brand.value.trim(), barcode,
      kcal: n('kcal'), p: n('p'), c: n('c'), f: n('f'), fib: n('fib'), units, ok: 1,
    };
    S.foods[food.id] = food;
    save();
    onFood(food);
  };
  if ($('#ffdel')) $('#ffdel').onclick = () => { delete S.foods[init.id]; delete S.favs[init.id]; save(); closeSheet(); toast('המוצר נמחק'); };
}
const labelUnits = v => [v.servingG > 0 && ['מנה', v.servingG], v.packageG > 0 && ['אריזה', v.packageG]].filter(Boolean);

// ---------- recipes ("my meals") ----------
let draft;
const recipeTotals = items => items.reduce((t, it) => {
  for (const k of ['kcal', 'p', 'c', 'f', 'fib']) t[k] += (it[k] || 0) * it.g / 100;
  return t;
}, { kcal: 0, p: 0, c: 0, f: 0, fib: 0 });

function openRecipe(meal) {
  draft = meal ? { id: meal.id, name: meal.name, servings: meal.servings, items: meal.items.map(i => ({ ...i })) }
    : draft && !draft.id && draft.items.length ? draft // unsaved meal survives a cancelled scan / closed sheet
    : { name: '', servings: 1, items: [] };
  drawRecipe();
}
function drawRecipe() {
  sheet(`
    <h2>${draft.id ? 'עריכת מנה' : 'מנה חדשה'}</h2>
    <p class="muted small">בונים פעם אחת ("שקשוקה ל-2", "הטוסט של הבוקר") – אחר כך מוסיפים בלחיצה.</p>
    <div class="grid2"><label>שם המנה<input id="rn" placeholder="שקשוקה"></label><label>כמה מנות יוצא?<input id="rs" type="number" min="0.5" step="0.5" inputmode="decimal"></label></div>
    <div class="list">${draft.items.map((it, i) => `<div class="row ing"><div class="row-main"><b>${esc(it.name)}</b></div>
      <input class="gin" data-i="${i}" type="number" inputmode="decimal" min="0" value="${it.g}" aria-label="גרם"><span class="muted">ג'</span>
      <button class="x" data-i="${i}" aria-label="הסר">✕</button></div>`).join('')}</div>
    <form id="rai" class="row2 rai"><input id="rait" autocomplete="off" enterkeyhint="send" placeholder="כתוב: 300ג' בשר טחון, 3 ביצים, בצל…" aria-label="רכיבים בטקסט חופשי">
      <button class="primary" id="raib">✨ חשב</button></form>
    <div class="row2"><button class="ghost" id="radd">🔍 חפש רכיב</button><button class="ghost" id="rscan">▥ סרוק ברקוד</button></div>
    <div class="sum" id="rsum"></div>
    <button class="primary wide" id="rsave">שמור מנה</button>
    ${draft.id ? '<button class="danger wide" id="rdel">מחק מנה</button>' : ''}`);
  const rn = $('#rn'), rs = $('#rs');
  rn.value = draft.name; rs.value = draft.servings;
  const sum = () => {
    const t = recipeTotals(draft.items), s = draft.servings || 1;
    $('#rsum').innerHTML = `למנה: <b>${r0(t.kcal / s)}</b> קל' · <b>${r0(t.p / s)}</b>ג' חלבון`;
  };
  rn.oninput = () => draft.name = rn.value;
  rs.oninput = () => { draft.servings = +rs.value || 1; sum(); };
  body.querySelectorAll('.gin').forEach(inp => inp.oninput = () => { draft.items[inp.dataset.i].g = +inp.value || 0; sum(); });
  body.querySelectorAll('.ing .x').forEach(b => b.onclick = () => { draft.items.splice(b.dataset.i, 1); drawRecipe(); });
  $('#radd').onclick = pickIngredient;
  $('#rscan').onclick = () => scan(f => addIngredient(f, f.units?.[0]?.[1] || 100));
  $('#rai').onsubmit = async ev => {
    ev.preventDefault();
    const text = $('#rait').value.trim();
    if (!text || needKey()) return;
    $('#raib').disabled = true; $('#raib').textContent = 'מחשב…';
    try {
      const v = await parseFoods(text, 'RECIPE MODE: Ido is building a home recipe. Every food in his message is an ingredient: always put it in items, whatever the tense. Weights are as he measured them (raw unless he says cooked).');
      const rs = (v.items || []).map(resolveItem).filter(Boolean);
      for (const r of rs) addIngredient(r.food, r.qty * unitGrams(r.food, r.unit), true);
      drawRecipe();
      toast(rs.length ? `✓ נוספו ${rs.length} רכיבים. ${v.reply}` : v.reply, 6000);
    } catch (e) {
      toast('לא הצלחתי לחשב: ' + e.message, 5000);
      if ($('#raib')) { $('#raib').disabled = false; $('#raib').textContent = '✨ חשב'; }
    }
  };
  $('#rsave').onclick = () => {
    const totalG = draft.items.reduce((a, it) => a + it.g, 0);
    if (!draft.name.trim() || !draft.items.length || totalG <= 0) return toast('צריך שם ולפחות רכיב אחד');
    const t = recipeTotals(draft.items), per = x => r1(x / totalG * 100);
    const meal = {
      id: draft.id || 'm:' + uid(), kind: 'meal', name: draft.name.trim(), brand: 'מנה שלי',
      servings: draft.servings || 1, items: draft.items,
      kcal: per(t.kcal), p: per(t.p), c: per(t.c), f: per(t.f), fib: per(t.fib),
      units: [['מנה', r1(totalG / (draft.servings || 1))]],
    };
    S.foods[meal.id] = meal;
    save();
    draft = null;
    openFood(meal);
  };
  if (draft.id) $('#rdel').onclick = () => { delete S.foods[draft.id]; delete S.favs[draft.id]; save(); closeSheet(); toast('המנה נמחקה'); };
  sum();
}
function addIngredient(f, g, noDraw) {
  draft.items.push({ foodId: f.id, name: f.name, g: r1(g), kcal: f.kcal, p: f.p, c: f.c, f: f.f, fib: f.fib || 0 });
  if (!noDraw) drawRecipe();
}
function pickIngredient() {
  sheet(`<h2>הוסף רכיב</h2><input id="pq" type="search" placeholder="חפש…" autocomplete="off"><div id="pr" class="list"></div>
    <button class="ghost wide" id="pback">חזרה למנה</button>`);
  const pq = $('#pq'), pr = $('#pr');
  const draw = () => pr.innerHTML = searchFoods(pq.value).filter(f => f.kind !== 'meal').slice(0, 30)
    .map(f => `<div class="row" data-pick="${esc(f.id)}"><div class="row-main"><b>${esc(f.name)}</b><small>${r0(f.kcal)} קל' · ${r1(f.p)}ג' חלבון ל-100ג'</small></div></div>`).join('');
  pq.oninput = draw;
  pr.onclick = e => {
    const f = getFood(e.target.closest('[data-pick]')?.dataset.pick);
    if (f) addIngredient(f, f.units?.[0]?.[1] || 100);
  };
  $('#pback').onclick = drawRecipe;
  pq.focus();
}

// ---------- sport ----------
function openSport() {
  const day = viewDay;
  sheet(`
    <h2>⚡ ספורט – ${dayLabel(day)}</h2>
    <p class="muted small">3 אימוני הקליסתניקס כבר בתוך יעד הבסיס. כאן מוסיפים משחקים וספורט נוסף – ומקבלים עוד אוכל באותו יום.</p>
    <label>סוג<select id="ss">${SPORTS.map(([n], i) => `<option value="${i}">${n}</option>`).join('')}</select></label>
    <label>דקות פעילות (אפשר לקחת מה-Garmin)<input id="sm" type="number" inputmode="numeric" min="1" value="120"></label>
    <div class="sum" id="sb"></div>
    <button class="primary wide" id="sadd">הוסף</button>`);
  const ss = $('#ss'), sm = $('#sm');
  const calc = () => sportBonus(S.profile.weight, SPORTS[ss.value][1], +sm.value || 0);
  const upd = () => { const b = calc(); $('#sb').innerHTML = `שריפה מוערכת ~${r0(b / EAT_BACK)} · תוספת ליעד: <b>+${b}</b> קל' (בעיקר פחמימות)`; };
  ss.onchange = sm.oninput = upd;
  $('#sadd').onclick = () => {
    const b = calc();
    if (!(b > 0)) return toast('הכנס דקות');
    (S.sports[day] ||= []).push({ id: uid(), name: SPORTS[ss.value][0], met: SPORTS[ss.value][1], min: +sm.value, kcal: b });
    save(); closeSheet(); toast(`⚡ +${b} קל' ליעד היום – תאכל אותן!`);
  };
  upd();
}

// ---------- barcode + Open Food Facts ----------
function fromOFF(p, code) {
  const n = p.nutriments || {};
  const kcal = n['energy-kcal_100g'] ?? (n.energy_100g ? n.energy_100g / 4.184 : 0);
  const units = [];
  if (+p.serving_quantity > 0) units.push(['מנה', +p.serving_quantity]);
  if (+p.product_quantity > 0) units.push(['אריזה', +p.product_quantity]);
  code = code || p.code;
  return {
    id: 'b:' + code, barcode: code, name: p.product_name_he || p.product_name || 'מוצר ' + code,
    brand: (p.brands || '').split(',')[0].trim(),
    kcal: r0(kcal), p: r1(n.proteins_100g || 0), c: r1(n.carbohydrates_100g || 0), f: r1(n.fat_100g || 0), fib: r1(n.fiber_100g || 0), units,
  };
}

// Open Food Facts is crowd-sourced and often wrong for Israeli products (missing sizes, kJ typed as kcal),
// so a scan is never trusted blindly: it's shown in the form to check against the package, once.
const VERIFY = 'נמצא במאגר העולמי – שם יש הרבה טעויות במוצרים ישראליים. השווה לטבלה על האריזה (או צלם אותה) ובדוק את משקל הגביע/האריזה ביחידות. אחרי שמירה – נשמר לתמיד.';
async function lookupBarcode(code, onFood = openFood) {
  const local = allFoods().find(f => f.barcode === code);
  if (local) return local.ok ? onFood(local) : openFoodForm(local, VERIFY, onFood);
  toast('מחפש את המוצר…', 8000);
  let p = null;
  try {
    const r = await fetch(`${OFF}/api/v2/product/${encodeURIComponent(code)}.json?fields=${OFF_FIELDS}`);
    p = (await r.json()).product;
  } catch { toast('אין אינטרנט – אפשר להזין ידנית'); }
  const food = p && fromOFF(p, code);
  if (food && food.kcal > 0) {
    toast('');
    if (food.kcal <= 900 && food.p <= 100 && food.c <= 100 && food.f <= 100) return openFoodForm(food, VERIFY, onFood);
    for (const k of ['kcal', 'p', 'c', 'f', 'fib']) food[k] = '';
    return openFoodForm(food, 'נמצא במאגר העולמי, אבל הערכים שם שגויים. צלם את התווית או הקלד מהאריזה.', onFood);
  }
  toast('');
  openFoodForm(food || { barcode: code }, 'המוצר עוד לא במאגר. צלם את טבלת הערכים התזונתיים – והוא יישמר לתמיד.', onFood);
}

async function scan(onFood) {
  if (!('BarcodeDetector' in window)) {
    const code = prompt('סורק הברקוד לא נתמך בדפדפן הזה. הקלד את מספר הברקוד:');
    if (code?.trim()) lookupBarcode(code.trim(), onFood);
    return;
  }
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } }); }
  catch { return toast('אין גישה למצלמה – אשר הרשאה בהגדרות הדפדפן'); }
  const det = new BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e'] });
  sheet(`<div class="scanbox"><video id="sv" autoplay playsinline muted></video><div class="scanline"></div></div>
    <p class="muted center">כוון את הברקוד לתוך המסגרת</p>
    <div class="row2"><button class="ghost" id="smanual">הקלדה ידנית</button><button class="ghost" id="sclose">ביטול</button></div>`);
  const video = $('#sv');
  video.srcObject = stream;
  let done = false;
  const stop = () => { done = true; stream.getTracks().forEach(t => t.stop()); };
  dlg.addEventListener('close', stop, { once: true });
  $('#sclose').onclick = closeSheet;
  $('#smanual').onclick = () => { closeSheet(); const c = prompt('מספר הברקוד:'); if (c?.trim()) lookupBarcode(c.trim(), onFood); };
  while (!done) {
    await new Promise(r => setTimeout(r, 150));
    if (done || video.readyState < 2) continue;
    try {
      const [b] = await det.detect(video);
      if (b && !done) { navigator.vibrate?.(60); closeSheet(); lookupBarcode(b.rawValue, onFood); }
    } catch {}
  }
}

async function offSearch() {
  const q = query;
  $('#results').insertAdjacentHTML('beforeend', '<p class="empty">מחפש…</p>');
  try {
    const r = await fetch(`${OFF}/cgi/search.pl?search_terms=${encodeURIComponent(q)}&search_simple=1&json=1&page_size=24&fields=${OFF_FIELDS}`);
    const items = ((await r.json()).products || []).map(p => fromOFF(p)).filter(f => f.kcal > 0 && f.barcode);
    offResults = { q, items };
  } catch { offResults = { q, items: [] }; toast('המאגר העולמי לא זמין כרגע – סרוק ברקוד או נסה מאוחר יותר', 5000); }
  if (query === q && $('#results')) $('#results').innerHTML = resultsHtml();
}

// ---------- Gemini label reader ----------
const LABEL_PROMPT = `You are reading a photo of a packaged food's nutrition facts table, usually Israeli and in Hebrew
("סימון תזונתי" / "ערכים תזונתיים", columns "ל-100 גרם" or "ל-100 מ\"ל" and "למנה").
Copy the numbers EXACTLY as printed in the per-100 g (or per-100 ml) column.
- kcal: energy in kilocalories ("קלוריות" / "אנרגיה"), never kJ.
- p: protein ("חלבונים"). c: total carbohydrates ("פחמימות"). f: total fat ("שומנים"). fib: dietary fiber ("סיבים תזונתיים").
- If only a per-serving column is printed, convert to per 100 g using the printed serving size.
- Never estimate a number that is not printed: use 0 for anything missing.
- servingG: printed serving size in grams, else 0. packageG: net weight of the package in grams if visible, else 0.
- name: product name as printed (Hebrew), else "".
- readable: false if the nutrition table is missing, cut off, blurry or you are not sure of the digits.`;

async function gemini(req) {
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': S.settings.geminiKey }, body: JSON.stringify(req),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error?.message || r.status);
  return JSON.parse(j.candidates[0].content.parts.find(p => p.text && !p.thought).text);
}

function pickImage(maxSide, quality, camera) {
  return new Promise(res => {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = 'image/*';
    if (camera) inp.capture = 'environment';
    inp.onchange = async () => {
      const file = inp.files[0];
      if (!file) return res(null);
      const bmp = await createImageBitmap(file);
      const s = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
      const cv = document.createElement('canvas');
      cv.width = r0(bmp.width * s); cv.height = r0(bmp.height * s);
      cv.getContext('2d').drawImage(bmp, 0, 0, cv.width, cv.height);
      res(cv.toDataURL('image/jpeg', quality));
    };
    inp.click();
  });
}

async function readLabel() {
  const key = S.settings.geminiKey;
  if (!key) { toast('צריך מפתח Gemini – לשונית "תוכנית" ← הגדרות', 5000); return null; }
  const img = await pickImage(1600, 0.85, true);
  if (!img) return null;
  toast('קורא את התווית…', 20000);
  const num = { type: 'NUMBER' };
  const req = {
    contents: [{ parts: [{ text: LABEL_PROMPT }, { inline_data: { mime_type: 'image/jpeg', data: img.split(',')[1] } }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: { readable: { type: 'BOOLEAN' }, name: { type: 'STRING' }, kcal: num, p: num, c: num, f: num, fib: num, servingG: num, packageG: num },
        required: ['readable', 'kcal', 'p', 'c', 'f'],
      },
    },
  };
  try {
    const v = await gemini(req);
    if (!v.readable) { toast('התווית לא ברורה – צלם שוב, קרוב ובאור טוב', 5000); return null; }
    toast('');
    return v;
  } catch (e) {
    toast('שגיאה בקריאת התווית: ' + e.message, 6000);
    return null;
  }
}

// ---------- chat logging ----------
// Gemini only parses the text and picks database ids + grams; calories are computed here from the
// database, so a weighed "200 g chicken" uses real per-100 g values instead of a model guess.
const CHAT_PROMPT = `You are the food-logging assistant inside "חיטוב", a Hebrew calorie tracker used by Ido, a 16-year-old athlete
on a slow cut (lose fat, keep and build muscle). Reply in short, warm, natural Hebrew (1–2 sentences). Never shame, never push
eating below his targets.
When Ido says he ate, is eating or drank something, add one entry per food to items:
- Match each food to the FOOD DATABASE below and copy its id exactly. If he says raw (נא / לפני בישול) use the raw item; if he
  doesn't say for meat, fish, rice or pasta, assume the weight is cooked and say so in the reply.
- If he gives a count of a unit listed for that food (e.g. "2 ביצים", "פיתה"), set unit to that exact unit name and qty to the count.
  Otherwise unit = "" and qty = grams.
- grams: total grams eaten. Convert counts with the listed unit grams; if no amount was given, use a typical Israeli portion
  and say which portion you assumed.
- Only if nothing in the database fits: id = "" and give kcal, p, c, f per 100 g from standard nutrition tables (USDA / Israeli
  Ministry of Health), using the closest generic food. Never invent label numbers for a brand you don't know.
- slot: b breakfast, l lunch, d dinner, s snack, or none if he didn't say.
Questions ("כמה חלבון ב…", "מה לאכול עכשיו?") or food he only plans to eat: items = [] and just answer, using the database values
and today's numbers. Advice follows his plan: protein first (30–40 g per meal), carbs around training, never below the targets.
When you log food, don't list per-item numbers (the app shows them); mention only assumptions you made.`;

const CHAT_SCHEMA = (() => {
  const s = { type: 'STRING' }, n = { type: 'NUMBER' };
  return {
    type: 'OBJECT',
    properties: {
      reply: s, slot: { type: 'STRING', enum: ['b', 'l', 'd', 's', 'none'] },
      items: { type: 'ARRAY', items: { type: 'OBJECT', properties: { id: s, name: s, qty: n, unit: s, grams: n, kcal: n, p: n, c: n, f: n }, required: ['id', 'name', 'qty', 'grams'] } },
    },
    required: ['reply', 'items'],
  };
})();
const foodLine = f => `${f.id}|${f.name}${f.brand ? ` (${f.brand})` : ''}|${r0(f.kcal)}/${r1(f.p)}/${r1(f.c)}/${r1(f.f)}|${(f.units || []).map(u => `${u[0]}=${r0(u[1])}`).join(',')}`;

// Gemini item → DB food (or a "≈" per-100 g estimate) + portion; null if the numbers are implausible.
function resolveItem(it) {
  const food = it.id && getFood(it.id);
  if (food) {
    if (it.unit && it.qty > 0 && (food.units || []).some(u => u[0] === it.unit)) return { food, qty: it.qty, unit: it.unit };
    return it.grams > 0 && it.grams < 3000 ? { food, qty: it.grams, unit: null } : null;
  }
  if (!(it.grams > 0 && it.grams < 3000 && it.kcal >= 0 && it.kcal <= 900 && it.name)) return null;
  return { food: { id: 'est:' + it.name, name: '≈ ' + it.name, kcal: it.kcal, p: it.p || 0, c: it.c || 0, f: it.f || 0 }, qty: it.grams, unit: null };
}

const needKey = () => !S.settings.geminiKey && (toast('צריך מפתח Gemini – לשונית "תוכנית" ← הגדרות', 5000), true);
function parseFoods(text, context, history = [], img) {
  return gemini({
    systemInstruction: { parts: [{ text: `${CHAT_PROMPT}
${context}
FOOD DATABASE (id|name|kcal/protein/carbs/fat per 100 g|units name=grams):
${allFoods().map(foodLine).join('\n')}` }] },
    contents: [...history.map(m => ({ role: m.role === 'me' ? 'user' : 'model', parts: [{ text: m.text }] })), { role: 'user', parts: [{ text }, ...(img ? [{ inline_data: { mime_type: 'image/jpeg', data: img.split(',')[1] } }] : [])] }],
    generationConfig: { responseMimeType: 'application/json', responseSchema: CHAT_SCHEMA },
  });
}

// Photo estimate: the description says WHAT it is (photos can't show oil, sauce or fillings), the photo
// gives the portion. Portions from photos are the weak spot, so grams are reviewed before logging.
const PHOTO_CTX = `PHOTO MODE: the photo shows a meal Ido ate or is about to eat; his message is his description of it.
Trust the description over the photo for what the foods are, how they were cooked and any amounts he states.
Put every food in the meal in items (including oil, sauces and drinks he mentions). Estimate grams from visual cues
(a dinner plate is ~26 cm, a fork ~19 cm, a pita ~16 cm) and the cooked state you see.
If the photo shows no food or is too unclear, items = [] and say so. Nothing is logged yet (he confirms the grams next), so don't
say you logged it; in the reply, name the portions you were least sure of.`;

async function photoChat() {
  if (chatBusy || needKey()) return;
  const desc = $('#ci').value.trim();
  const img = await pickImage(1024, 0.8, false);
  if (!img) return;
  S.chat.push({ role: 'me', text: '📷 ' + (desc || 'תמונה של ארוחה') });
  chatBusy = true; render();
  try {
    const v = await parseFoods(desc || '(no description)', PHOTO_CTX, [], img);
    const m = { role: 'ai', text: v.reply, day: todayKey(), ids: [] };
    S.chat.push(m);
    const rs = (v.items || []).map(resolveItem).filter(Boolean);
    if (rs.length) reviewPhoto(rs, SLOTS.some(s => s[0] === v.slot) ? v.slot : slotNow(), m);
  } catch (e) {
    S.chat.push({ role: 'ai', text: 'לא הצלחתי לחשב: ' + e.message, err: 1 });
  }
  S.chat = S.chat.slice(-40);
  chatBusy = false; save(); render();
}

function reviewPhoto(rs, slot, m) {
  const items = rs.map(r => ({ food: r.food, g: r1(r.qty * unitGrams(r.food, r.unit)) }));
  const draw = () => {
    sheet(`<h2>📷 הערכה מהתמונה</h2>
      <p class="warn">כמויות מתמונה יכולות לטעות ב-20–30%. אם שקלת או יודע – תקן את הגרמים.</p>
      <div class="list">${items.map((it, i) => `<div class="row ing"><div class="row-main"><b>${esc(it.food.name)}</b><small class="pk" data-i="${i}"></small></div>
        <input class="gin" data-i="${i}" type="number" inputmode="decimal" min="0" value="${it.g}" aria-label="גרם"><span class="muted">ג'</span>
        <button class="x" data-i="${i}" aria-label="הסר">✕</button></div>`).join('')}</div>
      <div class="sum" id="psum"></div>
      <button class="primary wide" id="padd">הוסף ליומן</button>`);
    sum();
    body.querySelectorAll('.gin').forEach(inp => inp.oninput = () => { items[inp.dataset.i].g = +inp.value || 0; sum(); });
    body.querySelectorAll('.ing .x').forEach(b => b.onclick = () => { items.splice(b.dataset.i, 1); draw(); });
    $('#padd').onclick = () => {
      const entries = items.filter(it => it.g > 0).map(it => makeEntry(it.food, it.g, null, slot));
      if (!entries.length) return closeSheet();
      addEntries(m.day, entries);
      m.ids = entries.map(e => e.id);
      closeSheet();
    };
  };
  const sum = () => {
    const es = items.map(it => makeEntry(it.food, it.g, null, slot));
    body.querySelectorAll('.pk').forEach(el => el.textContent = `${es[el.dataset.i].kcal} קל' · ${r0(es[el.dataset.i].p)}ג' חלבון`);
    $('#psum').innerHTML = `סה"כ: <b>${es.reduce((a, e) => a + e.kcal, 0)}</b> קל' · <b>${r0(es.reduce((a, e) => a + e.p, 0))}</b>ג' חלבון`;
  };
  draw();
}

async function sendChat() {
  const inp = $('#ci'), text = inp.value.trim();
  if (!text || chatBusy || needKey()) return;
  const day = todayKey(), t = totals(day), tg = targetOf(day);
  const history = S.chat.filter(m => !m.err).slice(-6);
  while (history[0]?.role === 'ai') history.shift();
  S.chat.push({ role: 'me', text });
  chatBusy = true; render();
  try {
    const v = await parseFoods(text, `Today so far: ${r0(t.kcal)} kcal, protein ${r0(t.p)} g, carbs ${r0(t.c)} g, fat ${r0(t.f)} g.
Today's targets: ${tg.kcal} kcal, protein ${tg.p} g, carbs ${tg.c} g, fat ${tg.f} g.`, history);
    const slot = SLOTS.some(s => s[0] === v.slot) ? v.slot : slotNow();
    const entries = (v.items || []).map(resolveItem).filter(Boolean).map(r => makeEntry(r.food, r.qty, r.unit, slot));
    if (entries.length) addEntries(day, entries);
    S.chat.push({ role: 'ai', text: v.reply, day, ids: entries.map(e => e.id) });
  } catch (e) {
    S.chat.push({ role: 'ai', text: 'לא הצלחתי לחשב: ' + e.message, err: 1 });
  }
  S.chat = S.chat.slice(-40);
  chatBusy = false; save(); render();
}

function viewChat() {
  const msgs = S.chat.map((m, i) => {
    if (m.role === 'me') return `<div class="msg me">${esc(m.text)}</div>`;
    const items = (m.ids || []).map(id => (S.log[m.day] || []).find(e => e.id === id)).filter(Boolean);
    const sum = items.reduce((a, e) => ({ k: a.k + e.kcal, p: a.p + e.p }), { k: 0, p: 0 });
    return `<div class="msg ai ${m.err ? 'err' : ''}">${esc(m.text)}
      ${items.length ? `<ul>${items.map(e => `<li><span>${esc(e.name)} · ${esc(qtyLabel(e))}</span><span>${e.kcal} · ${r0(e.p)}ג' ח'</span></li>`).join('')}</ul>
        <div class="msg-foot"><b>נוסף: ${r0(sum.k)} קל' · ${r0(sum.p)}ג' חלבון</b><button class="chip" data-act="chatUndo" data-i="${i}">↩ בטל</button></div>` : ''}
      ${m.undone ? '<small class="muted">בוטל</small>' : ''}</div>`;
  }).join('');
  const ex = ['אכלתי 200 גרם חזה עוף מבושל וכוס אורז', '2 ביצים, פרוסת לחם מלא וגביע קוטג\' 5%', 'כמה חלבון נשאר לי היום?'];
  const t = totals(todayKey()), tg = targetOf(todayKey());
  return `
  <header class="top"><div><div class="eyebrow">צ'אט · נשארו ${r0(tg.kcal - t.kcal).toLocaleString()} קל' · ${r0(Math.max(0, tg.p - t.p))}ג' חלבון</div><h1>ספר לי מה אכלת</h1></div></header>
  <div class="chat">${msgs || `<p class="muted small">כתוב כמו להודעה: מה אכלת וכמה (גרמים מהמשקל, או "2 ביצים"). אני מחשב לפי המאגר ומוסיף ליומן של היום.</p>
    <p class="muted small">📷 צלחת בלי משקל? כתוב מה יש בה ("שניצל, פירה, סלט עם כף שמן") ולחץ על המצלמה – אני מעריך כמויות ואתה מאשר.</p>
    ${ex.map(x => `<button class="chip" data-act="chatEx">${esc(x)}</button>`).join('')}`}
    ${chatBusy ? '<div class="msg ai typing">מחשב…</div>' : ''}</div>
  <form id="cf" class="chat-form"><input id="ci" autocomplete="off" enterkeyhint="send" placeholder="למשל: 250 גרם אנטריקוט צלוי" aria-label="הודעה">
    <button type="button" class="ghost" data-act="chatPhoto" aria-label="צלם ארוחה להערכה" ${chatBusy ? 'disabled' : ''}>📷</button>
    <button class="primary" aria-label="שלח" ${chatBusy ? 'disabled' : ''}>➤</button></form>`;
}

// ---------- toast + celebrate ----------
let toastT;
function toast(msg, ms = 2500, undo) {
  const el = $('#toast');
  (dlg.open ? dlg : document.body).appendChild(el); // modal dialog sits in the top layer
  clearTimeout(toastT);
  if (!msg) return el.classList.remove('show');
  el.innerHTML = `<span>${esc(msg)}</span>${undo ? '<button>ביטול</button>' : ''}`;
  if (undo) el.querySelector('button').onclick = () => { undo(); el.classList.remove('show'); };
  el.classList.add('show');
  toastT = setTimeout(() => el.classList.remove('show'), ms);
}
function celebrate(msg) {
  toast(msg, 4000);
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const colors = ['#c6ff3d', '#ff6b2c', '#4cc3ff', '#ffc83d'];
  for (let i = 0; i < 40; i++) {
    const s = document.createElement('i');
    s.className = 'confetti';
    s.style.cssText = `left:${Math.random() * 100}vw;background:${colors[i % 4]};animation-delay:${Math.random() * 0.3}s;--dx:${(Math.random() - 0.5) * 200}px`;
    document.body.appendChild(s);
    setTimeout(() => s.remove(), 1800);
  }
}

// ---------- actions ----------
const ACT = {
  tab: el => { tab = el.dataset.tab; if (tab !== 'add') { query = ''; offResults = null; } render(); scrollTo(0, 0); },
  day: el => { viewDay = addDays(viewDay, +el.dataset.n); if (viewDay > todayKey()) viewDay = todayKey(); render(); },
  slot: el => { addSlot = el.dataset.k; render(); },
  addTo: el => { addSlot = el.dataset.k; tab = 'add'; render(); scrollTo(0, 0); },
  food: el => openFood(getFood(el.dataset.id)),
  quick: el => quickAdd(getFood(el.dataset.id)),
  entry: el => {
    const e = (S.log[viewDay] || []).find(x => x.id === el.dataset.id);
    if (e) openFood(getFood(e.foodId) || foodFromEntry(e), e);
  },
  copy: el => {
    const src = (S.log[addDays(viewDay, -1)] || []).filter(e => e.slot === el.dataset.k);
    addEntries(viewDay, src.map(e => ({ ...e, id: uid() })));
    toast(`הועתקו ${src.length} פריטים`);
    render();
  },
  scan: () => scan(),
  label: async () => { const v = await readLabel(); if (v) openFoodForm({ ...v, units: labelUnits(v) }, 'נקרא מהתווית – בדוק שהמספרים תואמים לאריזה'); },
  newMeal: () => openRecipe(),
  newFood: () => openFoodForm({ name: query.trim() }),
  offSearch,
  chatPhoto: () => photoChat(),
  chatEx: el => { $('#ci').value = el.textContent; $('#ci').focus(); },
  chatUndo: el => {
    const m = S.chat[+el.dataset.i];
    S.log[m.day] = (S.log[m.day] || []).filter(e => !m.ids.includes(e.id));
    m.ids = []; m.undone = 1;
    save(); render();
  },
  sport: openSport,
  delSport: el => { S.sports[viewDay] = (S.sports[viewDay] || []).filter(s => s.id !== el.dataset.id); save(); render(); },
  saveWeight: () => {
    const w = +$('#wIn').value;
    if (!(w > 30 && w < 250)) return toast('משקל לא תקין');
    S.weights[todayKey()] = r1(w);
    save(); render(); toast('✓ נשמר. רק הממוצע השבועי קובע');
  },
  addPhoto: async () => {
    const data = await pickImage(600, 0.7, false);
    if (!data) return;
    const photos = loadPhotos();
    photos.push({ date: todayKey(), data });
    try { localStorage.setItem(PHOTOS, JSON.stringify(photos)); render(); }
    catch { toast('אין מקום – מחק תמונות ישנות', 5000); }
  },
  delPhoto: el => {
    if (!confirm('למחוק את התמונה?')) return;
    const photos = loadPhotos();
    photos.splice(+el.dataset.i, 1);
    localStorage.setItem(PHOTOS, JSON.stringify(photos));
    render();
  },
  applyCheckin: () => {
    const c = checkin();
    if (!c.ready) return;
    S.profile.weight = r1(trendAt(todayKey()) || S.profile.weight);
    S.targets = { ...S.targets, ...macros(c.kcal, S.profile.weight) };
    S.lastCheckin = todayKey();
    S.goal = { ...S.goal, fromKg: S.profile.weight, from: todayKey() };
    save(); render(); toast(`✓ יעד חדש: ${c.kcal.toLocaleString()} קל'`);
  },
  saveProfile: () => {
    const v = id => +$(id).value;
    if (!(v('#pw') > 30 && v('#ph') > 100 && v('#pa') > 10 && v('#pg') > 40)) return toast('ערכים לא תקינים');
    Object.assign(S.profile, { weight: v('#pw'), height: v('#ph'), age: v('#pa'), activity: v('#pact') });
    S.goal.kg = v('#pg');
    S.targets = calcTargets(S.profile);
    save(); render(); toast(`✓ יעד: ${S.targets.kcal.toLocaleString()} קל' · ${S.targets.p}ג' חלבון`);
  },
  saveKey: () => { S.settings.geminiKey = $('#gk').value.trim(); save(); toast('✓ המפתח נשמר'); },
  exportData: () => {
    const blob = new Blob([JSON.stringify({ state: S, photos: loadPhotos() })], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `chitov-backup-${todayKey()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  },
  importData: () => {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = 'application/json,.json';
    inp.onchange = async () => {
      try {
        const data = JSON.parse(await inp.files[0].text());
        if (!data.state?.log) throw new Error();
        if (!confirm('לשחזר מהגיבוי? הנתונים הנוכחיים יוחלפו.')) return;
        localStorage.setItem(KEY, JSON.stringify(data.state));
        S = load();
        localStorage.setItem(PHOTOS, JSON.stringify(data.photos || []));
        render(); toast('✓ שוחזר');
      } catch { toast('קובץ גיבוי לא תקין'); }
    };
    inp.click();
  },
};

document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]');
  if (el && ACT[el.dataset.act]) { e.stopPropagation(); ACT[el.dataset.act](el, e); }
});
document.addEventListener('submit', e => {
  if (e.target.id === 'cf') { e.preventDefault(); sendChat(); }
});
document.addEventListener('input', e => {
  if (e.target.id !== 'q') return;
  query = e.target.value;
  $('#results').innerHTML = resultsHtml();
});

// One-time setup link (…/#key=XXX) stores the Gemini key on this phone only, then strips it from the URL.
const hashKey = new URLSearchParams(location.hash.slice(1)).get('key');
if (hashKey) {
  S.settings.geminiKey = hashKey.trim();
  save();
  history.replaceState(null, '', location.pathname);
}

render();
if (hashKey) toast('✓ מפתח Gemini נשמר בטלפון. עכשיו: ⋮ ← התקן אפליקציה', 6000);
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
