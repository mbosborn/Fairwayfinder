// ============================================================
// /api/verify — post-tournament cross-check against independent sources.
//
// IMPORTANT, PLEASE READ:
// This is a best-effort SECOND OPINION, not a guarantee. No automated system
// (this one included) can promise zero mistakes — sources can lag, have their
// own errors, or not cover a given event at all. Treat a "no mismatches found"
// result as strong reassurance, not as a substitute for glancing at the
// tournament's actual official leaderboard before real money changes hands,
// especially the first few times this runs against a real completed event.
//
// GET /api/verify  -> fetches official/independent final results and returns
//                     them next to our own current scores for comparison.
//                     The actual match/mismatch comparison happens in the
//                     browser (against the same tie-aware prize logic already
//                     shown on the board), so there's one source of truth for
//                     "our" calculation instead of two implementations that
//                     could quietly drift apart.
// ============================================================

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

function norm(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[åäâ]/g,'a').replace(/[éèê]/g,'e').replace(/[íì]/g,'i')
    .replace(/[óòö]/g,'o').replace(/[úü]/g,'u').replace(/ø/g,'o')
    .replace(/[^a-z ]/g,'').replace(/\s+/g,' ').trim();
}
function toFirstLast(name) {
  if (!name) return name;
  const s = String(name).trim();
  if (s.includes(',')) {
    const [last, first] = s.split(',').map(x => x.trim());
    if (first && last) return `${first} ${last}`;
  }
  return s;
}
function parToInt(p) {
  if (p == null) return null;
  const s = String(p).trim().toUpperCase();
  if (s === 'E' || s === 'EVEN' || s === '') return 0;
  const n = parseInt(s.replace('+',''), 10);
  return isNaN(n) ? null : n;
}
// Same strict name-matching as the purse lookup — deliberately requires
// real evidence (exact/substring match, or 2+ shared significant words),
// so two same-week events sharing one generic word never falsely match.
function normName(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g,'').replace(/\s+/g,' ').trim();
}
function nameSimilarity(a, b) {
  const na = normName(a), nb = normName(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) return 0.95;
  const wa = na.split(' ').filter(w => w.length > 2);
  const wb = nb.split(' ').filter(w => w.length > 2);
  if (!wa.length || !wb.length) return 0;
  const [shorter, longer] = wa.length <= wb.length ? [wa, wb] : [wb, wa];
  if (shorter.length < 2) return 0;
  const longerSet = new Set(longer);
  const overlap = shorter.filter(w => longerSet.has(w)).length;
  const minOverlapNeeded = Math.max(2, Math.ceil(shorter.length * 0.6));
  if (overlap < minOverlapNeeded) return 0;
  return overlap / shorter.length;
}
function findBest(events, eventName, nameField) {
  let best = null, bestScore = 0;
  for (const e of events) {
    const score = nameSimilarity(e[nameField], eventName);
    if (score > bestScore) { bestScore = score; best = e; }
  }
  return bestScore > 0 ? best : null;
}

// ---- Source 1: Data Golf's OFFICIAL historical event finishes/earnings ----
async function fetchOfficialEarnings(eventName) {
  const key = process.env.DATAGOLF_KEY;
  if (!key) return { rows: null, diag: 'DATAGOLF_KEY not set' };
  if (!eventName) return { rows: null, diag: 'no event name known yet' };
  try {
    const year = new Date().getFullYear();
    const listRes = await fetch(`https://feeds.datagolf.com/historical-event-data/event-list?tour=pga&file_format=json&key=${key}`);
    if (!listRes.ok) {
      const t = await listRes.text().catch(()=> '');
      return { rows: null, diag: `event-list request failed: HTTP ${listRes.status} ${t.slice(0,150)}` };
    }
    const listData = await listRes.json();
    const events = Array.isArray(listData) ? listData : (listData?.events || listData?.event_list || []);
    if (!events.length) return { rows: null, diag: `event-list returned no entries (raw shape: ${JSON.stringify(listData).slice(0,200)})` };
    // Try common field names for the event's display name.
    const nameField = events[0].event_name != null ? 'event_name' : (events[0].name != null ? 'name' : null);
    if (!nameField) return { rows: null, diag: `couldn't find a name field on event-list entries — raw sample: ${JSON.stringify(events[0]).slice(0,300)}` };
    const match = findBest(events, eventName, nameField);
    if (!match) return { rows: null, diag: `no event-list entry matched "${eventName}" among ${events.length} entries` };
    const eventId = match.event_id != null ? match.event_id : match.id;
    if (eventId == null) return { rows: null, diag: `matched "${match[nameField]}" but couldn't find its event_id — raw: ${JSON.stringify(match).slice(0,300)}` };

    const evRes = await fetch(`https://feeds.datagolf.com/historical-event-data/events?tour=pga&event_id=${eventId}&year=${year}&file_format=json&key=${key}`);
    if (!evRes.ok) {
      const t = await evRes.text().catch(()=> '');
      return { rows: null, diag: `events request failed for event_id=${eventId}, year=${year}: HTTP ${evRes.status} ${t.slice(0,150)}` };
    }
    const evData = await evRes.json();
    const rows = Array.isArray(evData) ? evData : (evData?.event || evData?.data || evData?.finishes || []);
    if (!rows.length) return { rows: null, diag: `matched event "${match[nameField]}" (id ${eventId}) but its finishes/earnings came back empty for year=${year} — may not be posted yet, or this endpoint may not cover majors` };

    // Field names guessed defensively — flagged via sample if none parse.
    const out = {};
    let anyParsed = false;
    for (const r of rows) {
      const nm = r.player_name || r.name;
      if (!nm) continue;
      const full = toFirstLast(nm);
      const pos = r.fin_text || r.finish || r.position || r.pos || null;
      const earnings = r.earnings != null ? Number(r.earnings) : (r.money != null ? Number(r.money) : null);
      if (pos != null || earnings != null) anyParsed = true;
      out[norm(full)] = { pos, earnings };
    }
    if (!anyParsed) {
      return { rows: null, diag: `got ${rows.length} rows for "${match[nameField]}" but no recognizable pos/earnings fields — raw sample row: ${JSON.stringify(rows[0]).slice(0,400)}` };
    }
    return { rows: out, matchedName: match[nameField], diag: null };
  } catch (e) {
    return { rows: null, diag: 'official earnings lookup threw: ' + e.message };
  }
}

