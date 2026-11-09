import fs from 'node:fs';
import path from 'node:path';
import { db } from './store.js';

export const cfg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'config.json'), 'utf8'));

const stripNoise = s => s.replace(/https?:\/\/\S+/g, '').replace(/(^|\s)@\w+/g, ' ').trim();

// A post counts when it is not a plain retweet, tags the official handle, and, if it is a reply, carries real commentary.
export function counts(t) {
  if (t.isRetweet) return false;
  if (cfg.requireOfficialTag && !t.text.toLowerCase().includes('@' + cfg.officialHandle.toLowerCase())) return false;
  if (t.isReply && stripNoise(t.text).length < cfg.substantiveReplyMinChars) return false;
  return true;
}

export function classify(t) {
  const x = t.text.toLowerCase();
  return {
    official: x.includes('@' + cfg.officialHandle.toLowerCase()),
    // the official handle contains the keyword, so strip it before testing for a plain keyword mention
    keyword: cfg.keywords.some(k => x.split('@' + cfg.officialHandle.toLowerCase()).join(' ').includes(k.toLowerCase())),
    tag: cfg.tags.some(k => x.includes(k.toLowerCase())),
    reply: t.isReply
  };
}

export function points(a) {
  const w = cfg.weights;
  return Math.round((a.views * w.views + a.likes * w.likes + a.posts * w.posts + (a.smart || 0) * (w.smart || 0)) * 10) / 10;
}

let cache = { v: -1, list: [] };

export function aggregate() {
  if (cache.v === db.meta.version) return cache.list;
  const m = {};
  for (const t of Object.values(db.tweets)) {
    if (!counts(t)) continue;
    const k = t.user.toLowerCase();
    const a = m[k] || (m[k] = { user: t.user, posts: 0, views: 0, likes: 0, replies: 0, rts: 0, quotes: 0, first: null,
      mentions: { official: 0, keyword: 0, tag: 0, reply: 0 }, tweets: [] });
    a.posts++; a.views += t.views; a.likes += t.likes; a.replies += t.replies; a.rts += t.rts; a.quotes += t.quotes;
    if (!a.first || t.created < a.first.created) a.first = { created: t.created, url: t.url };
    const c = classify(t);
    for (const key of Object.keys(c)) if (c[key]) a.mentions[key]++;
    a.tweets.push(t);
  }
  const list = Object.values(m).map(a => {
    const u = db.users[a.user.toLowerCase()] || {};
    const out = { ...a, name: u.name || '', followers: u.followers || 0, avatar: u.avatar || '',
      smart: u.moni?.smart ?? null, moniScore: u.moni?.score ?? null };
    out.points = points(out);
    out.er = out.views ? Math.round((out.likes + out.replies + out.rts + out.quotes) / out.views * 10000) / 100 : null;
    return out;
  });
  cache = { v: db.meta.version, list };
  return list;
}

export function publicRow(a, withPosts = false) {
  const { tweets, ...r } = a;
  if (withPosts) r.top = [...tweets].sort((x, y) => (y.likes + y.views * 0.01) - (x.likes + x.views * 0.01)).slice(0, 5)
    .map(t => ({ url: t.url, text: t.text.slice(0, 280), likes: t.likes, views: t.views, replies: t.replies, rts: t.rts, created: t.created }));
  return r;
}
