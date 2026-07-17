// ============================================================
// /api/save  — saves owners/teams + event name.
//
// BETA: open to everyone with the link — no admin password required.
// (Revisit before a public/wide launch — add auth back if needed.)
//
// PURSE IS DELIBERATELY NOT ACCEPTED HERE. It's real money math — it should
// be exactly as editable as a golfer's score or finishing position, which is
// to say: not by anyone through this app. It's only ever set by the server's
// own automated purse lookup in /api/state.js. Even if a request sends a
// purse field, it's silently ignored below rather than trusted.
//
// POST /api/save   body: { owners?, event_name? }
// ============================================================

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { owners, event_name } = body || {}; // note: no `purse` — see comment above

    const patch = { updated_at: new Date().toISOString() };
    if (owners !== undefined)      patch.owners = owners;
    if (event_name !== undefined)  patch.event_name = event_name;

    const { error } = await supabase
      .from('pool_state').update(patch).eq('id','main');
    if (error) throw error;

    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
