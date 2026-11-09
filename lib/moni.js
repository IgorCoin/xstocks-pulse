// Smart followers and score from Sorsa (api.sorsa.io). The file keeps its old name so the rest of the code is unchanged.
// Score = Sorsa Score. Smart followers = followers that Sorsa classes as influencers, projects or VCs.
const BASE = "https://api.sorsa.io/v3";

export class RateLimited extends Error {}

// Optional: enabled only when SORSA_KEY exists (or in MOCK mode); SMART_FOLLOWERS=off forces it off.
export const smartEnabled = () => process.env.SMART_FOLLOWERS !== "off" && (process.env.MOCK === "1" || !!process.env.SORSA_KEY);

async function call(path, handle, key) {
  const res = await fetch(`${BASE}/${path}?username=${encodeURIComponent(handle)}`, {
    headers: { ApiKey: key, Accept: "application/json" }, signal: AbortSignal.timeout(20000) });
  if (res.status === 429) throw new RateLimited("Sorsa rate limit");
  if (!res.ok) return null;
  return res.json();
}

export async function moniInfo(handle) {
  if (process.env.MOCK === "1") {
    const n = [...handle].reduce((s, c) => s + c.charCodeAt(0), 0);
    return { smart: n % 90, score: (n * 7) % 1500 };
  }
  const key = process.env.SORSA_KEY;
  if (!key) return null;
  const [s, f] = await Promise.all([call("score", handle, key), call("followers-stats", handle, key)]);
  const score = s && Number.isFinite(+s.score) ? Math.round(+s.score) : null;
  const smart = f ? (+f.influencers_count || 0) + (+f.projects_count || 0) + (+f.venture_capitals_count || 0) : null;
  return score == null && smart == null ? null : { smart, score };
}