// ---- Source 2: RapidAPI's final leaderboard (independent of Data Golf) ----
const RAPID_HOST = 'live-golf-data.p.rapidapi.com';
async function fetchRapidFinalPositions(eventName) {
  const key = process.env.RAPIDAPI_KEY;
  if (!key) return { rows: null, diag: 'RAPIDAPI_KEY not set' };
  if (!eventName) return { rows: null, diag: 'no event name known yet' };
  try {
    const year = new Date().getFullYear();
    const schedRes = await fetch(`https://${RAPID_HOST}/schedule?orgId=1&year=${year}`, {
      headers: { 'x-rapidapi-key': key, 'x-rapidapi-host': RAPID_HOST },
    });
    if (!schedRes.ok) {
      const t = await schedRes.text().catch(()=> '');
      return { rows: null, diag: `RapidAPI schedule request failed: HTTP ${schedRes.status} ${t.slice(0,150)}` };
    }
    const sched = await schedRes.json();
    const events = sched?.schedule || [];
    const match = findBest(events, eventName, 'name');
    if (!match) return { rows: null, diag: `no RapidAPI schedule entry matched "${eventName}" among ${events.length} events` };
    const tournId = match.tournId || match.id;

    const lbRes = await fetch(`https://${RAPID_HOST}/leaderboard?orgId=1&tournId=${tournId}&year=${year}`, {
      headers: { 'x-rapidapi-key': key, 'x-rapidapi-host': RAPID_HOST },
    });
    if (!lbRes.ok) {
      const t = await lbRes.text().catch(()=> '');
      return { rows: null, diag: `RapidAPI leaderboard request failed for tournId=${tournId}: HTTP ${lbRes.status} ${t.slice(0,150)}` };
    }
    const lb = await lbRes.json();
    const rows = lb?.leaderboardRows || lb?.leaderboard || [];
    if (!rows.length) return { rows: null, diag: `matched "${match.name}" (tournId ${tournId}) but its leaderboard came back empty` };

    const out = {};
    for (const r of rows) {
      const first = r.firstName || '';
      const last = r.lastName || '';
      const full = (first && last) ? `${first} ${last}` : (r.playerName || r.name || '');
      if (!full) continue;
      const status = (r.status || '').toUpperCase();
      let pos = r.position || r.pos || '';
      if (status === 'CUT' || status === 'MC' || /cut/i.test(pos)) pos = 'MC';
      else if (status === 'WD' || status === 'DQ') pos = status;
      out[norm(full)] = { pos: String(pos) };
    }
    return { rows: out, matchedName: match.name, diag: null };
  } catch (e) {
    return { rows: null, diag: 'RapidAPI final-leaderboard lookup threw: ' + e.message };
  }
}

export default async function handler(req, res) {
  try {
    const { data: state } = await supabase
      .from('pool_state').select('*').eq('id','main').single();
    const eventName = state?.event_name || null;

    const [official, rapidFinal] = await Promise.all([
      fetchOfficialEarnings(eventName),
      fetchRapidFinalPositions(eventName),
    ]);

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      event_name: eventName,
      our_scores: state?.scores || {},
      our_purse: state?.purse || null,
      official_rows: official.rows,
      official_matched_name: official.matchedName || null,
      official_diag: official.diag,
      rapid_rows: rapidFinal.rows,
      rapid_matched_name: rapidFinal.matchedName || null,
      rapid_diag: rapidFinal.diag,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
