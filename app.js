// FamilyTube (tube.ajith.ai): a family video front page. Plain JS, no build step.
// Reads config.json (what goes where) and data/videos.json (filled hourly by scripts/fetch.mjs).
(() => {
  "use strict";

  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const store = {
    get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  };

  const ICONS = {
    home: "M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z",
    cross: "M10.5 2h3v5h5v3h-5v12h-3V10h-5V7h5z",
    sun: "M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10zM11 1h2v3h-2zm0 19h2v3h-2zM1 11h3v2H1zm19 0h3v2h-3zM4.2 5.6l1.4-1.4 2.1 2.1-1.4 1.4zm12.1 12.1 1.4-1.4 2.1 2.1-1.4 1.4zM4.2 18.4l2.1-2.1 1.4 1.4-2.1 2.1zM16.3 6.3l2.1-2.1 1.4 1.4-2.1 2.1z",
    gear: "M19.4 13a7.5 7.5 0 0 0 0-2l2.1-1.6-2-3.5-2.5 1a7 7 0 0 0-1.7-1L15 3h-4l-.4 2.7a7 7 0 0 0-1.7 1l-2.5-1-2 3.5L6.6 11a7.5 7.5 0 0 0 0 2l-2.1 1.6 2 3.5 2.5-1a7 7 0 0 0 1.7 1L11 21h4l.4-2.7a7 7 0 0 0 1.7-1l2.5 1 2-3.5zM13 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z",
    star: "M12 17.3 18.2 21l-1.6-7L22 9.2l-7.2-.6L12 2 9.2 8.6 2 9.2 7.4 14l-1.6 7z",
  };
  const icon = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${ICONS[name] || ICONS.star}"/></svg>`;
  const avatar = (item, cls = "avatar") => `<span class="${cls}" style="background:${esc(item.avatar)}">${esc(item.label[0])}</span>`;

  let CFG, VIDEOS = [], UPDATED = null;
  const NAV = new Map(); // id -> item (top level and children, children keyed "parent/child")
  let seen = new Set(store.get("seen", []));
  const PAGES = {}; // extra pages (settings) registered by account.js

  // ---------- data ----------

  const re = (s) => (s ? new RegExp(s, "iu") : null);

  function prepareNav() {
    for (const item of CFG.nav) {
      if (item.type === "divider") continue;
      item.path = item.id === "home" ? "" : item.id;
      item.reMatch = re(item.match);
      item.reExclude = re(item.exclude);
      NAV.set(item.path, item);
      for (const ch of item.children || []) {
        ch.parent = item;
        ch.path = `${item.id}/${ch.id}`;
        ch.sources ||= item.sources;
        ch.kids ??= item.kids;
        ch.reMatch = re(ch.match);
        ch.reExclude = re(ch.exclude);
        for (const cat of ch.categories || []) cat.re = re(cat.match);
        NAV.set(ch.path, ch);
      }
      for (const cat of item.categories || []) cat.re = re(cat.match);
    }
  }

  // Profiles from a signed-in household (account.js) are added after the defaults.
  function setHousehold(profiles) {
    CFG.nav = CFG.nav.filter((i) => !i.household);
    for (const [k, item] of NAV) if (item.household) NAV.delete(k);
    for (const p of profiles) {
      const item = { id: p.id, path: p.id, label: p.label, avatar: p.color, kids: !!p.kids, household: true,
        sources: (p.channels || []).map((c) => "u:" + c.key) };
      CFG.nav.push(item);
      NAV.set(item.path, item);
    }
    refresh();
  }

  function addVideos(list) {
    const byId = new Map(VIDEOS.map((v) => [v.id, v]));
    for (const v of list) byId.set(v.id, { ...byId.get(v.id), ...v });
    VIDEOS = [...byId.values()].sort((a, b) => Date.parse(b.p) - Date.parse(a.p));
    refresh();
  }

  function refresh() { if (CFG) { lastPageKey = null; route(); } }

  function videosFor(item) {
    const srcs = new Set(item.sources || []);
    let list = VIDEOS.filter((v) => srcs.has(v.s));
    if (CFG.hideShorts && !item.shorts) list = list.filter((v) => !isShort(v));
    if (item.reMatch) list = list.filter((v) => item.reMatch.test(v.t));
    if (item.reExclude) list = list.filter((v) => !item.reExclude.test(v.t));
    if (item.unsorted && item.parent) {
      const sibs = item.parent.children.filter((c) => c !== item && c.reMatch);
      list = list.filter((v) => !sibs.some((c) => c.reMatch.test(v.t)));
    }
    return list;
  }

  const isShort = (v) => v.sh || (v.d != null && v.d <= 60);

  function categoryOf(item, v) {
    const cats = item.categories || [];
    return cats.find((c) => c.re && c.re.test(v.t)) || cats[cats.length - 1];
  }

  // "Must watch": popularity and engagement, faded by age.
  function score(v, now) {
    const age = Math.max(0, (now - Date.parse(v.p)) / 864e5);
    const views = v.v || 0;
    const engagement = ((v.l || 0) + 4 * (v.cm || 0)) / Math.max(views, 50);
    const fade = Math.pow(0.5, age / (CFG.ranking?.halfLifeDays || 10));
    return Math.log10(views + 10) * (1 + 15 * Math.min(engagement, 0.2)) * (0.35 + 0.65 * fade);
  }

  function mustWatch(list) {
    const now = Date.now();
    const win = (CFG.ranking?.windowDays || 30) * 864e5;
    let pool = list.filter((v) => now - Date.parse(v.p) < win);
    if (pool.length < 5) pool = list.slice(0, 200); // quiet channel: rank its latest instead
    return pool
      .map((v) => [score(v, now), v])
      .sort((a, b) => b[0] - a[0])
      .slice(0, CFG.ranking?.top || 10)
      .map(([, v]) => v);
  }

  const uniq = (list) => { const s = new Set(); return list.filter((v) => !s.has(v.id) && s.add(v.id)); };
  const newest = (list) => [...list].sort((a, b) => Date.parse(b.p) - Date.parse(a.p));

  // ---------- formatting ----------

  function ago(iso) {
    const s = (Date.now() - Date.parse(iso)) / 1000;
    const units = [[31536000, "year"], [2592000, "month"], [604800, "week"], [86400, "day"], [3600, "hour"], [60, "minute"]];
    for (const [n, u] of units) if (s >= n) { const k = Math.floor(s / n); return `${k} ${u}${k > 1 ? "s" : ""} ago`; }
    return "just now";
  }
  const compact = (n) => (n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + "K" : String(n));
  const dur = (d) => {
    if (d == null) return "";
    const h = Math.floor(d / 3600), m = Math.floor((d % 3600) / 60), s = d % 60;
    return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(s).padStart(2, "0");
  };
  function dayLabel(iso) {
    const d = new Date(iso), today = new Date();
    const key = (x) => x.toDateString();
    const y = new Date(); y.setDate(today.getDate() - 1);
    if (key(d) === key(today)) return "Today";
    if (key(d) === key(y)) return "Yesterday";
    return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", ...(d.getFullYear() !== today.getFullYear() && { year: "numeric" }) });
  }
  function monthLabel(iso) {
    const d = new Date(iso), now = new Date();
    if (now - d < 7 * 864e5) return "This week";
    return d.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  }

  // ---------- cards ----------

  function card(v, opts = {}) {
    const cat = opts.item?.categories ? categoryOf(opts.item, v) : null;
    const bits = [esc(v.c)];
    if (v.v) bits.push(`${compact(v.v)} views`);
    bits.push(opts.item?.groupBy === "date" ? dayLabel(v.p) : ago(v.p));
    return `<a class="card" href="${esc(hrefWith({ v: v.id }))}" data-v="${esc(v.id)}">
      <div class="thumb">
        <span class="fallback">${esc(v.t)}</span>
        <img loading="lazy" alt="" src="https://i.ytimg.com/vi/${esc(v.id)}/hqdefault.jpg" onerror="this.remove()">
        ${opts.rank ? `<span class="rank">${opts.rank}</span>` : ""}
        ${v.d ? `<span class="badge">${dur(v.d)}</span>` : ""}
        ${seen.has(v.id) ? `<span class="seen" title="Watched"></span>` : ""}
      </div>
      <h3>${esc(v.t)}</h3>
      <div class="meta">${bits.join(" · ")}${cat ? ` · <span class="cat">${esc(cat.label)}</span>` : ""}</div>
    </a>`;
  }

  const row = (list, opts) => `<div class="row">${list.map((v, i) => card(v, { ...opts, rank: opts?.ranked ? i + 1 : 0 })).join("")}</div>`;
  const grid = (list, opts) => `<div class="grid">${list.map((v) => card(v, opts)).join("")}</div>`;
  const shelf = (title, list, href, opts) =>
    list.length ? `<section class="shelf"><div class="shelf-head"><h2>${title}</h2>${href ? `<a href="#/${esc(href)}">See all</a>` : ""}</div>${row(list, opts)}</section>` : "";

  // ---------- routing ----------

  function parseHash() {
    const raw = location.hash.replace(/^#\/?/, "");
    const [path, qs] = raw.split("?");
    return { path: decodeURIComponent(path || "").replace(/\/$/, ""), q: new URLSearchParams(qs || "") };
  }
  function hrefWith(changes) {
    const { path, q } = parseHash();
    for (const [k, val] of Object.entries(changes)) val == null || val === "" ? q.delete(k) : q.set(k, val);
    const s = q.toString();
    return `#/${path}${s ? "?" + s : ""}`;
  }

  let lastPageKey = null;
  function route() {
    const { path, q } = parseHash();
    const pageKey = path + "|" + (q.get("cat") || "") + "|" + (q.get("q") || "") + "|" + (q.get("n") || "");
    if (pageKey !== lastPageKey) {
      lastPageKey = pageKey;
      renderNav(path);
      renderPage(path, q);
      document.body.classList.remove("drawer");
    }
    if (q.get("v")) { openedFromPage = hadPage; openPlayer(q.get("v")); } else closePlayer(false);
    hadPage = true;
  }
  let hadPage = false, openedFromPage = false;

  // ---------- sidebar ----------

  function renderNav(path) {
    const top = path.split("/")[0];
    let html = "";
    for (const item of CFG.nav) {
      if (item.type === "divider") { html += `<div class="nav-divider">${esc(item.label)}</div>`; continue; }
      const active = item.path === top;
      const ic = item.avatar ? avatar(item) : icon(item.icon);
      html += `<a class="nav-item${active && path === item.path ? " active" : active ? " active" : ""}" href="#/${esc(item.path)}">${ic}<span class="lbl">${esc(item.label)}</span></a>`;
      if (active && item.children) {
        for (const ch of item.children) {
          html += `<a class="nav-sub${path === ch.path ? " active" : ""}" href="#/${esc(ch.path)}">${esc(ch.label)}</a>`;
        }
      }
    }
    if (PAGES.settings) {
      html += `<div class="nav-divider"></div><a class="nav-item${top === "settings" ? " active" : ""}" href="#/settings">${icon("gear")}<span class="lbl">Settings</span></a>`;
    }
    if (UPDATED) html += `<div class="nav-foot">Updated ${esc(ago(UPDATED))}</div>`;
    $("#side").innerHTML = html;
  }

  // ---------- pages ----------

  const PAGE = 48;

  function renderPage(path, q) {
    const main = $("#main");
    const search = (q.get("q") || "").trim();
    $("#search").value = search;
    if (PAGES[path]) {
      main.innerHTML = "";
      document.title = path[0].toUpperCase() + path.slice(1) + " · " + CFG.site.name + CFG.site.accent;
      PAGES[path](main, q);
      window.scrollTo(0, 0);
      return;
    }
    const item = NAV.get(path);
    if (!item) { main.innerHTML = `<p class="empty">Nothing here. <a href="#/">Go home</a></p>`; return; }

    let html;
    if (search) html = searchPage(item, search);
    else if (item.type === "home") html = homePage();
    else if (item.children) html = parentPage(item);
    else html = listPage(item, q);
    main.innerHTML = html;
    document.title = (item.type === "home" ? "" : item.label + " · ") + CFG.site.name + CFG.site.accent;
    window.scrollTo(0, 0);
  }

  function head(item, sub) {
    const ic = item.avatar ? avatar(item.parent || item) : "";
    const title = item.parent ? `${esc(item.parent.label)} · ${esc(item.label)}` : esc(item.label);
    return `<div class="page-head">${ic}<div><h1>${title}</h1>${sub ? `<p>${sub}</p>` : ""}</div></div>`;
  }

  function topItems() { return CFG.nav.filter((i) => i.type !== "divider" && i.type !== "home"); }

  function homePage() {
    const grownups = topItems().filter((i) => !i.kids);
    const pool = uniq(grownups.flatMap((i) => (i.children ? i.children.flatMap(videosFor) : videosFor(i))));
    if (!VIDEOS.length) return emptyState();
    let html = shelf(`${icon("star")} Must watch`, mustWatch(pool), "", { ranked: true });
    html += shelf("Latest", newest(pool).slice(0, 12));
    for (const i of grownups) {
      const list = newest(i.children ? uniq(i.children.flatMap(videosFor)) : videosFor(i));
      html += shelf(i.avatar ? `${avatar(i)} ${esc(i.label)}` : esc(i.label), list.slice(0, 12), i.path);
    }
    const kids = topItems().filter((i) => i.kids);
    if (kids.length) html += `<section class="shelf"><div class="shelf-head"><h2>Kids</h2></div><div class="chips">${kids.map((k) => `<a class="chip" href="#/${esc(k.path)}">${esc(k.label)}</a>`).join("")}</div></section>`;
    return html;
  }

  function parentPage(item) {
    const all = uniq(item.children.flatMap(videosFor));
    let html = head(item, `${all.length} videos`);
    if (!all.length) return html + emptyState(item);
    html += shelf(`${icon("star")} Must watch`, mustWatch(all), "", { ranked: true });
    for (const ch of item.children) html += shelf(esc(ch.label), newest(videosFor(ch)).slice(0, 12), ch.path, { item: ch });
    return html;
  }

  function listPage(item, q) {
    let list = newest(videosFor(item));
    let html = head(item, `${list.length} videos`);
    if (!list.length) return html + emptyState(item);

    if (item.categories) {
      const counts = new Map();
      for (const v of list) { const c = categoryOf(item, v); counts.set(c.id, (counts.get(c.id) || 0) + 1); }
      const cur = q.get("cat") || "";
      html += `<div class="chips"><a class="chip${cur ? "" : " on"}" href="${esc(hrefWith({ cat: null, n: null }))}">All<small>${list.length}</small></a>${item.categories
        .map((c) => `<a class="chip${cur === c.id ? " on" : ""}" href="${esc(hrefWith({ cat: c.id, n: null }))}">${esc(c.label)}<small>${counts.get(c.id) || 0}</small></a>`)
        .join("")}</div>`;
      if (cur) list = list.filter((v) => categoryOf(item, v).id === cur);
    } else if (!item.groupBy && list.length > 12) {
      // People pages and plain lists get a Must watch row on top.
      html += shelf(`${icon("star")} Must watch`, mustWatch(list), "", { ranked: true });
      html += `<div class="shelf-head"><h2>Latest</h2></div>`;
    }

    const n = Math.max(PAGE, +q.get("n") || 0);
    const shown = list.slice(0, n);
    if (item.groupBy === "date") {
      let cur = null, bucket = [];
      const flush = () => { if (bucket.length) html += `<h2 class="date-head">${esc(cur)}</h2>` + grid(bucket, { item }); bucket = []; };
      for (const v of shown) { const d = monthLabel(v.p); if (d !== cur) { flush(); cur = d; } bucket.push(v); }
      flush();
    } else {
      html += grid(shown, { item });
    }
    if (list.length > n) html += `<a class="more" href="${esc(hrefWith({ n: n + PAGE }))}">Show more</a>`;
    return html;
  }

  function searchPage(item, term) {
    const words = term.toLowerCase().split(/\s+/);
    const scope = item.type === "home" ? VIDEOS : item.children ? uniq(item.children.flatMap(videosFor)) : videosFor(item);
    const hits = newest(scope.filter((v) => { const t = (v.t + " " + v.c).toLowerCase(); return words.every((w) => t.includes(w)); }));
    const where = item.type === "home" ? "everything" : item.label;
    return `<div class="page-head"><div><h1>“${esc(term)}”</h1><p>${hits.length} results in ${esc(where)} · <a href="${esc(hrefWith({ q: null }))}" style="color:var(--accent)">clear</a></p></div></div>` +
      (hits.length ? grid(hits.slice(0, 120)) : `<p class="empty">No matches.</p>`);
  }

  function emptyState(item) {
    const srcs = (item?.sources || []).map((s) => CFG.sources[s]).filter(Boolean);
    const unset = srcs.length && srcs.every((s) => !s.handle && !s.channelId && !s.playlistId);
    return `<p class="empty">${unset ? "No channel is set for this yet. Add it in config.json." : VIDEOS.length ? "No videos match yet. New ones show up within the hour." : "No videos yet. The updater runs every hour."}</p>`;
  }

  // ---------- player ----------

  function openPlayer(id) {
    const v = VIDEOS.find((x) => x.id === id) || { id, t: "", c: "" };
    const box = $("#player");
    if (box.dataset.id !== id) {
      box.dataset.id = id;
      $("#player-frame").innerHTML = `<iframe src="https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}?autoplay=1&rel=0&playsinline=1" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen title="${esc(v.t)}"></iframe>`;
      $("#player-title").textContent = v.t;
      $("#player-sub").textContent = [v.c, v.p && ago(v.p), v.v && compact(v.v) + " views"].filter(Boolean).join(" · ");
      $("#player-yt").href = `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`;
      if (!seen.has(id)) { seen.add(id); store.set("seen", [...seen].slice(-3000)); }
    }
    box.hidden = false;
    document.body.style.overflow = "hidden";
    $("#player-close").focus();
  }

  function closePlayer(updateUrl = true) {
    const box = $("#player");
    if (box.hidden) return;
    box.hidden = true;
    box.dataset.id = "";
    $("#player-frame").innerHTML = "";
    document.body.style.overflow = "";
    lastPageKey = null; // re-render so the card shows its "watched" bar
    if (updateUrl && openedFromPage) history.back(); // hashchange re-renders
    else if (updateUrl) { history.replaceState(null, "", hrefWith({ v: null })); route(); }
    else route();
  }

  // ---------- wiring ----------

  function wire() {
    const narrow = () => matchMedia("(max-width: 900px)").matches;
    if (store.get("rail", false)) document.body.classList.add("rail");
    $("#menu").addEventListener("click", () => {
      if (narrow()) document.body.classList.toggle("drawer");
      else { document.body.classList.toggle("rail"); store.set("rail", document.body.classList.contains("rail")); }
    });
    $("#scrim").addEventListener("click", () => document.body.classList.remove("drawer"));
    $("#player-close").addEventListener("click", () => closePlayer(true));
    $("#player").addEventListener("click", (e) => { if (e.target.id === "player") closePlayer(true); });
    addEventListener("keydown", (e) => { if ((e.key === "Escape" || e.key === "Backspace") && !$("#player").hidden && e.target.tagName !== "INPUT") { e.preventDefault(); closePlayer(true); } });
    $("#search-form").addEventListener("submit", (e) => { e.preventDefault(); location.hash = hrefWith({ q: $("#search").value.trim(), cat: null, n: null, v: null }); });
    addEventListener("hashchange", route);
  }

  let markReady;
  const ready = new Promise((r) => (markReady = r));

  async function boot() {
    wire();
    try {
      const bust = Math.floor(Date.now() / 6e5); // 10 minute cache key
      const [cfg, data] = await Promise.all([
        fetch(`config.json?${bust}`).then((r) => r.json()),
        fetch(`data/videos.json?${bust}`).then((r) => (r.ok ? r.json() : { videos: [] })).catch(() => ({ videos: [] })),
      ]);
      CFG = cfg;
      VIDEOS = data.videos || [];
      UPDATED = data.updated || null;
      $("#logo-a").textContent = CFG.site.name;
      $("#logo-b").textContent = CFG.site.accent;
      prepareNav();
      route();
      markReady(CFG);
    } catch (err) {
      $("#main").innerHTML = `<p class="empty">Could not load: ${esc(err.message)}</p>`;
    }
  }

  window.FamilyTube = {
    esc, avatar, icon,
    config: () => CFG,
    ready,
    registerPage(path, fn) { PAGES[path] = fn; refresh(); },
    setHousehold, addVideos, refresh,
  };

  boot();
})();
