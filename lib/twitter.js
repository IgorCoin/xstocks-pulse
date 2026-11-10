// Tweet source: twitterapi.io advanced search. MOCK=1 generates fake data so the whole app can run without keys.
const BASE = 'https://api.twitterapi.io/twitter/tweet/advanced_search';

const ENT = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };
const decode = s => String(s || '').replace(/&(amp|lt|gt|quot|#39);/g, m => ENT[m]);

export function normalize(t) {
  const a = t.author || {};
  return {
    id: String(t.id),
    url: t.url || `https://x.com/${a.userName || 'i'}/status/${t.id}`,
    text: decode(t.text),
    likes: +t.likeCount || 0,
    replies: +t.replyCount || 0,
    rts: +t.retweetCount || 0,
    quotes: +t.quoteCount || 0,
    views: +t.viewCount || 0,
    created: new Date(t.createdAt).toISOString(),
    isReply: !!(t.isReply || t.inReplyToId),
    isRetweet: !!t.retweeted_tweet || /^RT @/.test(t.text || ''),
    user: a.userName || 'unknown',
    name: a.name || '',
    followers: +a.followers || 0,
    avatar: a.profilePicture || ''
  };
}

// The returned array also carries `pages` (requests made) and `more` (true if the search stopped
// at maxPages while X still had further pages). Backfill uses both for cost tracking.
export async function searchTweets({ query, queryType = 'Latest', maxPages = 5 }) {
  if (process.env.MOCK === '1') {
    const r = mockSearch(query, maxPages);
    if (r.pages == null) { r.pages = Math.max(1, Math.ceil(r.length / 20)); r.more = false; }
    return r;
  }
  const key = process.env.TWITTERAPI_KEY;
  if (!key) throw new Error('TWITTERAPI_KEY is not set');
  const out = [];
  let cursor = '', pages = 0, more = false;
  for (let i = 0; i < maxPages; i++) {
    const u = new URL(BASE);
    u.searchParams.set('query', query);
    u.searchParams.set('queryType', queryType);
    if (cursor) u.searchParams.set('cursor', cursor);
    const res = await fetch(u, { headers: { 'X-API-Key': key } });
    if (res.status === 429) { await new Promise(r => setTimeout(r, 5000)); i--; continue; }
    if (!res.ok) throw new Error(`twitterapi.io responded ${res.status}`);
    const j = await res.json();
    pages++;
    (j.tweets || []).forEach(t => out.push(normalize(t)));
    more = !!(j.has_next_page && j.next_cursor);
    if (!more) break;
    cursor = j.next_cursor;
  }
  out.pages = pages; out.more = more;
  return out;
}

// Posts from one author's own timeline. The search index can miss posts, the timeline does not.
// Returns { tweets, pages }; replies are excluded by the endpoint, retweets are dropped by the caller.
export async function userTweets({ userName, sinceMs = 0, maxPages = 10 }) {
  if (process.env.MOCK === '1') return { tweets: [], pages: 0 };
  const key = process.env.TWITTERAPI_KEY;
  if (!key) throw new Error('TWITTERAPI_KEY is not set');
  const out = [];
  let cursor = '', pages = 0;
  for (let i = 0; i < maxPages; i++) {
    const u = new URL('https://api.twitterapi.io/twitter/user/last_tweets');
    u.searchParams.set('userName', userName);
    u.searchParams.set('includeReplies', 'false');
    if (cursor) u.searchParams.set('cursor', cursor);
    const res = await fetch(u, { headers: { 'X-API-Key': key } });
    if (res.status === 429) { await new Promise(r => setTimeout(r, 5000)); i--; continue; }
    if (!res.ok) throw new Error(`twitterapi.io responded ${res.status}`);
    const j = await res.json();
    pages++;
    const batch = (j.tweets || j.data?.tweets || []).map(normalize);
    out.push(...batch);
    const next = j.next_cursor ?? j.data?.next_cursor;
    const more = !!((j.has_next_page ?? j.data?.has_next_page) && next);
    if (!more || !batch.length) break;
    if (sinceMs && Math.min(...batch.map(t => Date.parse(t.created))) < sinceMs) break;
    cursor = next;
  }
  return { tweets: out.filter(t => !sinceMs || Date.parse(t.created) >= sinceMs), pages };
}

/* ---------- mock ---------- */
function rng(seed) { let s = seed % 2147483647 || 1; return () => (s = (s * 16807) % 2147483647) / 2147483647; }
const MOCK_USERS = ['mock_alpha', 'mock_bravo', 'mock_charlie', 'mock_delta', 'mock_echo', 'mock_foxtrot', 'mock_golf', 'mock_hotel', 'mock_india', 'mock_juliet', 'mock_kilo', 'mock_lima'];
const MOCK_TEXT = [
  'Tokenized stocks on Solana are here, trying xStocks today',
  '@xStocksFi liquidity looks solid across venues',
  'Thread: how xStocks collateral works under the hood',
  '$xStocks pools launched this week, quick breakdown',
  'yes agreed, but the spread on xStocks is the real story here',
  'gm, #xStocks 24/7 trading changes the weekend game'
];
function mockWindow(since, until, maxPages) {
  const seed = +since.replace(/-/g, '');
  const r = rng(seed);
  const full = Math.round(15 + r() * 60);
  const n = Math.min(full, maxPages * 20);
  const t0 = Date.parse(since + 'T00:00:00Z'), span = Date.parse(until + 'T00:00:00Z') - t0;
  const out = [];
  for (let i = 0; i < n; i++) {
    const u = MOCK_USERS[Math.floor(r() * r() * MOCK_USERS.length)];
    const base = 2000 + (u.charCodeAt(5) || 100) * 900;
    const views = Math.round(base * (0.02 + r() * 0.25)), likes = Math.round(views * (0.004 + r() * 0.03));
    const reply = r() < 0.2, text = MOCK_TEXT[Math.floor(r() * MOCK_TEXT.length)];
    out.push({ id: `${seed}${i}`, url: `https://x.com/${u}/status/${seed}${i}`, text: reply ? '@someone ' + text : text,
      likes, replies: Math.round(likes * .1), rts: Math.round(likes * .2), quotes: Math.round(likes * .04), views,
      created: new Date(t0 + r() * span).toISOString(), isReply: reply, isRetweet: false,
      user: u, name: u.replace('mock_', 'Mock '), followers: base, avatar: '' });
  }
  out.pages = Math.max(1, Math.ceil(n / 20)); out.more = full > n;
  return out;
}
function mockSearch(query, maxPages) {
  const w = /since:(\d{4}-\d{2}-\d{2}) until:(\d{4}-\d{2}-\d{2})/.exec(query);
  if (w) return mockWindow(w[1], w[2], maxPages);
  const m = /^from:(\w+)/.exec(query);
  const users = m ? [m[1]] : MOCK_USERS;
  const r = rng(m ? m[1].length * 977 : 42);
  const n = Math.min(maxPages * 20, m ? 14 : 160);
  const out = [];
  for (let i = 0; i < n; i++) {
    const u = users[Math.floor(r() * r() * users.length)];
    const base = 2000 + (u.charCodeAt(5) || 100) * 900;
    const views = Math.round(base * (0.02 + r() * 0.25));
    const likes = Math.round(views * (0.004 + r() * 0.03));
    const text = MOCK_TEXT[Math.floor(r() * MOCK_TEXT.length)];
    const reply = r() < 0.2;
    out.push({
      id: String(9000000 + i + (m ? 500000 : 0)), url: `https://x.com/${u}/status/${9000000 + i}`,
      text: reply ? '@someone ' + text : text, likes, replies: Math.round(likes * .1), rts: Math.round(likes * .2), quotes: Math.round(likes * .04), views,
      created: new Date(Date.now() - r() * 20 * 864e5).toISOString(), isReply: reply, isRetweet: false,
      user: u, name: u.replace('mock_', 'Mock ').replace(/^./, c => c.toUpperCase()), followers: base, avatar: ''
    });
  }
  return out;
}
