// ============================================================
// /api/state  — read the shared pool, and (optionally) refresh
// live scores from the golf data feed before returning.
//
// GET  /api/state            -> current pool state
// GET  /api/state?refresh=1  -> pull live leaderboard first, then return
// ============================================================

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY      // service key: server-side only, never exposed
);

// ---- name normalization (must match the front-end) ----
function norm(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[åäâ]/g,'a').replace(/[éèê]/g,'e').replace(/[íì]/g,'i')
    .replace(/[óòö]/g,'o').replace(/[úü]/g,'u').replace(/ø/g,'o')
    .replace(/[^a-z ]/g,'').replace(/\s+/g,' ').trim();
}

// ---- Live Golf Data feed (RapidAPI) ----
// Docs: https://rapidapi.com/slashgolf/api/live-golf-data
// Free tier is plenty for one pool.
const RAPID_HOST = 'live-golf-data.p.rapidapi.com';

async function rapid(path) {
  const res = await fetch(`https://${RAPID_HOST}${path}`, {
    headers: {
      'x-rapidapi-key': process.env.RAPIDAPI_KEY,
      'x-rapidapi-host': RAPID_HOST,
    },
  });
  if (!res.ok) throw new Error(`feed ${res.status}`);
  return res.json();
}

// Find the current/most-recent event from the season schedule
async function currentEvent() {
  const year = new Date().getFullYear();
  const sched = await rapid(`/schedule?orgId=1&year=${year}`);
  const events = sched?.schedule || [];
  const now = Date.now();
  // pick the event whose window contains now, else the next upcoming, else the last
  let chosen = null, bestStart = -Infinity, upcoming = null, upStart = Infinity;
  for (const e of events) {
    const start = new Date(e.date?.start || e.startDate || 0).getTime();
    const end   = new Date(e.date?.end   || e.endDate   || start + 4*864e5).getTime();
    if (now >= start - 2*864e5 && now <= end + 1*864e5) { // in-window (with pad)
      if (start > bestStart) { bestStart = start; chosen = e; }
    }
    if (start > now && start < upStart) { upStart = start; upcoming = e; }
  }
  return chosen || upcoming || events[events.length-1] || null;
}

function parToInt(p) {
  if (p == null) return null;
  const s = String(p).trim().toUpperCase();
  if (s === 'E' || s === 'EVEN' || s === '') return 0;
  const n = parseInt(s.replace('+',''), 10);
  return isNaN(n) ? null : n;
}

// ---- Data Golf: live finish-probability model ----
// Returns { live: bool, players: { normName: {win,top5,top10,top20,make_cut, thru, finished} } }
// LIVE ONLY — uses the in-play model. No pre-tournament odds (we only care once play starts).
async function fetchDataGolfProbs() {
  const key = process.env.DATAGOLF_KEY;
  if (!key) return { live:false, players:{} };
  const url = `https://feeds.datagolf.com/preds/in-play?tour=pga&dead_heat=no&odds_format=percent&file_format=json&key=${key}`;
  try {
    const r = await fetch(url);
    if (!r.ok) return { live:false, players:{} };
    const data = await r.json();
    const rows = data?.data || data?.players || [];
    // The in-play feed only returns rows once the tournament is underway.
    if (!Array.isArray(rows) || !rows.length) return { live:false, players:{} };
    const num = v => {
      if (v == null) return undefined;
      let x = typeof v === 'string' ? parseFloat(String(v).replace('%','')) : v;
      if (isNaN(x)) return undefined;
      return x > 1 ? x/100 : x; // percent -> 0..1
    };
    const players = {};
    let maxRound = 4;
    for (const p of rows) {
      const nm = p.player_name || p.name;
      if (!nm) continue;
      // "thru" = holes completed this round; round/round_completed vary by feed version
      const thru = p.thru != null ? p.thru : (p.holes_thru != null ? p.holes_thru : null);
      const rd = p.round != null ? Number(p.round) : null;
      if (rd != null && rd > maxRound) maxRound = rd;
      players[norm(nm)] = {
        win:num(p.win), top5:num(p.top_5), top10:num(p.top_10),
        top20:num(p.top_20), make_cut:num(p.make_cut),
        thru, round: rd,
        currentPos: p.current_pos != null ? p.current_pos : (p.position != null ? p.position : null),
      };
    }
    return { live:true, players, finalRound: maxRound };
  } catch (e) {
    return { live:false, players:{} };
  }
}

