// Usage (stop the server first):
//   node backfill.js --estimate          rough cost guess from a few sample days
//   node backfill.js --budget 1          collect history, stop when $1 is spent (default from config.json)
//   node backfill.js --reset             start the history over
import './lib/env.js';
import { load, saveNow } from './lib/store.js';
import { runBackfill, estimate } from './lib/backfill.js';

const arg = n => { const i = process.argv.indexOf('--' + n); return i < 0 ? null : (process.argv[i + 1] ?? true); };
const port = +process.env.PORT || 3000;

try {
  const r = await fetch(`http://localhost:${port}/api/stats`, { signal: AbortSignal.timeout(800) });
  if (r.ok) { console.error(`The server is running on port ${port}. Stop it first (Ctrl+C in its window), otherwise the two would overwrite each other's data.`); process.exit(1); }
} catch {}

if (process.env.MOCK !== '1' && !process.env.TWITTERAPI_KEY) { console.error('TWITTERAPI_KEY is not set. Check your .env file.'); process.exit(1); }
load();
process.on('SIGINT', () => { saveNow(); console.log('\nStopped by you. Progress saved; run the same command to continue.'); process.exit(0); });
try {
  if (arg('estimate')) await estimate();
  else await runBackfill({ budgetUsd: arg('budget') ? +arg('budget') : undefined, since: typeof arg('since') === 'string' ? arg('since') : undefined, reset: !!arg('reset') });
} catch (e) { console.error('Stopped by an error:', e.message, '\nProgress so far is saved; run the same command again to continue.'); }
saveNow();
