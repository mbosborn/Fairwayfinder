// ============================================================
// /api/recap — generates a short, broadcast-style round recap of the
// pool standings (ESPN "bottom line" tone). Auto-called by the ticker.
//
// POST /api/recap  body: { round, eventName, teams:[{name,owner,total,rank,
//                          alive,cut,topGolfer:{name,pos,score}}],
//                          movers:[{name,score,pos}] }
//   -> { recap: "sentence · sentence · sentence" }
//
// Design notes:
// - The front-end sends a STRUCTURED SUMMARY (already-computed totals, ranks,
//   standout golfers), NOT raw scores. That keeps the prompt tight and, more
//   importantly, means the AI never does the money math — it only narrates
//   numbers we already trust. No hallucinated dollar figures.
// - Temperature is modest: we want polished and factual, not florid.
// - Everything is best-effort; if the AI key is missing or the call fails,
//   we return a clear error and the ticker falls back to a plain,
//   deterministically-built line (see the front-end).
// ============================================================

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { round, eventName, teams, movers } = body || {};

    if (!Array.isArray(teams) || !teams.length) {
      return res.status(400).json({ error: 'No standings provided' });
    }
    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(500).json({ error: 'AI key not configured' });
    }

    // Build a compact, factual brief for the model. Everything here is already
    // computed and trusted; the model's only job is to narrate it well.
    const roundName = ({1:'Round 1 (Thursday)',2:'Round 2 (Friday)',3:'Round 3 (Saturday)',4:'Round 4 (Sunday)'})[round] || (round ? `Round ${round}` : 'the latest round');
    const money = (n) => '$' + Number(n||0).toLocaleString('en-US');
    const standingsLines = teams.map(t =>
      `#${t.rank} ${t.name} (owner ${t.owner}) — ${money(t.total)}, ${t.alive} golfers alive, ${t.cut} cut` +
      (t.topGolfer && t.topGolfer.name ? `; best golfer ${t.topGolfer.name} ${t.topGolfer.pos||''} (${t.topGolfer.score})` : '')
    ).join('\n');
    const moverLines = (movers && movers.length)
      ? movers.map(m => `${m.name} ${m.pos||''} (${m.score})`).join(', ')
      : 'none notable';

    const prompt =
      `You are the anchor writing the bottom-line ticker for a fantasy golf pool at ${eventName || 'this tournament'}. ` +
      `Write a recap of ${roundName} in a polished, professional SportsCenter/broadcast voice.\n\n` +
      `RULES:\n` +
      `- EXACTLY three sentences, separated by " · " (space-middot-space). No other separators, no line breaks.\n` +
      `- Sentence 1: the leader and their key storyline. Sentence 2: a notable chase or mover. Sentence 3: a struggling team OR a Sunday-stakes line.\n` +
      `- Use ONLY the facts provided below. Do NOT invent scores, dollar amounts, or golfers. Every number you cite must appear in the brief.\n` +
      `- Refer to teams by their TEAM name (e.g. "Cajun Wave"), and you may use the owner's first name for variety.\n` +
      `- Keep it tight and vivid but factual. No emoji. No hashtags. Under 60 words total.\n\n` +
      `STANDINGS (already final for this round):\n${standingsLines}\n\n` +
      `Notable golfers on the move: ${moverLines}\n\n` +
      `Return ONLY the three-sentence recap, nothing else.`;

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 300,
        temperature: 0.6,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      }),
    });

    if (!r.ok) {
      const t = await r.text();
      return res.status(502).json({ error: 'AI request failed', detail: t.slice(0, 300) });
    }
    const data = await r.json();
    let recap = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
    // Strip any accidental wrapping quotes or trailing whitespace.
    recap = recap.replace(/^["'\s]+|["'\s]+$/g, '');
    if (!recap) return res.status(502).json({ error: 'Empty recap' });

    return res.status(200).json({ recap, round: round || null, generatedAt: new Date().toISOString() });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
