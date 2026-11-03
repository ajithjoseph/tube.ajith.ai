// Google sign-in and Settings for FamilyTube.
//
// Signed out: the site shows the default profiles from config.json.
// Signed in: the user's "household" (stored in Firebase Firestore) adds more
// profiles, such as the kids, each with its own list of allowed channels.
// Anyone whose email is in a household's member list sees the same profiles.
//
// Kids' videos are fetched in the browser with the YouTube Data API key from
// config.json, then cached on the device for an hour.

const FIREBASE = "https://www.gstatic.com/firebasejs/10.12.2";
const CACHE_MS = 60 * 60 * 1000;
const COLORS = ["#8e44ad", "#2e86de", "#27ae60", "#f1c40f", "#e67e22", "#16a085", "#c0392b"];

const FT = window.FamilyTube;
const { esc } = FT;
const $ = (s, el = document) => el.querySelector(s);

let fb = null;        // { auth, db, ...firebase functions }
let user = null;
let household = null; // { id, name, owner, members, profiles }
let status = "";      // short message shown on the settings page
let CFG;

// ---------- boot ----------

(async () => {
  CFG = await FT.ready;
  FT.registerPage("settings", renderSettings);
  renderAccountButton();
  if (!CFG.firebase?.apiKey) return; // sign-in not set up yet
  try {
    const [app, auth, store] = await Promise.all([
      import(`${FIREBASE}/firebase-app.js`),
      import(`${FIREBASE}/firebase-auth.js`),
      import(`${FIREBASE}/firebase-firestore.js`),
    ]);
    const fbApp = app.initializeApp(CFG.firebase);
    fb = { ...auth, ...store, auth: auth.getAuth(fbApp), db: store.getFirestore(fbApp) };
    fb.getRedirectResult(fb.auth).catch(() => {});
    fb.onAuthStateChanged(fb.auth, async (u) => {
      user = u;
      household = null;
      if (u) await loadHousehold();
      else FT.setHousehold([]);
      renderAccountButton();
      FT.refresh();
    });
  } catch (err) {
    console.error(err);
    status = "Could not load sign-in. Check your connection and reload.";
    FT.refresh();
  }
})();

// ---------- auth ----------

async function signIn() {
  const provider = new fb.GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });
  try {
    await fb.signInWithPopup(fb.auth, provider);
  } catch (err) {
    // TVs and some phones block popups: fall back to a full-page redirect.
    if (/popup|operation-not-supported/.test(err.code || "")) await fb.signInWithRedirect(fb.auth, provider);
    else if (err.code !== "auth/cancelled-popup-request" && err.code !== "auth/popup-closed-by-user") alertStatus(err.message);
  }
}

function renderAccountButton() {
  const el = $("#account");
  if (!el) return;
  if (user) {
    const pic = user.photoURL ? `<img src="${esc(user.photoURL)}" alt="" referrerpolicy="no-referrer">` : esc((user.displayName || user.email || "?")[0]);
    el.innerHTML = `<a class="me" href="#/settings" title="${esc(user.email)}">${pic}</a>`;
  } else if (fb) {
    el.innerHTML = `<button class="pill signin" type="button">Sign in</button>`;
    $(".signin", el).onclick = signIn;
  } else {
    el.innerHTML = "";
  }
}

// ---------- household (Firestore) ----------

const email = () => (user?.email || "").toLowerCase();

async function loadHousehold() {
  const q = fb.query(fb.collection(fb.db, "households"), fb.where("members", "array-contains", email()));
  const snap = await fb.getDocs(q);
  const d = snap.docs[0];
  household = d ? { id: d.id, ...d.data() } : null;
  applyHousehold();
}

async function saveHousehold() {
  const { id, ...data } = household;
  data.updatedAt = Date.now();
  await fb.setDoc(fb.doc(fb.db, "households", id), data);
  alertStatus("Saved");
  applyHousehold();
}

