#!/usr/bin/env node
// Pulls the latest videos for every source in config.json and merges them
// into data/videos.json. No dependencies, Node 20+.
//
// Without a key it reads each channel's public RSS feed (newest 15 videos,
// with views and likes). The store keeps everything it has seen, so the
// archive grows with every run.
//
// With YOUTUBE_API_KEY set it also backfills older uploads and adds comment
// counts and durations, which make "Must watch" and the Shorts filter better.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG = join(ROOT, "config.json");
const STORE = join(ROOT, "data", "videos.json");
const CHANNELS = join(ROOT, "data", "channels.json");
const KEY = process.env.YOUTUBE_API_KEY || "";
const UA = "Mozilla/5.0 (compatible; family-videos-updater/1.0)";
const DEFAULT_KEEP = 400;

const readJson = async (p, fallback) => {
  try { return JSON.parse(await readFile(p, "utf8")); } catch { return fallback; }
};

async function get(url, type = "text") {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { "user-agent": UA, "accept-language": "en-US,en" } });
      if (res.status === 404) throw Object.assign(new Error("404 " + url), { fatal: true });
      if (!res.ok) throw new Error(res.status + " " + url);
      return type === "json" ? res.json() : res.text();
    } catch (err) {
      if (err.fatal || attempt === 3) throw err;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
}

const api = (path, params) =>
  get(`https://www.googleapis.com/youtube/v3/${path}?${new URLSearchParams({ ...params, key: KEY })}`, "json");

// ---------- channel id resolution ----------

async function resolveChannelId(src, cache) {
  if (src.channelId) return src.channelId;
  if (!src.handle) return null;
  const handle = src.handle.startsWith("@") ? src.handle : "@" + src.handle;
  if (cache[handle]) return cache[handle];
  let id = null;
  if (KEY) {
    const r = await api("channels", { part: "id", forHandle: handle });
    id = r.items?.[0]?.id || null;
  }
  if (!id) {
    const html = await get(`https://www.youtube.com/@${encodeURIComponent(handle.slice(1))}`);
    id =
      html.match(/feeds\/videos\.xml\?channel_id=(UC[\w-]{22})/)?.[1] ||
      html.match(/"externalId":"(UC[\w-]{22})"/)?.[1] ||
      html.match(/itemprop="identifier" content="(UC[\w-]{22})"/)?.[1] ||
      null;
  }
  if (id) cache[handle] = id;
  return id;
}

// ---------- RSS ----------

const decode = (s) =>
  s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
   .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n));
const tag = (xml, name) => xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`))?.[1];
const attr = (xml, name, a) => xml.match(new RegExp(`<${name}[^>]*\\s${a}="([^"]*)"`))?.[1];

async function fromRss(query) {
  const xml = await get(`https://www.youtube.com/feeds/videos.xml?${query}`);
  return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(([, e]) => ({
    id: tag(e, "yt:videoId"),
    t: decode(tag(e, "title") || ""),
    c: decode(tag(tag(e, "author") || "", "name") || ""),
    p: tag(e, "published"),
    v: +(attr(e, "media:statistics", "views") || 0),
    l: +(attr(e, "media:starRating", "count") || 0),
    sh: /\/shorts\//.test(attr(e, "link", "href") || "") || undefined,
  })).filter((v) => v.id);
}

// ---------- API (optional) ----------

async function fromApiUploads(channelId, pages) {
  const out = [];
  let pageToken;
  const playlistId = "UU" + channelId.slice(2);
  for (let i = 0; i < pages; i++) {
    const r = await api("playlistItems", { part: "snippet", playlistId, maxResults: 50, ...(pageToken && { pageToken }) });
    for (const it of r.items || []) {
      const s = it.snippet;
      if (!s?.resourceId?.videoId || s.title === "Private video" || s.title === "Deleted video") continue;
      out.push({ id: s.resourceId.videoId, t: s.title, c: s.channelTitle, p: s.publishedAt });
    }
    pageToken = r.nextPageToken;
    if (!pageToken) break;
  }
  return out;
}

