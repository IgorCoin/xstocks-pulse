// Smart followers and score from Moni (discover.getmoni.io). Field names are matched loosely
// because the exact response shape must be confirmed against the live API.
const BASE = 'https://api.discover.getmoni.io/api/v2/twitters';

function findNum(o, re, depth = 0) {
  if (o == null || typeof o !== 'object' || depth > 4) return null;
  for (const k of Object.keys(o)) if (re.test(k) && typeof o[k] === 'number') return o[k];
  for (const k of Object.keys(o)) { const v = findNum(o[k], re, depth + 1); if (v != null) return v; }
  return null;
}

export class RateLimited extends Error {}

// Smart followers are optional: enabled only when a provider key exists (or in MOCK mode),
// and can be forced off with SMART_FOLLOWERS=off.
export const smartEnabled = () => process.env.SMART_FOLLOWERS !== 'off' && (process.env.MOCK === '1' || !!process.env.MONI_KEY);

export async function moniInfo(handle) {
  if (process.env.MOCK === '1') {
    const n = [...handle].reduce((s, c) => s + c.charCodeAt(0), 0);
    return { smart: n % 90, score: (n * 7) % 1500 };
  }
  const key = process.env.MONI_KEY;
  if (!key) return null;
  const res = await fetch(`${BASE}/${encodeURIComponent(handle)}/info/`, { headers: { 'Api-Key': key } });
  if (res.status === 429) throw new RateLimited('Moni rate limit');
  if (!res.ok) return null;
  const j = await res.json();
  const smart = findNum(j, /^smart.?followers.?(count)?$/i);
  const score = findNum(j, /^moni.?score$/i);
  return smart == null && score == null ? null : { smart, score };
}
