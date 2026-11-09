# Open Media Player

An educational web media player you host yourself on **Cloudflare Pages**, straight from this GitHub repo. It installs as an app (PWA) on phones and computers.

It plays sources **you** supply. No channels, playlists or content are included. Only use sources you own or are authorised to use.

## Features

| Tab | What it does |
| --- | --- |
| **Xtream Codes** | Log in with your server URL, username and password. Browse Live TV, Movies and Series by category, with search. Live streams as HLS (`.m3u8`) or MPEG-TS (`.ts`). |
| **M3U** | Load an M3U/M3U8 playlist from a URL or a file. Groups (`group-title`), logos (`tvg-logo`) and search. |
| **Single stream** | Play one URL: HLS, DASH (`.mpd`), MPEG-TS, MP4, WebM, MP3… Keeps a history of the last 20. |
| **Local files** | Drop or pick audio/video files from your device. Nothing is uploaded. Plays them in order. |
| **Stream API** | Fetch a JSON endpoint that returns one stream or a list, with an optional auth header. |

Links that start playback directly:

```
https://your-site/?url=<stream URL>&title=<name>
https://your-site/?m3u=<playlist URL>
https://your-site/?api=<JSON endpoint>
add &proxy=1 to force the proxy on
```

Accepted Stream API responses: `{ "url": "…" }`, `[{ "name": "…", "url": "…" }]`, or the list under `streams`, `data`, `items` or `channels`. URL fields: `url, src, stream, stream_url, streamUrl, hls, dash, file, link`.

## The proxy (why the "Use proxy" switch exists)

Your site is served over `https://`. Browsers refuse to load `http://` media on an `https://` page, and many servers don't send CORS headers. Turning on **Use proxy** routes requests through `functions/api/proxy.js`, a Cloudflare Pages Function deployed automatically with the site. It also rewrites HLS playlists so their segments go through it.

Built-in limits: GET only, only requests coming from your own site, no localhost/private network addresses. To lock it down further, set **`ALLOWED_HOSTS`** (see below) so it only reaches your own servers.

Note: Cloudflare's free plan includes 100,000 Function requests per day, and every HLS segment through the proxy counts as one request. Cloudflare's terms also restrict serving large amounts of video through its network, so keep the proxy for light, personal use.

## Deploy on Cloudflare

### Option A: Workers (recommended, what `wrangler.jsonc` is set up for)

1. Cloudflare dashboard → **Workers & Pages → Create → Import a repository**, pick this repo.
2. Keep the defaults: build command empty, deploy command `npx wrangler deploy`.
3. Deploy. You get `https://iptv-player.<your-subdomain>.workers.dev`. Every push to `main` redeploys.
4. Optional, recommended: **Settings → Variables and Secrets** → add `ALLOWED_HOSTS` = `your-server.com,cdn.your-server.com`.

`worker.js` serves the static files from `public/` and sends `/api/proxy` to the proxy.

### Option B: Pages

**Workers & Pages → Create → Pages → Connect to Git**, framework preset **None**, build command empty, build output directory **`public`**. The proxy in `functions/` is picked up automatically.

| Variable | Effect |
| --- | --- |
| `ALLOWED_HOSTS` | Comma-separated host names the proxy may reach. Unset means any public host. |
| `ALLOW_ANY_ORIGIN` | `1` lets other websites use your proxy. Leave unset. |
| `ALLOW_PRIVATE_HOSTS` | `1` only for local testing against localhost/LAN servers. |

## Install as an app

Open the site in Chrome/Edge and click **Install app** (or the install icon in the address bar). On iPhone/iPad: Safari → Share → **Add to Home Screen**. On Android: Chrome menu → **Install app**.

## Run locally

```bash
npx wrangler dev
```

Then open http://localhost:8787. Plain static hosting (`npx serve public`) works too, without the proxy.

## Browser support notes

- HLS via [hls.js](https://github.com/video-dev/hls.js) (native on Safari/iOS), DASH via [dash.js](https://github.com/Dash-Industry-Forum/dash.js), MPEG-TS/FLV via [mpegts.js](https://github.com/xqq/mpegts.js). These are vendored in `public/vendor/` with their licenses.
- Codecs depend on the browser: H.264/AAC works almost everywhere; HEVC/H.265, AC-3 and MKV files often don't play in browsers.
- MPEG-TS playback needs Media Source Extensions, which iPhones don't have; use HLS there.

## Privacy

Everything runs in your browser. Xtream credentials are only stored (in `localStorage` on your device) if you tick **Remember on this device**. The proxy does not log or store anything.

## License

MIT. See `LICENSE`.
