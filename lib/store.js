import fs from 'node:fs';
import path from 'node:path';

const DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const FILE = path.join(DIR, 'db.json');

export const db = { tweets: {}, users: {}, meta: { lastRun: null, lastStatus: null, version: 0 }, scans: {} };

export function load() {
  fs.mkdirSync(DIR, { recursive: true });
  try {
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    Object.assign(db, { tweets: j.tweets || {}, users: j.users || {}, meta: { ...db.meta, ...(j.meta || {}) }, scans: j.scans || {} });
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('db load failed, starting empty:', e.message);
  }
}

let timer = null;
export function touch() {
  db.meta.version++;
  if (timer) return;
  timer = setTimeout(() => { timer = null; saveNow(); }, 500);
}

export function saveNow() {
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, FILE);
}

export function upsertUser(u) {
  const k = u.user.toLowerCase();
  const prev = db.users[k] || {};
  db.users[k] = { ...prev, user: u.user, name: u.name || prev.name || '', followers: u.followers ?? prev.followers ?? 0, avatar: u.avatar || prev.avatar || '' };
  return db.users[k];
}

// Merge a db.json exported from another machine. Posts already on this server win (they may be fresher).
const num = v => (Number.isFinite(+v) ? +v : 0);
function cleanTweet(t) {
  return { id: String(t.id), url: String(t.url || ''), text: String(t.text).slice(0, 1000), likes: num(t.likes), replies: num(t.replies),
    rts: num(t.rts), quotes: num(t.quotes), views: num(t.views), created: new Date(t.created).toISOString(), isReply: !!t.isReply,
    isRetweet: !!t.isRetweet, user: String(t.user).slice(0, 15), name: String(t.name || '').slice(0, 80), followers: num(t.followers), avatar: String(t.avatar || '') };
}
export function importDb(inc) {
  if (!inc || typeof inc.tweets !== 'object' || Array.isArray(inc.tweets)) throw new Error('file has no tweets');
  let added = 0, skipped = 0;
  for (const [id, t] of Object.entries(inc.tweets)) {
    if (db.tweets[id]) continue;
    try { if (!t || typeof t.text !== 'string' || !t.user) throw 0; db.tweets[id] = cleanTweet({ ...t, id }); added++; } catch { skipped++; }
  }
  for (const [k, u] of Object.entries(inc.users || {})) {
    if (db.users[k] || !u || !u.user) continue;
    db.users[k] = { user: String(u.user).slice(0, 15), name: String(u.name || '').slice(0, 80), followers: num(u.followers), avatar: String(u.avatar || ''), ...(u.moni ? { moni: u.moni } : {}) };
  }
  const b = inc.meta && inc.meta.backfill, mine = db.meta.backfill;
  if (b && b.since && b.nextUntil && (!mine || (mine.since === b.since && b.nextUntil < mine.nextUntil))) db.meta.backfill = b;
  if (!db.meta.lastRun && inc.meta && inc.meta.lastRun) db.meta.lastRun = inc.meta.lastRun;
  touch(); saveNow();
  return { added, skipped, total: Object.keys(db.tweets).length };
}