// Build a finishing-position sampler for one golfer from their live probabilities.
function makeSampler(prob, fieldSize) {
  const win   = prob?.win   ?? 1/fieldSize;
  const top5  = prob?.top5  ?? Math.min(0.95, win*5);
  const top10 = prob?.top10 ?? Math.min(0.97, top5*1.8);
  const top20 = prob?.top20 ?? Math.min(0.98, top10*1.6);
  const cut   = prob?.make_cut ?? 0.5;
  return () => {
    if (Math.random() > cut) return 'CUT';
    const r = Math.random();
    if (r < win)   return 1;
    if (r < top5)  return 2 + Math.floor(Math.random()*4);
    if (r < top10) return 6 + Math.floor(Math.random()*5);
    if (r < top20) return 11 + Math.floor(Math.random()*10);
    return 21 + Math.floor(Math.random()*(fieldSize-21));
  };
}

// Is this golfer DONE for the tournament? (made cut decided + final round complete,
// or already cut/withdrawn). We freeze these at their real prize so they add certainty.
function golferFinished(scoreRow, dgRow) {
  if (scoreRow && scoreRow.pos === 'MC') return true;                 // missed cut = done, $0
  // Data Golf marks players done when win/top probs collapse to 0/1 and no holes remain.
  // Simplest robust signal: the live scores feed gives final position once the event ends.
  // During play we treat a golfer as "live" (simulate) unless the whole event is final.
  return false;
}

// Monte Carlo: probability each owner finishes LAST (lowest total prize money).
// KEY CORRECTNESS POINTS:
//  - Each unique golfer is simulated ONCE per run and that single outcome is applied to
//    every team that owns them — so shared golfers correlate teams correctly (your tie case).
//  - Golfers already finished (missed cut, or event final) are FROZEN at their real prize,
//    contributing certainty instead of noise.
//  - eventFinal=true means nothing left to simulate -> exact standings, 100%/0%.
function simulateBreakfast(owners, dg, scores, prizeFn, eventFinal, runs = 5000) {
  if (!owners || owners.length < 2) return {};
  const probs = (dg && dg.players) || {};
  const fieldSize = 75;

  // Classify every unique golfer: frozen (known prize) vs live (simulate).
  const frozen = {};   // normName -> fixed prize (number)
  const samplers = {}; // normName -> sampler()
  const uniq = new Set();
  owners.forEach(o => (o.picks||[]).forEach(g => uniq.add(norm(g))));

  uniq.forEach(k => {
    const sc = scores ? scores[k] : null;
    if (sc && sc.pos === 'MC') { frozen[k] = 0; return; }            // missed cut -> $0, fixed
    if (eventFinal && sc && sc.pos && sc.pos !== 'MC') {              // event over -> real prize, fixed
      frozen[k] = prizeFn(parseInt(String(sc.pos).replace(/[^0-9]/g,''),10));
      return;
    }
    // MID-EVENT: a golfer who has COMPLETED the final round is done — lock their prize now,
    // even though the tournament is still going. This is what makes the "9 done, 1 left,
    // shared last golfer" case resolve to a locked 0%/100% instead of being re-simulated.
    const dgRow = probs[k];
    const finalRound = (dg && dg.finalRound) || 4;
    const doneThisGolfer =
      dgRow && dgRow.round != null && dgRow.thru != null &&
      Number(dgRow.round) >= finalRound && Number(dgRow.thru) >= 18;
    if (doneThisGolfer && sc && sc.pos && sc.pos !== 'MC') {
      frozen[k] = prizeFn(parseInt(String(sc.pos).replace(/[^0-9]/g,''),10));
      return;
    }
    // still live -> simulate
    samplers[k] = makeSampler(probs[k] || null, fieldSize);
  });

  const lastCount = {}; owners.forEach(o => lastCount[o.id] = 0);

  for (let i = 0; i < runs; i++) {
    // 1) draw each LIVE golfer's outcome ONCE for this run
    const drawn = {};
    for (const k in samplers) {
      const pos = samplers[k]();
      drawn[k] = pos === 'CUT' ? 0 : prizeFn(pos);
    }
    // 2) total each team using frozen + the shared drawn results
    let worstId = null, worstTotal = Infinity;
    const tie = [];
    for (const o of owners) {
      let total = 0;
      for (const g of (o.picks||[])) {
        const k = norm(g);
        total += (k in frozen) ? frozen[k] : (drawn[k] || 0);
      }
      if (total < worstTotal - 0.0001) { worstTotal = total; worstId = o.id; tie.length = 0; tie.push(o.id); }
      else if (Math.abs(total - worstTotal) <= 0.0001) { tie.push(o.id); }
    }
    // 3) ties for last split the blame evenly (your "identical teams" case -> ~50/50)
    if (tie.length > 1) { tie.forEach(id => lastCount[id] += 1/tie.length); }
    else if (worstId != null) { lastCount[worstId] += 1; }
  }

  const out = {};
  owners.forEach(o => out[o.id] = Math.round(lastCount[o.id] / runs * 1000) / 10);
  return out;
}

