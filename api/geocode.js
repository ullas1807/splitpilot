import { allowMethod, sanitizeText } from './_lib/http.js';

// Server-side proxy for OpenStreetMap Nominatim (sets the required User-Agent; low volume use only).
export default async function handler(req, res) {
  if (!allowMethod(req, res, 'GET')) return;
  const q = sanitizeText(req.query.q, 120);
  if (q.length < 3) return res.status(400).json({ error: 'Type a venue name or address first.' });
  try {
    const url = new URL('https://nominatim.openstreetmap.org/search');
    url.search = new URLSearchParams({ format: 'jsonv2', limit: '1', q }).toString();
    const r = await fetch(url, {
      headers: { 'User-Agent': 'SplitPilot-Hackathon/1.0 (PayPal AI hackathon demo)', 'Accept-Language': 'en' },
      signal: AbortSignal.timeout(8000),
    });
    const list = await r.json();
    if (!Array.isArray(list) || !list.length) return res.status(404).json({ error: 'Could not find that place. Click the map to drop a pin instead.' });
    return res.status(200).json({ lat: Number(list[0].lat), lng: Number(list[0].lon), name: list[0].display_name });
  } catch (e) {
    console.error('geocode failed', e.message);
    return res.status(502).json({ error: 'Map search is unavailable. Click the map to drop a pin instead.' });
  }
}
