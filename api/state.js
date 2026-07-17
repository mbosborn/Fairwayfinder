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

// Common English first-name nickname groups — so "Matt Fitzpatrick" (e.g. from
// the screenshot-fill feature, which naturally writes names the way people
// actually say them) still matches "Matthew Fitzpatrick" (the fuller form
// live feeds tend to use), without requiring an exact spelling match.
const NICKNAME_GROUPS = [
  ['matt','matthew'], ['chris','christopher'], ['mike','michael','mick'],
  ['alex','alexander'], ['sam','samuel'], ['will','william','bill','billy'],
  ['nick','nicholas'], ['zach','zachary','zack'], ['ben','benjamin'],
  ['joe','joseph','joey'], ['tom','thomas','tommy'], ['dan','daniel','danny'],
  ['rob','robert','bob','bobby'], ['jon','jonathan','john','johnny'],
  ['cam','cameron'], ['tony','anthony'], ['ed','edward','eddie'],
  ['rick','richard','dick','ricky'], ['greg','gregory'], ['steve','steven','stephen'],
  ['dave','david','davey'], ['jim','james','jimmy'], ['charlie','charles','chuck'],
  ['andy','andrew'], ['pat','patrick'], ['ken','kenneth','kenny'],
  ['jeff','jeffrey'], ['brad','bradley'], ['josh','joshua'],
  ['tim','timothy'], ['ted','theodore','teddy'], ['harry','harold'],
];
const NICKNAME_MAP = (() => {
  const m = {};
  for (const g of NICKNAME_GROUPS) for (const w of g) m[w] = g;
  return m;
})();
function firstNameVariants(word) { return NICKNAME_MAP[word] || [word]; }
// Same shape as the front-end's nameKeys(): the plain normalized name, the
// comma-swapped ("Last, First" -> "First Last") form, and nickname variants
// of just the first word — tried in that order wherever a pick name needs to
// be matched against a live-feed key.
function nameKeys(name) {
  const n = norm(name); const keys = new Set([n]);
  if (n.includes(',')) {
    const [l, f] = n.split(',').map(s => s.trim());
    if (f && l) keys.add(norm(f + ' ' + l));
  }
  for (const k of [...keys]) {
    const parts = k.split(' ');
    if (parts.length >= 2) {
      for (const v of firstNameVariants(parts[0])) {
        if (v !== parts[0]) keys.add([v, ...parts.slice(1)].join(' '));
      }
    }
  }
  return [...keys];
}
// Resolve a raw pick name to whichever key actually exists in the live feeds
// (scores or probs), trying nickname/comma variants — falls back to the plain
// normalized name if nothing matches anywhere (e.g. a golfer not yet live).
function resolvePickKey(rawName, scores, probs) {
  for (const k of nameKeys(rawName)) {
    if ((scores && scores[k]) || (probs && probs[k])) return k;
  }
  return norm(rawName);
}

// ---- RapidAPI Live Golf Data — reintroduced, but ONLY for purse lookup ----
// Data Golf doesn't provide purse amounts, so this fills that one gap and
// nothing else. It's best-effort and non-blocking: any failure here just
// leaves the purse as whatever it already was (manually entered or last
// successfully fetched) — it can never break scores, breakfast odds, or the
// field list, since those are entirely Data Golf now.
//
// Crucially, this does NOT bring back date-window tournament matching (the
// source of the old "wrong tournament" bug). We already know the exact event
// name from Data Golf's live feed, so this just looks for a schedule entry
// whose NAME matches that — a much simpler and more robust lookup than
// guessing which of several same-week events is "the real one" from dates.
const RAPID_HOST = 'live-golf-data.p.rapidapi.com';