async function createHousehold(name) {
  const ref = fb.doc(fb.collection(fb.db, "households"));
  household = { id: ref.id, name, owner: user.uid, members: [email()], profiles: [] };
  await saveHousehold();
}

function applyHousehold() {
  const profiles = household?.profiles || [];
  FT.setHousehold(profiles);
  loadProfileVideos(profiles);
}

// ---------- YouTube Data API (browser) ----------

async function yt(path, params) {
  const key = CFG.youtubeApiKey;
  if (!key) throw new Error("No YouTube API key in config.json yet.");
  const res = await fetch(`https://www.googleapis.com/youtube/v3/${path}?${new URLSearchParams({ ...params, key })}`);
  const json = await res.json();
  if (!res.ok) throw new Error(json.error?.message || `YouTube said ${res.status}`);
  return json;
}

// Accepts a channel link, @handle, channel id, or playlist link.
async function resolveChannel(input) {
  const s = input.trim();
  const list = s.match(/[?&]list=([\w-]+)/)?.[1] || (/^(PL|UU|OL)[\w-]{10,}$/.test(s) && s);
  if (list) {
    const r = await yt("playlists", { part: "snippet", id: list });
    const p = r.items?.[0];
    if (!p) throw new Error("Could not find that playlist.");
    return { key: list, uploads: list, title: p.snippet.title, by: p.snippet.channelTitle };
  }
  const id = s.match(/(UC[\w-]{22})/)?.[1];
  const handle = s.match(/@([\w.\-]+)/)?.[1] || (!id && !/[\s/]/.test(s) && s);
  const r = await yt("channels", { part: "snippet,contentDetails", ...(id ? { id } : { forHandle: "@" + handle }) });
  const c = r.items?.[0];
  if (!c) throw new Error("Could not find that channel. Try pasting the channel link.");
  return { key: c.id, uploads: c.contentDetails.relatedPlaylists.uploads, title: c.snippet.title, handle: c.snippet.customUrl || "" };
}

