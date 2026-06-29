// ============================================================
// /api/save  — admins (you + Brian) save owners/teams + event info.
// Protected by an admin password you set as an env var.
//
// POST /api/save   body: { adminKey, owners?, event_name?, purse? }
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
    const { adminKey, owners, event_name, purse } = body || {};

    // Gate: only the two admins know ADMIN_KEY
    if (!adminKey || adminKey !== process.env.ADMIN_KEY) {
      return res.status(401).json({ error: 'Wrong admin password' });
    }

    const patch = { updated_at: new Date().toISOString() };
    if (owners !== undefined)      patch.owners = owners;
    if (event_name !== undefined)  patch.event_name = event_name;
    if (purse !== undefined)       patch.purse = purse;

    const { error } = await supabase
      .from('pool_state').update(patch).eq('id','main');
    if (error) throw error;

    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