// prize-by-position using the saved purse (mirrors the front-end percentages)
const PCT = {1:.18,2:.108,3:.068,4:.048,5:.04,6:.0362,7:.0337,8:.0312,9:.0292,10:.0272,
  11:.0252,12:.0232,13:.0215,14:.02,15:.0188,16:.0177,17:.0167,18:.0158,19:.015,20:.0143,
  21:.0136,22:.013,23:.0124,24:.0119,25:.0114,26:.011,27:.0106,28:.0102,29:.0098,30:.0095,
  35:.0079,40:.0064,45:.0052,50:.0042,55:.0038,60:.0035,65:.0032,70:.003};
function prizeByPos(purse) {
  const keys = Object.keys(PCT).map(Number).sort((a,b)=>a-b);
  return (pos) => {
    if (pos == null || pos === 'CUT') return 0;
    for (const k of keys) if (pos <= k) return Math.round((purse||22500000)*PCT[k]);
    return Math.round((purse||22500000)*0.0025);
  };
}

// Pull the leaderboard for an event and build {normName:{pos,score}}
async function fetchScores(eventId, year) {
  const lb = await rapid(`/leaderboard?orgId=1&tournId=${eventId}&year=${year}`);
  const rows = lb?.leaderboardRows || lb?.leaderboard || [];
  const scores = {};
  for (const r of rows) {
    const first = r.firstName || '';
    const last  = r.lastName  || '';
    const full  = (first && last) ? `${first} ${last}` : (r.playerName || r.name || '');
    if (!full) continue;
    const status = (r.status || '').toUpperCase();
    let pos = r.position || r.pos || '';
    let score;
    if (status === 'CUT' || status === 'MC' || /cut/i.test(pos)) {
      pos = 'MC'; score = 'MC';
    } else if (status === 'WD' || status === 'DQ') {
      pos = 'MC'; score = 'MC';
    } else {
      score = parToInt(r.total ?? r.totalToPar ?? r.score);
    }
    scores[norm(full)] = { pos: String(pos).replace('T','T'), score };
  }
  return scores;
}

const DAILY_LIMIT = 20;
// "today" in US Central time so the reset lines up with the golf day
function todayStr(){
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' }); // YYYY-MM-DD
}

export default async function handler(req, res) {
  try {
    const wantRefresh = req.query.refresh === '1';

    // Always load current saved state
    let { data: state } = await supabase
      .from('pool_state').select('*').eq('id','main').single();

    // ---- daily counter bookkeeping ----
    const today = todayStr();
    let used = state?.refresh_count || 0;
    if ((state?.refresh_day || '') !== today) { used = 0; } // new day -> reset
    let remaining = Math.max(0, DAILY_LIMIT - used);

    if (wantRefresh && process.env.RAPIDAPI_KEY) {
      if (remaining <= 0) {
        // out of pulls for today — return saved board, tell the page why
        res.setHeader('x-refresh-blocked', '1');
      } else {
        try {
          const year = new Date().getFullYear();
          const ev = await currentEvent();
          if (ev) {
            const eventId = ev.tournId || ev.id;
            const scores  = await fetchScores(eventId, year);
            used += 1;
            remaining = Math.max(0, DAILY_LIMIT - used);
            const purse = Number(String(ev.purse||'').replace(/[^0-9]/g,'')) || state?.purse || 22500000;

            // Breakfast watch — LIVE ONLY. Pulls Data Golf in-play probabilities.
            // Before anyone tees off, the in-play feed is empty -> we show nothing.
            let breakfast = state?.breakfast || {};
            try {
              const dg = await fetchDataGolfProbs();
              const eventFinal = (ev.status && /final|complete|official/i.test(String(ev.status))) ? true : false;
              if (dg.live || eventFinal) {
                breakfast = simulateBreakfast(state?.owners || [], dg, scores, prizeByPos(purse), eventFinal);
              } else {
                breakfast = {}; // not started yet -> no breakfast watch
              }
            } catch (e) { /* keep prior odds if the sim/feed fails */ }

            const patch = {
              event_name: ev.name || state?.event_name,
              event_id:  String(eventId),
              purse,
              scores,
              breakfast,
              refresh_count: used,
              refresh_day: today,
              updated_at: new Date().toISOString(),
            };
            await supabase.from('pool_state').update(patch).eq('id','main');
            state = { ...state, ...patch };
          }
        } catch (e) {
          res.setHeader('x-refresh-error', e.message);
        }
      }
    }

    // expose the counter to the page on every response
    res.setHeader('x-refresh-used', String(used));
    res.setHeader('x-refresh-limit', String(DAILY_LIMIT));
    res.setHeader('x-refresh-remaining', String(remaining));
    res.setHeader('Cache-Control','no-store');
    // also include in the body so realtime/initial load can read it
    return res.status(200).json({ ...(state||{}), _refreshUsed: used, _refreshLimit: DAILY_LIMIT, _refreshDay: today });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
