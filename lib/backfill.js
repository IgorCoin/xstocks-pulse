// Historical backfill for the leaderboard: walks from today back to config.backfill.sinceDate in day-sized
// windows (newest first), stops when the budget is spent, and remembers where it stopped so a later run
// continues from there. Cost model for twitterapi.io: about one price unit per tweet returned, minimum one per request.
import { db, touch, saveNow } from './store.js';
import { searchTweets } from './twitter.js';
import { cfg } from './score.js';
import { ingest } from './indexer.js';

const conf = () => ({ sinceDate: '2026-01-01', chunkDays: 1, maxPagesPerChunk: 25, maxBudgetUsd: 1, pricePerTweetUsd: 0.00015, ...(cfg.backfill || {}) });
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const today = () => new Date().toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 864e5);
const units = t => t.length + Math.max(0, (t.pages || 1) - Math.ceil(t.length / 20));
const query = (a, b) => `(${cfg.searchQuery}) since:${a} until:${b} -filter:retweets`;
const sleep = ms => new Promise(r => setTimeout(r, ms));

let running = false;
export const isRunning = () => running;

export async function runBackfill({ budgetUsd, since, reset = false, log = console.log } = {}) {
  if (running) return { skipped: true };
  running = true;
  try {
    const c = conf(), start = since || c.sinceDate, budget = budgetUsd ?? c.maxBudgetUsd;
    let bf = db.meta.backfill;
    if (reset || !bf || bf.since !== start) {
      bf = db.meta.backfill = { since: start, nextUntil: addDays(today(), 1), spentUsd: 0, tweets: 0, chunks: 0, truncated: [], done: false };
    }
    if (bf.done) { log(`Backfill from ${start} is already complete.`); return bf; }
    log(`Backfill ${start} -> today, budget $${budget.toFixed(2)}. Resuming below ${bf.nextUntil}.`);
    let spent = 0, stopped = '';
    while (bf.nextUntil > start) {
      const a = addDays(bf.nextUntil, -c.chunkDays) < start ? start : addDays(bf.nextUntil, -c.chunkDays);
      const pagesAllowed = Math.min(c.maxPagesPerChunk, Math.floor((budget - spent) / (20 * c.pricePerTweetUsd)));
      if (pagesAllowed < 1) { stopped = 'budget'; break; }
      const t = await searchTweets({ query: query(a, bf.nextUntil), maxPages: pagesAllowed });
      const cost = units(t) * c.pricePerTweetUsd;
      ingest(t);
      spent += cost; bf.spentUsd += cost; bf.tweets += t.length; bf.chunks++;
      if (t.more && pagesAllowed < c.maxPagesPerChunk) {
        // cut short only because the budget ran out: keep the posts, but leave this day open for the next run
        log(`${a}  ${String(t.length).padStart(4)} posts  (budget ran out mid-day, will be finished next run)`);
        touch(); stopped = 'budget'; break;
      }
      if (t.more) bf.truncated.push(a);
      log(`${a}  ${String(t.length).padStart(4)} posts${t.more ? '  (cut at page limit)' : ''}  run $${spent.toFixed(3)}`);
      bf.nextUntil = a;
      touch();
      if (bf.chunks % 5 === 0) saveNow();
      await sleep(300);
    }
    if (bf.nextUntil <= start) bf.done = true;
    touch(); saveNow();
    log(bf.done ? `Done. ${bf.tweets} posts, $${bf.spentUsd.toFixed(2)} in total.`
      : `Stopped (${stopped}). Covered ${bf.nextUntil} to today. This run $${spent.toFixed(2)}, total $${bf.spentUsd.toFixed(2)}. Run again to continue.`);
    if (bf.truncated.length) log(`${bf.truncated.length} day(s) hit the page limit and may be incomplete: ${bf.truncated.slice(-5).join(', ')}${bf.truncated.length > 5 ? ' ...' : ''}`);
    return bf;
  } finally { running = false; }
}

// Samples a few days across the range, fetches them fully, and extrapolates. Sampled posts are kept.
export async function estimate({ samples = 4, log = console.log } = {}) {
  const c = conf(), days = daysBetween(c.sinceDate, today());
  const picks = [...new Set(Array.from({ length: samples }, (_, i) => Math.round(i * (days - 1) / (samples - 1))))];
  let n = 0, u = 0, cut = 0;
  for (const off of picks) {
    const a = addDays(c.sinceDate, off);
    const t = await searchTweets({ query: query(a, addDays(a, 1)), maxPages: c.maxPagesPerChunk });
    ingest(t); n += t.length; u += units(t); if (t.more) cut++;
    log(`sample ${a}: ${t.length} posts${t.more ? ' (cut at page limit)' : ''}`);
    await sleep(300);
  }
  const avg = n / picks.length;
  const out = { days, avgPerDay: Math.round(avg), totalPosts: Math.round(avg * days), usd: avg * days * c.pricePerTweetUsd + days * c.pricePerTweetUsd, sampleUsd: u * c.pricePerTweetUsd, cut };
  touch(); saveNow();
  log(`Range ${c.sinceDate} -> today: ${days} days, about ${out.avgPerDay} posts a day, about ${out.totalPosts} posts, estimated $${out.usd.toFixed(2)} (the samples cost $${out.sampleUsd.toFixed(3)}).`);
  if (cut) log(`${cut} sample day(s) hit the page limit, so the real total may be higher.`);
  log('This is a rough guess: activity is usually uneven, and recent weeks are often busier than old ones.');
  return out;
}
