// ============================================================
// /api/parse-team  — reads a team screenshot and returns the
// list of golfers, converted to "First Last".
//
// BETA: open to everyone with the link — no admin password required.
//
// POST /api/parse-team  body: { imageBase64, mediaType }
// ============================================================

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { imageBase64, mediaType } = body || {};

    if (!imageBase64) return res.status(400).json({ error: 'No image provided' });
    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(500).json({ error: 'AI key not configured' });
    }

    const prompt =
      'This is a screenshot of a fantasy golf team — a list of golfers. ' +
      'Extract ONLY the golfer names. Many are written "Last, First" (e.g. "Scheffler, Scottie"); ' +
      'convert each to "First Last" (e.g. "Scottie Scheffler"). ' +
      'Ignore everything else: team names, owner names, "** Played **", "** Playing **", "** LIV **", ranks, headers. ' +
      'Return ONLY a JSON array of the golfer names in the order they appear, nothing else. ' +
      'Example: ["Scottie Scheffler","Rory McIlroy"]';

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1000,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType || 'image/png', data: imageBase64 } },
            { type: 'text', text: prompt },
          ],
        }],
      }),
    });

    if (!r.ok) {
      const t = await r.text();
      return res.status(502).json({ error: 'AI request failed', detail: t.slice(0, 300) });
    }
    const data = await r.json();
    const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();

    // pull the JSON array out of the reply
    let players = [];
    try {
      const m = text.match(/\[[\s\S]*\]/);
      players = JSON.parse(m ? m[0] : text);
    } catch (e) {
      return res.status(502).json({ error: 'Could not read names from image' });
    }
    players = (players || []).filter(p => typeof p === 'string' && p.trim()).map(p => p.trim());

    return res.status(200).json({ players });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