const isoSeconds = (d) => {
  const m = d?.match(/P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  return m ? (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0) : null;
};

async function channelVideos(ch) {
  const cacheKey = "yt:" + ch.uploads;
  try {
    const hit = JSON.parse(localStorage.getItem(cacheKey));
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.videos;
  } catch {}
  const items = await yt("playlistItems", { part: "snippet", playlistId: ch.uploads, maxResults: 50 });
  let videos = (items.items || [])
    .map((it) => it.snippet)
    .filter((s) => s?.resourceId?.videoId && s.title !== "Private video" && s.title !== "Deleted video")
    .map((s) => ({ id: s.resourceId.videoId, t: s.title, c: s.videoOwnerChannelTitle || s.channelTitle, p: s.publishedAt, s: "u:" + ch.key }));
  if (videos.length) {
    const stats = await yt("videos", { part: "statistics,contentDetails", id: videos.map((v) => v.id).join(",") });
    const byId = Object.fromEntries((stats.items || []).map((x) => [x.id, x]));
    for (const v of videos) {
      const x = byId[v.id];
      if (!x) continue;
      v.v = +(x.statistics?.viewCount || 0);
      v.l = +(x.statistics?.likeCount || 0);
      if (x.statistics?.commentCount != null) v.cm = +x.statistics.commentCount;
      v.d = isoSeconds(x.contentDetails?.duration);
    }
  }
  try { localStorage.setItem(cacheKey, JSON.stringify({ at: Date.now(), videos })); } catch {}
  return videos;
}

async function loadProfileVideos(profiles) {
  const chans = new Map();
  for (const p of profiles) for (const c of p.channels || []) chans.set(c.key + "|" + (c.match || ""), c);
  const results = await Promise.allSettled([...chans.values()].map(async (c) => {
    let list = await channelVideos(c);
    if (c.match) { const re = new RegExp(c.match, "iu"); list = list.filter((v) => re.test(v.t)); }
    return list;
  }));
  const videos = results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
  const failed = results.filter((r) => r.status === "rejected");
  if (failed.length) console.warn("Some channels did not load:", failed.map((f) => f.reason?.message));
  if (videos.length) FT.addVideos(videos);
}

// ---------- settings page ----------

let mainEl = null;
function alertStatus(msg) {
  status = msg;
  const el = $("#settings-status");
  if (el) { el.textContent = msg; el.hidden = !msg; }
  if (msg === "Saved") setTimeout(() => { if (status === "Saved") alertStatus(""); }, 2500);
}

function renderSettings(main) {
  mainEl = main;
  const head = `<div class="page-head"><div><h1>Settings</h1><p>Add the kids and pick what each of them can watch.</p></div></div>`;
  const statusLine = `<p id="settings-status" class="status"${status ? "" : " hidden"}>${esc(status)}</p>`;

  if (!CFG.firebase?.apiKey) {
    main.innerHTML = head + `<section class="panel"><h2>Sign-in isn't set up yet</h2>
      <p>Everyone sees the default profiles for now. To turn on Google sign-in, add the Firebase settings to <code>config.json</code>. The README has the steps.</p></section>`;
    return;
  }
  if (!fb) { main.innerHTML = head + statusLine + `<p class="empty">Loading…</p>`; return; }

  if (!user) {
    main.innerHTML = head + statusLine + `<section class="panel"><h2>Sign in</h2>
      <p>Sign in with Google to add profiles for the kids. Only people you invite can see them.</p>
      <button class="pill" id="go-signin" type="button">Sign in with Google</button></section>`;
    $("#go-signin", main).onclick = signIn;
    return;
  }

  const who = `<section class="panel row-between"><div><strong>${esc(user.displayName || "")}</strong><p class="muted">${esc(user.email)}</p></div>
    <button class="chip" id="signout" type="button">Sign out</button></section>`;

  if (!household) {
    main.innerHTML = head + statusLine + who + `<section class="panel"><h2>Create your family</h2>
      <p>This holds your extra profiles. You can invite your spouse next.</p>
      <form id="make-house" class="inline"><input id="house-name" required maxlength="60" placeholder="Family name, for example The Josephs"><button class="pill">Create</button></form></section>`;
    $("#make-house", main).onsubmit = async (e) => { e.preventDefault(); await guarded(() => createHousehold($("#house-name").value.trim())); };
    wireSignOut(main);
    return;
  }

  const isOwner = household.owner === user.uid;
  const profiles = household.profiles || [];
  const noKey = !CFG.youtubeApiKey ? `<p class="warn">No YouTube API key in config.json yet, so new channels can't be added. The README has the steps.</p>` : "";

  main.innerHTML = head + statusLine + who + noKey +
    `<section class="panel"><h2>${esc(household.name)}: profiles</h2>
      <p class="muted">These show in the sidebar for everyone in this family once they sign in. Kids' profiles stay off the Home page.</p>
      <div id="profiles">${profiles.map(profileCard).join("") || `<p class="muted">No profiles yet.</p>`}</div>
      <form id="add-profile" class="inline"><input id="new-profile" required maxlength="30" placeholder="Name"><label class="check"><input type="checkbox" id="new-kid" checked> Kid</label><button class="pill">Add profile</button></form>
    </section>
    <section class="panel"><h2>Who can see these</h2>
      <ul class="members">${household.members.map((m) => `<li>${esc(m)}${m === email() ? " (you)" : isOwner ? ` <button class="x" data-rm-member="${esc(m)}" title="Remove">×</button>` : ""}</li>`).join("")}</ul>
      <form id="add-member" class="inline"><input id="new-member" type="email" required placeholder="Their Google email"><button class="pill">Invite</button></form>
      <p class="muted">They just sign in with that Google account. No email is sent.</p>
    </section>`;

  wireSignOut(main);

  $("#add-profile", main).onsubmit = async (e) => {
    e.preventDefault();
    const label = $("#new-profile").value.trim();
    if (!label) return;
    const slug = label.toLowerCase().normalize("NFKD").replace(/[^\w]+/g, "-").replace(/^-|-$/g, "") || "profile";
    profiles.push({ id: `${slug}-${Math.random().toString(36).slice(2, 6)}`, label, kids: $("#new-kid").checked, color: COLORS[profiles.length % COLORS.length], channels: [] });
    household.profiles = profiles;
    await guarded(saveHousehold);
  };

  $("#add-member", main).onsubmit = async (e) => {
    e.preventDefault();
    const m = $("#new-member").value.trim().toLowerCase();
    if (!m || household.members.includes(m)) return;
    household.members.push(m);
    await guarded(saveHousehold);
  };

  main.querySelectorAll("[data-rm-member]").forEach((b) => (b.onclick = async () => {
    household.members = household.members.filter((m) => m !== b.dataset.rmMember);
    await guarded(saveHousehold);
  }));

  for (const p of profiles) {
    const card = main.querySelector(`[data-profile="${CSS.escape(p.id)}"]`);
    $(".p-name", card).onchange = async (e) => { p.label = e.target.value.trim() || p.label; await guarded(saveHousehold); };
    $(".p-color", card).onchange = async (e) => { p.color = e.target.value; await guarded(saveHousehold); };
    $(".p-kid", card).onchange = async (e) => { p.kids = e.target.checked; await guarded(saveHousehold); };
    $(".p-delete", card).onclick = async () => {
      if (!confirm(`Remove ${p.label}'s profile?`)) return;
      household.profiles = profiles.filter((x) => x !== p);
      await guarded(saveHousehold);
    };
    card.querySelectorAll("[data-rm-channel]").forEach((b) => (b.onclick = async () => {
      p.channels = p.channels.filter((c) => c.key !== b.dataset.rmChannel);
      await guarded(saveHousehold);
    }));
    $(".p-add", card).onsubmit = async (e) => {
      e.preventDefault();
      const input = $(".p-channel", card).value;
      const match = $(".p-match", card).value.trim();
      if (!input.trim()) return;
      await guarded(async () => {
        if (match) new RegExp(match, "iu"); // validate before saving
        alertStatus("Looking up the channel…");
        const ch = await resolveChannel(input);
        if (match) ch.match = match;
        p.channels = [...(p.channels || []).filter((c) => c.key !== ch.key), ch];
        await saveHousehold();
      });
    };
  }
}

function profileCard(p) {
  const chans = (p.channels || []).map((c) =>
    `<li><span>${esc(c.title)}${c.handle ? ` <span class="muted">${esc(c.handle)}</span>` : ""}${c.match ? ` <span class="muted">· only “${esc(c.match)}”</span>` : ""}</span><button class="x" data-rm-channel="${esc(c.key)}" title="Remove">×</button></li>`).join("");
  return `<div class="profile" data-profile="${esc(p.id)}">
    <div class="profile-top">
      <input type="color" class="p-color" value="${esc(p.color || "#888888")}" aria-label="Color">
      <input class="p-name" value="${esc(p.label)}" maxlength="30" aria-label="Name">
      <label class="check"><input type="checkbox" class="p-kid"${p.kids ? " checked" : ""}> Kid</label>
      <a class="chip" href="#/${esc(p.id)}">Open</a>
      <button class="chip p-delete" type="button">Remove</button>
    </div>
    <ul class="channels">${chans || `<li class="muted">No channels yet. Only channels you add here will show.</li>`}</ul>
    <form class="p-add inline">
      <input class="p-channel" required placeholder="Channel link or @handle">
      <input class="p-match" placeholder="Only titles with… (optional)">
      <button class="pill">Add channel</button>
    </form>
  </div>`;
}

function wireSignOut(main) {
  const b = $("#signout", main);
  if (b) b.onclick = () => fb.signOut(fb.auth);
}

async function guarded(fn) {
  try { await fn(); }
  catch (err) { console.error(err); alertStatus(err.message || String(err)); }
  if (mainEl && location.hash.startsWith("#/settings")) renderSettings(mainEl);
}
