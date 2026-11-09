import { db, touch, saveNow, upsertUser } from './store.js';
import { searchTweets } from './twitter.js';
import { moniInfo, RateLimited, smartEnabled } from './moni.js';
import { cfg, aggregate } from './score.js';

const day = ms => new Date(ms).toISOString().slice(0, 10);
const HOUR = 36e5;
let running = false;

export function ingest(tweets) {
  for (const t of tweets) {
    db.tweets[t.id] = t;
    upsertUser(t);
  }
  touch();
}

export async function enrichMoni(users) {
  if (!smartEnabled()) return;
  const ttl = cfg.moniTtlHours * HOUR;
  for (const u of users) {
    const rec = db.users[u.toLowerCase()];
    if (!rec || (rec.moni && Date.now() - rec.moni.at < ttl)) continue;
    try {
      const info = await moniInfo(rec.user);
      rec.moni = { smart: info?.smart ?? null, score: info?.score ?? null, at: Date.now() };
      touch();
    } catch (e) {
      if (e instanceof RateLimited) { console.warn('Moni rate limited, stopping enrichment'); return; }
      console.warn('Moni failed for', rec.user, e.message);
    }
    await new Promise(r => setTimeout(r, 250));
  }
}

export async function runIndex() {
  if (running) return { skipped: true };
  running = true;
  const started = Date.now();
  try {
    const days = db.meta.lastRun ? cfg.refreshWindowDays : cfg.firstRunDays;
    const query = `(${cfg.searchQuery}) since:${day(started - days * 864e5)} -filter:retweets`;
    const tweets = await searchTweets({ query, maxPages: cfg.maxPagesPerRun });
    ingest(tweets);
    const top = aggregate().sort((a, b) => b.points - a.points).slice(0, cfg.moniTopN).map(a => a.user);
    await enrichMoni(top);
    db.meta.lastRun = Date.now();
    db.meta.lastStatus = `ok: ${tweets.length} posts in ${Math.round((Date.now() - started) / 1000)}s`;
    touch(); saveNow();
    console.log('index run', db.meta.lastStatus);
    return { ok: true, posts: tweets.length };
  } catch (e) {
    db.meta.lastStatus = 'error: ' + e.message;
    touch();
    console.error('index run failed:', e.message);
    return { ok: false, error: e.message };
  } finally { running = false; }
}

export function startSchedule() {
  const stale = !db.meta.lastRun || Date.now() - db.meta.lastRun > 24 * HOUR;
  if (stale) runIndex();
  setInterval(() => { if (Date.now() - (db.meta.lastRun || 0) > 23.5 * HOUR) runIndex(); }, HOUR);
}

/* ---------- on-demand scan of one handle ---------- */
const ipHits = new Map();
let globalDay = { d: '', n: 0, usd: 0 };

export function scanAllowed(ip) {
  const now = Date.now();
  const arr = (ipHits.get(ip) || []).filter(t => now - t < HOUR);
  const d = day(now);
  if (globalDay.d !== d) globalDay = { d, n: 0, usd: 0 };
  if (arr.length >= cfg.scan.perIpPerHour) return 'Too many scans from your address, try again in an hour.';
  if (globalDay.usd >= (cfg.scan.dailyBudgetUsd ?? 1)) return 'Daily scan budget reached, try again tomorrow.';
  if (globalDay.n >= cfg.scan.globalPerDay) return 'Daily scan limit reached, try again tomorrow.';
  arr.push(now); ipHits.set(ip, arr); globalDay.n++;
  return null;
}

export async function scanHandle(handle) {
  const k = handle.toLowerCase();
  const fresh = db.scans[k] && Date.now() - db.scans[k].at < cfg.scan.cacheHours * HOUR;
  if (!fresh) {
    const days = cfg.scan.sinceDate ? Math.floor((Date.now() - Date.parse(cfg.scan.sinceDate)) / 864e5) : cfg.firstRunDays;
    const query = `from:${handle} (${cfg.searchQuery}) since:${day(Date.now() - days * 864e5)} -filter:retweets`;
    const tweets = await searchTweets({ query, maxPages: cfg.scan.maxPages });
    ingest(tweets);
    globalDay.usd += Math.max(tweets.length, tweets.pages || 1) * (cfg.backfill?.pricePerTweetUsd ?? 0.00015);
    db.scans[k] = { at: Date.now() };
    if (db.users[k]) await enrichMoni([k]);
    touch();
  }
  return aggregate().find(a => a.user.toLowerCase() === k) || null;
}
