# FamilyTube

A family video front page at [tube.ajith.ai](https://tube.ajith.ai). Plain HTML, CSS and JS on GitHub Pages. No framework, no build step, no login.

Anyone can open it and see the default pages: Home, Kreupasanam, Daily Blessings, Ajith and Nisha. Sign in with Google and open **Settings** to add more profiles, such as each kid, and pick the channels each one can watch. Invite family members by their Google email so they see the same profiles. Kreupasanam and Daily Blessings have their own pages, with Kreupasanam split into Our Daily Bread, Udambadi Dhyanam, Br. Vijayakumar, and Testimonials (filtered by Career/visa/job, Health, Marriage & children, House/debt/money, Others).

## How it works

- `config.json` says which channels exist and where they show up. This is the only file you normally edit.
- `scripts/fetch.mjs` runs every hour in GitHub Actions, reads each channel's public YouTube feed, and adds new videos to `data/videos.json`. The archive grows over time.
- Sorting into sections and testimonial categories happens in the browser using title keywords from `config.json`, so changing a keyword takes effect on the next page load with no refetch.
- "Must watch" ranks the last 30 days by views, likes and comments, faded by age.

## Optional: YouTube API key

Without a key the site works from public feeds (newest 15 videos per channel, plus views and likes). With a free YouTube Data API key it also backfills older videos, adds comment counts and durations, and filters Shorts more reliably. Add it as a repository secret named `YOUTUBE_API_KEY`.

## Sign-in and Settings

- Sign-in uses Firebase Authentication (Google). Family profiles are stored in Firestore, one document per family, locked down by `firestore.rules`.
- Kids' videos are fetched in the browser with the YouTube Data API, only after sign-in, and cached on the device for an hour.
- Kids' names are never in this repo. They only exist in your Firestore.

### One-time setup (about 15 minutes)

1. Go to [console.firebase.google.com](https://console.firebase.google.com), create a project (for example `familytube`). Analytics can stay off.
2. **Authentication** → Get started → Sign-in method → **Google** → Enable. Then Settings → Authorized domains → add `tube.ajith.ai`.
3. **Firestore Database** → Create database (production mode, any region near you). Open the **Rules** tab, paste `firestore.rules`, Publish.
4. Project settings → General → Your apps → add a **Web** app. Copy `apiKey`, `authDomain`, `projectId` and `appId` into the `firebase` block of `config.json`.
5. In [Google Cloud console](https://console.cloud.google.com) for the same project: APIs & Services → Library → enable **YouTube Data API v3**. Credentials → Create API key → restrict it to HTTP referrer `https://tube.ajith.ai/*` and to YouTube Data API v3. Put it in `youtubeApiKey` in `config.json`.

Both keys are meant to be public. The Firebase key only identifies the project (access is controlled by the rules), and the YouTube key only works from tube.ajith.ai.

## Publishing setup

1. Repository Settings → Pages → Source: **GitHub Actions**.
2. DNS for ajith.ai: add a `CNAME` record `tube` → `ajithjoseph.github.io`.
3. Settings → Pages → Custom domain: `tube.ajith.ai`, then tick Enforce HTTPS.
4. Actions → "Update videos and deploy" → Run workflow.

## Run locally

```bash
node scripts/fetch.mjs
python3 -m http.server 8000
```
