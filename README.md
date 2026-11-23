# AITube

[tube.ajith.ai](https://tube.ajith.ai): the AI videos worth your time, ranked. Podcasts, lab updates and builder talks, picked by Ajith Joseph.

Plain HTML, CSS and JS on GitHub Pages. No framework, no build step, no login, no cost.

## Sections

- **Must watch:** the top 10 from the last 30 days, ranked by views, likes and comments, faded by age.
- **Podcasts:** Dwarkesh, Lex Fridman, Latent Space, No Priors
- **Labs & research:** Anthropic, OpenAI, Google DeepMind, Andrej Karpathy
- **Builders & startups:** Y Combinator, Lenny's Podcast, a16z, My First Million

## How it works

- `config.json` lists the channels and the sidebar folders. It's the only file you normally edit.
- `scripts/fetch.mjs` runs every hour in GitHub Actions, reads each channel's public YouTube feed, and adds new videos to `data/videos.json`.
- `data/sources.json` shows the real channel name each handle resolved to, so a wrong handle is easy to spot.

## Sister sites

The same code runs [faith.ajith.ai](https://faith.ajith.ai) with a different `config.json`. A private family site (with Google sign-in, see `account.js` and `firestore.rules`) is planned. Keep `app.js`, `app.css`, `account.js` and `scripts/` identical across the sites.

## Setup

1. Settings → Pages → Source: **GitHub Actions**, Custom domain: `tube.ajith.ai`, Enforce HTTPS.
2. DNS: `CNAME` record `tube` → `ajithjoseph.github.io`.
3. Optional: a free YouTube Data API key as the repository secret `YOUTUBE_API_KEY` backfills older videos and adds comment counts.

## Run locally

```bash
node scripts/fetch.mjs
python3 -m http.server 8000
```
