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
            const patch = {
              event_name: ev.name || state?.event_name,
              event_id:  String(eventId),
              purse: Number(String(ev.purse||'').replace(/[^0-9]/g,'')) || state?.purse || 22500000,
              scores,
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