function normName(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g,'').replace(/\s+/g,' ').trim();
}
// Similarity score in [0,1]; 0 means "not a real match". Deliberately strict:
// a single shared generic word ("open", "championship", "classic") between two
// otherwise-different tournament names must NOT count as a match — that's
// exactly the kind of false positive that caused the original wrong-tournament
// bug, just relocated from date-matching into name-matching if left loose.
function nameSimilarity(a, b) {
  const na = normName(a), nb = normName(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) return 0.95;
  const wa = na.split(' ').filter(w => w.length > 2);
  const wb = nb.split(' ').filter(w => w.length > 2);
  if (!wa.length || !wb.length) return 0;
  const [shorter, longer] = wa.length <= wb.length ? [wa, wb] : [wb, wa];
  if (shorter.length < 2) return 0; // one shared word alone is never enough evidence
  const longerSet = new Set(longer);
  const overlap = shorter.filter(w => longerSet.has(w)).length;
  const minOverlapNeeded = Math.max(2, Math.ceil(shorter.length * 0.6));
  if (overlap < minOverlapNeeded) return 0;
  return overlap / shorter.length;
}
// Picks the single BEST-scoring schedule entry, not just the first one that
// clears some threshold — safer when several events share a word by chance.
function findBestScheduleMatch(events, eventName) {
  let best = null, bestScore = 0;
  for (const e of events) {
    const score = nameSimilarity(e.name, eventName);
    if (score > bestScore) { bestScore = score; best = e; }
  }
  return bestScore > 0 ? best : null;
}

// Returns { purse: number|null, matchedName: string|null, diag: string|null }
async function fetchPurseFromRapid(eventName) {
  const key = process.env.RAPIDAPI_KEY;
  if (!key) return { purse: null, matchedName: null, diag: null }; // not configured — silently skip
  if (!eventName) return { purse: null, matchedName: null, diag: null };
  try {
    const year = new Date().getFullYear();
    const res = await fetch(`https://${RAPID_HOST}/schedule?orgId=1&year=${year}`, {
      headers: { 'x-rapidapi-key': key, 'x-rapidapi-host': RAPID_HOST },
    });
    if (!res.ok) {
      const bodyText = await res.text().catch(() => '');
      return { purse: null, matchedName: null, diag: `RapidAPI purse lookup failed: HTTP ${res.status} ${bodyText.slice(0,150)}` };
    }
    const data = await res.json();
    const events = data?.schedule || [];
    const match = findBestScheduleMatch(events, eventName);
    if (!match) {
      return { purse: null, matchedName: null, diag: `No RapidAPI schedule entry matched "${eventName}" among ${events.length} events this year` };
    }
    const purse = Number(String(match.purse || '').replace(/[^0-9]/g,''));
    if (!purse) {
      return { purse: null, matchedName: match.name, diag: `Matched "${match.name}" but its purse field was empty/unparseable: ${JSON.stringify(match.purse)}` };
    }
    return { purse, matchedName: match.name, diag: null };
  } catch (e) {
    return { purse: null, matchedName: null, diag: 'RapidAPI purse lookup threw: ' + e.message };
  }
}

function parToInt(p) {
  if (p == null) return null;
  const s = String(p).trim().toUpperCase();
  if (s === 'E' || s === 'EVEN' || s === '') return 0;
  const n = parseInt(s.replace('+',''), 10);
  return isNaN(n) ? null : n;
}

// "Last, First" -> "First Last" (defensive; Data Golf's format can vary by feed)
function toFirstLast(name) {
  if (!name) return name;
  const s = String(name).trim();
  if (s.includes(',')) {
    const [last, first] = s.split(',').map(x => x.trim());
    if (first && last) return `${first} ${last}`;
  }
  return s;
}