const isoSeconds = (d) => {
  const m = d?.match(/P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  return m ? (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0) : null;
};

async function addStats(videos) {
  for (let i = 0; i < videos.length; i += 50) {
    const batch = videos.slice(i, i + 50);
    const r = await api("videos", { part: "statistics,contentDetails", id: batch.map((v) => v.id).join(",") });
    const byId = Object.fromEntries((r.items || []).map((x) => [x.id, x]));
    for (const v of batch) {
      const x = byId[v.id];
      if (!x) continue;
      v.v = +(x.statistics?.viewCount || v.v || 0);
      v.l = +(x.statistics?.likeCount || v.l || 0);
      if (x.statistics?.commentCount != null) v.cm = +x.statistics.commentCount;
      v.d = isoSeconds(x.contentDetails?.duration);
    }
  }
}

// ---------- main ----------

async function main() {
  const config = JSON.parse(await readFile(CONFIG, "utf8"));
  const store = await readJson(STORE, { videos: [] });
  const cache = await readJson(CHANNELS, {});
  const byId = new Map(store.videos.map((v) => [v.id, v]));
  const report = [];

  for (const [sid, src] of Object.entries(config.sources)) {
    if (!src.handle && !src.channelId && !src.playlistId) { report.push(`skip  ${sid} (no channel set yet)`); continue; }
    try {
      let fresh;
      if (src.playlistId) {
        fresh = await fromRss(`playlist_id=${src.playlistId}`);
      } else {
        const cid = await resolveChannelId(src, cache);
        if (!cid) throw new Error(`could not find channel ${src.handle}`);
        fresh = await fromRss(`channel_id=${cid}`);
        if (KEY) {
          const known = store.videos.filter((v) => v.s === sid).length;
          const pages = known < 50 ? (src.backfill ?? 4) : 1;
          const older = await fromApiUploads(cid, pages);
          const rssIds = new Set(fresh.map((v) => v.id));
          fresh.push(...older.filter((v) => !rssIds.has(v.id)));
        }
      }
      if (src.match) {
        const re = new RegExp(src.match, "iu");
        fresh = fresh.filter((v) => re.test(v.t));
      }
      if (KEY) {
        // Refresh stats for new videos and anything from the last 45 days.
        const cutoff = Date.now() - 45 * 864e5;
        await addStats(fresh.filter((v) => !byId.has(v.id) || Date.parse(v.p) > cutoff));
      }
      let added = 0;
      for (const v of fresh) {
        const old = byId.get(v.id);
        if (!old) added++;
        const merged = { ...old, ...Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined)), s: sid };
        if (old?.d != null && merged.d == null) merged.d = old.d;
        byId.set(v.id, merged);
      }
      report.push(`ok    ${sid}: ${fresh.length} seen, ${added} new`);
    } catch (err) {
      report.push(`FAIL  ${sid}: ${err.message}`);
    }
  }

  // Trim each source to its 'keep' limit, newest first, and drop removed sources.
  const groups = {};
  for (const v of byId.values()) (groups[v.s] ||= []).push(v);
  const videos = [];
  for (const [sid, list] of Object.entries(groups)) {
    const src = config.sources[sid];
    if (!src) continue;
    list.sort((a, b) => Date.parse(b.p) - Date.parse(a.p));
    videos.push(...list.slice(0, src.keep ?? DEFAULT_KEEP));
  }
  videos.sort((a, b) => Date.parse(b.p) - Date.parse(a.p));

  const before = JSON.stringify(store.videos);
  const changed = before !== JSON.stringify(videos);
  await mkdir(dirname(STORE), { recursive: true });
  if (changed) {
    await writeFile(STORE, JSON.stringify({ updated: new Date().toISOString(), videos }));
  }
  await writeFile(CHANNELS, JSON.stringify(cache, null, 2) + "\n");

  console.log(report.join("\n"));
  console.log(`${videos.length} videos stored${changed ? "" : " (no change)"}${KEY ? "" : " — RSS only, set YOUTUBE_API_KEY for backfill + comments"}`);
  if (report.every((r) => !r.startsWith("ok"))) process.exitCode = 1;
}

main();
