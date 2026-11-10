import './lib/env.js';
import http from 'node:http';
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { load, db, saveNow, importDb } from './lib/store.js';
import { cfg, aggregate, publicRow } from './lib/score.js';
import { smartEnabled } from './lib/moni.js';
import { runBackfill, isRunning as backfillRunning } from './lib/backfill.js';
import { runIndex, startSchedule, scanAllowed, scanHandle } from './lib/indexer.js';

const PORT = +process.env.PORT || 3000;
const PUB = path.join(process.cwd(), 'public');
const HANDLE = /^[A-Za-z0-9_]{1,15}$/;
const SORTS = { points: 'points', views: 'views', likes: 'likes', posts: 'posts', smart: 'smart' };
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

load();
startSchedule();

const send = (res, code, body, headers = {}) => {
  const isObj = typeof body === 'object' && !Buffer.isBuffer(body);
  res.writeHead(code, { 'Content-Type': isObj ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', ...headers });
  res.end(isObj ? JSON.stringify(body) : body);
};

const clientIp = req => (process.env.TRUST_PROXY === '1' ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '') || req.socket.remoteAddress || 'unknown';

function totals() {
  const A = aggregate();
  return { views: A.reduce((s, a) => s + a.views, 0), likes: A.reduce((s, a) => s + a.likes, 0),
    posts: A.reduce((s, a) => s + a.posts, 0), users: A.length, lastRun: db.meta.lastRun, project: cfg.project,
    official: cfg.officialHandle, weights: cfg.weights, smart: smartEnabled(),
    backfill: db.meta.backfill ? { since: db.meta.backfill.since, from: db.meta.backfill.nextUntil, done: db.meta.backfill.done } : null };
}

async function api(req, res, url) {
  const p = url.pathname;
  if (p === '/api/stats') return send(res, 200, totals());

  if (p === '/api/leaderboard') {
    let sort = SORTS[url.searchParams.get('sort')] || 'points';
    if (sort === 'smart' && !smartEnabled()) sort = 'points';
    const limit = Math.min(+url.searchParams.get('limit') || 100, 500);
    const rows = aggregate().sort((a, b) => ((b[sort] ?? -1) - (a[sort] ?? -1)) || b.points - a.points).slice(0, limit)
      .map((a, i) => ({ rank: i + 1, ...publicRow(a) }));
    return send(res, 200, { sort, rows });
  }

  let m = /^\/api\/user\/([^/]+)$/.exec(p);
  if (m) {
    if (!HANDLE.test(m[1])) return send(res, 400, { error: 'Invalid handle' });
    const A = aggregate();
    const idx = A.slice().sort((a, b) => b.points - a.points).findIndex(a => a.user.toLowerCase() === m[1].toLowerCase());
    const a = idx >= 0 ? A.find(x => x.user.toLowerCase() === m[1].toLowerCase()) : null;
    if (!a) return send(res, 404, { error: 'Not indexed yet. Use Scan.' });
    return send(res, 200, { rank: idx + 1, ...publicRow(a, true) });
  }

  m = /^\/api\/scan\/([^/]+)$/.exec(p);
  if (m && req.method === 'POST') {
    if (!HANDLE.test(m[1])) return send(res, 400, { error: 'Invalid handle' });
    const kk = m[1].toLowerCase(); const known = db.scans[kk] && db.scans[kk].v === 2 && Date.now() - db.scans[kk].at < cfg.scan.cacheHours * 36e5;
    if (!known) { const why = scanAllowed(clientIp(req)); if (why) return send(res, 429, { error: why }); }
    try {
      const a = await scanHandle(m[1]);
      if (!a) return send(res, 404, { error: `No posts about ${cfg.project} found for @${m[1]} in the last ${cfg.firstRunDays} days.` });
      const idx = aggregate().slice().sort((x, y) => y.points - x.points).findIndex(x => x.user === a.user);
      return send(res, 200, { rank: idx + 1, ...publicRow(a, true) });
    } catch (e) { console.error('scan failed', e.message); return send(res, 502, { error: 'Data provider is unavailable, try again later.' }); }
  }

  if (p === '/api/import' && req.method === 'POST') {
    const token = process.env.ADMIN_TOKEN;
    if (!token || req.headers.authorization !== `Bearer ${token}`) return send(res, 401, { error: 'Unauthorized' });
    try {
      const chunks = []; let size = 0;
      for await (const c of req) { size += c.length; if (size > 120 * 1024 * 1024) throw new Error('upload too large'); chunks.push(c); }
      let buf = Buffer.concat(chunks);
      if (req.headers['content-encoding'] === 'gzip') buf = zlib.gunzipSync(buf, { maxOutputLength: 500 * 1024 * 1024 });
      return send(res, 200, importDb(JSON.parse(buf.toString('utf8'))));
    } catch (e) { return send(res, 400, { error: 'Import failed: ' + e.message }); }
  }

  if (p === '/api/backfill') {
    const token = process.env.ADMIN_TOKEN;
    if (!token || req.headers.authorization !== `Bearer ${token}`) return send(res, 401, { error: 'Unauthorized' });
    if (req.method === 'POST') {
      if (backfillRunning()) return send(res, 200, { running: true });
      const budget = +url.searchParams.get('budget') || undefined;
      runBackfill({ budgetUsd: budget }).catch(e => console.error('backfill failed:', e.message));
      return send(res, 202, { started: true });
    }
    return send(res, 200, { running: backfillRunning(), progress: db.meta.backfill || null });
  }

  if (p === '/api/refresh' && req.method === 'POST') {
    const token = process.env.ADMIN_TOKEN;
    if (!token || req.headers.authorization !== `Bearer ${token}`) return send(res, 401, { error: 'Unauthorized' });
    return send(res, 200, await runIndex());
  }
  return send(res, 404, { error: 'Not found' });
}

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    let f = path.normalize(path.join(PUB, url.pathname === '/' ? 'index.html' : url.pathname));
    if (!f.startsWith(PUB + path.sep) && f !== PUB) return send(res, 403, 'Forbidden');
    if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(PUB, 'index.html');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: https://pbs.twimg.com; script-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'" });
    fs.createReadStream(f).pipe(res);
  } catch (e) { console.error(e); send(res, 500, { error: 'Server error' }); }
}).listen(PORT, () => console.log(`${cfg.project} Pulse on http://localhost:${PORT}${process.env.MOCK === '1' ? ' (MOCK data)' : ''}`));

for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => { saveNow(); process.exit(0); });