// ---- Data Golf: current tournament field (who's actually playing) ----
// Used to power the pick dropdowns — only shows golfers in this week's field.
async function fetchFieldList() {
  const key = process.env.DATAGOLF_KEY;
  if (!key) return { names: [], error: 'DATAGOLF_KEY is not set on the server' };
  try {
    const url = `https://feeds.datagolf.com/field-updates?tour=pga&file_format=json&key=${key}`;
    const r = await fetch(url);
    if (!r.ok) {
      const bodyText = await r.text().catch(() => '');
      return { names: [], error: `Data Golf field request failed: HTTP ${r.status} ${bodyText.slice(0,150)}` };
    }
    const data = await r.json();
    const rows = data?.field || data?.players || [];
    if (!Array.isArray(rows) || !rows.length) {
      return { names: [], error: 'Data Golf returned no field data (event may not be set yet, or the response shape changed)' };
    }
    const names = rows
      .map(p => toFirstLast(p.player_name || p.name))
      .filter(Boolean);
    return { names: [...new Set(names)].sort((a, b) => a.localeCompare(b)), error: null };
  } catch (e) {
    return { names: [], error: 'Data Golf field request threw: ' + e.message };
  }
}

// ---- Data Golf: live finish-probability model + live leaderboard scores ----
// ONE call to Data Golf's in-play feed now powers both the breakfast simulation
// (win/top5/etc probabilities) AND the leaderboard (pos/score) — replacing the
// separate RapidAPI schedule+leaderboard pipeline entirely. This feed is
// inherently scoped to "this week's event," so there's no tournament-picking
// logic needed at all.
// Returns { live, players: {...}, scores: {normName:{pos,score}}, eventName, finalRound, diag }
async function fetchDataGolfLive() {
  const key = process.env.DATAGOLF_KEY;
  if (!key) return { live:false, players:{}, scores:{}, eventName:null, diag:'DATAGOLF_KEY is not set on the server' };
  const url = `https://feeds.datagolf.com/preds/in-play?tour=pga&dead_heat=no&odds_format=percent&file_format=json&key=${key}`;
  try {
    const r = await fetch(url);
    if (!r.ok) {
      const bodyText = await r.text().catch(() => '');
      return { live:false, players:{}, scores:{}, eventName:null, diag:`Data Golf in-play request failed: HTTP ${r.status} ${bodyText.slice(0,200)}` };
    }
    const data = await r.json();
    const rows = data?.data || data?.players || [];
    const eventName = data?.event_name || data?.info?.event_name || null;
    // The in-play feed only returns rows once the tournament is underway —
    // that's a real "not live yet" state, not an error.
    if (!Array.isArray(rows) || !rows.length) return { live:false, players:{}, scores:{}, eventName, diag:null };
    const num = v => {
      if (v == null) return undefined;
      let x = typeof v === 'string' ? parseFloat(String(v).replace('%','')) : v;
      if (isNaN(x)) return undefined;
      return x > 1 ? x/100 : x; // percent -> 0..1
    };
    const players = {};
    const scores = {};
    let maxRound = 4;
    for (const p of rows) {
      const nm = p.player_name || p.name;
      if (!nm) continue;
      const full = toFirstLast(nm);
      const key = norm(full);
      // "thru" = holes completed this round; round/round_completed vary by feed version
      const thru = p.thru != null ? p.thru : (p.holes_thru != null ? p.holes_thru : null);
      const rd = p.round != null ? Number(p.round) : null;
      if (rd != null && rd > maxRound) maxRound = rd;
      const rawPos = p.current_pos != null ? p.current_pos : (p.position != null ? p.position : null);
      players[key] = {
        win:num(p.win), top5:num(p.top_5), top10:num(p.top_10),
        top20:num(p.top_20), make_cut:num(p.make_cut),
        thru, round: rd,
        currentPos: rawPos,
      };
      // ---- leaderboard pos/score, self-contained (no separate feed needed) ----
      // Real tour payout rules, matched here:
      //  - CUT (missed the 36-hole cut): no money.
      //  - DQ (disqualified): no money, no exceptions.
      //  - WD (withdrew): no money if it happened before making the cut (same
      //    as CUT); but a withdrawal during round 3+ means they'd already made
      //    the cut, and real tours still pay that out — specifically last-place
      //    money, not their position at the moment they left. Round 3+ is a
      //    reliable signal since only cut-qualifiers get a round 3/4 tee time.
      const posStr = String(rawPos ?? '').toUpperCase();
      if (/DQ/.test(posStr)) {
        scores[key] = { pos: 'DQ', score: 'DQ', name: full };
      } else if (/WD/.test(posStr)) {
        const madeCutBeforeWD = rd != null && rd >= 3;
        scores[key] = madeCutBeforeWD ? { pos: 'WD_PAID', score: 'WD_PAID', name: full } : { pos: 'MC', score: 'MC', name: full };
      } else if (/CUT/.test(posStr)) {
        scores[key] = { pos: 'MC', score: 'MC', name: full };
      } else {
        const rawScore = p.current_score ?? p.score ?? p.total_to_par ?? p.total;
        scores[key] = { pos: rawPos != null ? String(rawPos) : '', score: parToInt(rawScore), makeCut: num(p.make_cut), name: full, thru, round: rd };
      }
    }
    // Diagnostic: if we got rows but couldn't extract a single usable score,
    // the field names guessed above (current_score/score/etc) are wrong for
    // this feed version — dump one raw row so the real shape is obvious
    // immediately instead of another guessing round.
    let diag = null;
    const anyScore = Object.values(scores).some(s => s.score !== null && s.score !== undefined);
    if (rows.length && !anyScore) {
      diag = `got ${rows.length} in-play rows but no parsable score field — raw sample row: ${JSON.stringify(rows[0]).slice(0,400)}`;
    }

    // ---- Projected cut line (the 2-3 most likely cut scores + probabilities) ----
    // Data Golf's website shows this, but it's NOT confirmed whether their
    // public /preds/in-play response exposes it the same way (vs. it being
    // something only computed for their site). Try several plausible field
    // names; if none match, surface the actual top-level keys so the next
    // refresh settles this for certain instead of guessing again.
    const cutCandidateFields = ['cut_lines','cutLines','cut_line','projected_cut','projected_cut_lines','cutline_probs','cut_probs'];
    let cutLine = null, cutLineDiag = null;
    let cutLineRaw = null;
    for (const f of cutCandidateFields) { if (data[f] != null) { cutLineRaw = data[f]; break; } }
    if (cutLineRaw != null) {
      // Shape is unknown until we actually see it — try common array-of-{score,prob} shapes.
      try {
        const arr = Array.isArray(cutLineRaw) ? cutLineRaw : Object.entries(cutLineRaw).map(([k,v]) => ({ score:k, prob:v }));
        cutLine = arr.map(x => ({
          score: x.score ?? x.cut_score ?? x.value ?? x[0],
          prob: (() => { const p = x.prob ?? x.probability ?? x.pct ?? x[1]; if (p == null) return null; const n = typeof p==='string' ? parseFloat(p.replace('%','')) : p; return isNaN(n) ? null : (n > 1 ? n/100 : n); })(),
        })).filter(x => x.score != null);
      } catch (e) {
        cutLineDiag = `found a cut-line field but couldn't parse its shape: ${JSON.stringify(cutLineRaw).slice(0,300)}`;
      }
    } else {
      cutLineDiag = `no projected-cut-line field found in the in-play response — top-level keys present: ${Object.keys(data).join(', ')}`;
    }

    return { live:true, players, scores, eventName, finalRound: maxRound, diag, cutLine, cutLineDiag };
  } catch (e) {
    return { live:false, players:{}, scores:{}, eventName:null, diag:'Data Golf in-play request threw: ' + e.message };
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

  // Resolve every pick name ONCE to whichever key actually exists in the live
  // feeds (handles nicknames like "Matt" vs "Matthew" the same way everywhere
  // below, instead of two separate spots each doing their own plain norm()).
  const keyFor = {}; // rawPickName -> resolved key
  owners.forEach(o => (o.picks||[]).forEach(g => { keyFor[g] = resolvePickKey(g, scores, probs); }));

  // Classify every unique golfer: frozen (known prize) vs live (simulate).
  const frozen = {};   // resolved key -> fixed prize (number)
  const samplers = {}; // resolved key -> sampler()
  const uniq = new Set(Object.values(keyFor));

  uniq.forEach(k => {
    const sc = scores ? scores[k] : null;
    if (sc && (sc.pos === 'MC' || sc.pos === 'DQ')) { frozen[k] = 0; return; } // missed cut or DQ -> $0, fixed
    if (sc && sc.pos === 'WD_PAID') { frozen[k] = prizeFn(9999); return; }     // withdrew after making cut -> approx last-place money, fixed
    if (eventFinal && sc && sc.pos) {                                          // event over -> real prize, fixed
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
    if (doneThisGolfer && sc && sc.pos) {
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
        const k = keyFor[g];
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

// Minimum time between REAL upstream Data Golf calls, enforced server-side and
// shared across every visitor. A client can poll as often as it wants (e.g.
// every 10s for a live-feeling leaderboard); this gate is what actually
// protects the Data Golf quota when multiple people have the page open at
// once, since it's checked against the one shared Supabase row, not per-client.
const MIN_REFRESH_INTERVAL_MS = 15000;

export default async function handler(req, res) {
  try {
    const wantRefresh = req.query.refresh === '1';

    // Always load current saved state
    let { data: state } = await supabase
      .from('pool_state').select('*').eq('id','main').single();

    let fieldErrorOut = null; // surfaced to the UI so field-fetch problems are self-diagnosing
    let scoresErrorOut = null; // surfaced to the UI so scores-fetch problems are self-diagnosing
    let purseErrorOut = null; // surfaced to the UI so purse-lookup problems are self-diagnosing
    let cutLineDiagOut = null; // surfaced so we can tell for certain whether Data Golf's API exposes a cut-line field

    const lastUpdatedMs = state?.updated_at ? new Date(state.updated_at).getTime() : 0;
    const ageMs = Date.now() - lastUpdatedMs;
    const dueForRealFetch = ageMs >= MIN_REFRESH_INTERVAL_MS;

    if (wantRefresh && dueForRealFetch) {
      // ---- 1) Live scores + breakfast odds — ONE Data Golf call, LIVE ONLY. ----
      // This feed is inherently scoped to "this week's event" (no schedule
      // lookup, no picking between overlapping tournaments — that whole class
      // of bug is gone by construction, not by patching).
      let scores = state?.scores || {};
      let purse = state?.purse || 22500000;
      let purseEventName = state?.purse_event_name || null;
      let purseFailedAt = state?.purse_lookup_failed_at ? new Date(state.purse_lookup_failed_at).getTime() : 0;
      let purseLastError = state?.purse_lookup_error || null;
      let eventName = state?.event_name;
      let breakfast = state?.breakfast || {};
      let cutLine = state?.cut_line || null;

      if (!process.env.DATAGOLF_KEY) {
        // no key configured — nothing to do, leave prior state as-is
      } else {
        try {
          const dg = await fetchDataGolfLive();
          if (dg.diag) {
            // Surface real problems (bad key, feed shape mismatch) without
            // blocking the rest of the refresh — field list still updates below.
            scoresErrorOut = dg.diag;
            res.setHeader('x-refresh-error', dg.diag);
          }
          if (dg.eventName) eventName = dg.eventName;
          if (dg.cutLine && dg.cutLine.length) cutLine = dg.cutLine;
          if (dg.cutLineDiag) cutLineDiagOut = dg.cutLineDiag;
          if (dg.live) {
            scores = dg.scores;
            // eventFinal isn't directly knowable from this feed (no explicit
            // "status" field); per-golfer freezing inside simulateBreakfast
            // already converges to the exact result as each golfer completes,
            // so we don't need a separate whole-event "final" flag here.
            breakfast = simulateBreakfast(state?.owners || [], dg, scores, prizeByPos(purse), false);
          }
          // if !dg.live: tournament hasn't started yet (or feed is momentarily
          // empty) — leave prior scores/breakfast as-is rather than blanking them.
        } catch (e) {
          scoresErrorOut = e.message;
          res.setHeader('x-refresh-error', e.message);
        }
      }

      // ---- 1b) Purse — RapidAPI, best-effort, ONLY when the event has changed. ----
      // Purses don't move mid-tournament, so there's no reason to hit RapidAPI
      // every refresh — only when this week's event differs from whichever
      // event we last successfully resolved a purse for. Any failure here just
      // leaves the existing purse (manually entered or previously fetched) —
      // never blocks scores/breakfast/field, which are all Data Golf already.
      //
      // Cooldown: if the last attempt failed (e.g. rate-limited), don't retry
      // on every single refresh — that just adds more load to an endpoint
      // that's already saying "slow down." Wait a few minutes between retries
      // instead, and keep surfacing the last known error in the meantime.
      const PURSE_RETRY_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes
      if (eventName && eventName !== purseEventName) {
        const cooldownActive = purseFailedAt && (Date.now() - purseFailedAt < PURSE_RETRY_COOLDOWN_MS);
        if (cooldownActive) {
          purseErrorOut = purseLastError; // keep showing the last known issue, but don't re-attempt yet
        } else {
          const pr = await fetchPurseFromRapid(eventName);
          if (pr.purse) {
            purse = pr.purse;
            purseEventName = eventName;
            purseFailedAt = 0;
            purseLastError = null;
          } else if (pr.diag) {
            purseErrorOut = pr.diag;
            purseFailedAt = Date.now();
            purseLastError = pr.diag;
            res.setHeader('x-purse-error', pr.diag);
          }
        }
      }

      // ---- 2) Tournament field — Data Golf. Fully independent; always attempted alongside. ----
      // Auto-updates for whichever event is live: majors, regular tour stops, all of it.
      let field = state?.field || [];
      try {
        const f = await fetchFieldList();
        if (f.names && f.names.length) field = f.names;
        if (f.error) fieldErrorOut = f.error;
      } catch (e) { fieldErrorOut = 'Unexpected error: ' + e.message; }
      if (fieldErrorOut) res.setHeader('x-field-error', fieldErrorOut);

      const patch = {
        event_name: eventName,
        purse,
        purse_event_name: purseEventName,
        purse_lookup_failed_at: purseFailedAt ? new Date(purseFailedAt).toISOString() : null,
        purse_lookup_error: purseLastError,
        scores,
        breakfast,
        field,
        cut_line: cutLine,
        updated_at: new Date().toISOString(),
      };
      const { error: writeError } = await supabase.from('pool_state').update(patch).eq('id','main');
      if (writeError) {
        // A failed write here is serious — it means NOTHING in this refresh
        // persisted (scores, breakfast, purse, all of it), even though the
        // response below will still show fresh data for this one request.
        // Surface it loudly instead of silently continuing as if it worked.
        const msg = `Database write failed — this refresh did NOT save: ${writeError.message}`;
        scoresErrorOut = scoresErrorOut ? `${scoresErrorOut} | ${msg}` : msg;
        res.setHeader('x-write-error', writeError.message);
      }
      state = { ...state, ...patch };
    }
    // else: either not asking to refresh, or a real fetch happened elsewhere
    // within the last MIN_REFRESH_INTERVAL_MS — just serve the current shared
    // state, no upstream call at all. Cheap, and keeps polling clients in sync
    // with each other and with whatever the last real fetch produced.

    res.setHeader('Cache-Control','no-store');
    return res.status(200).json({ ...(state||{}), _fieldError: fieldErrorOut, _scoresError: scoresErrorOut, _purseError: purseErrorOut, _cutLineDiag: cutLineDiagOut });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
