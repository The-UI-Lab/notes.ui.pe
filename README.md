# notes.ui.pe

A fast, local-first notes app with image and video attachments, optional
Facebook Page publishing, and end-to-end-encrypted backups to any S3-compatible
bucket. Installable as a PWA and works offline.

## Highlights

- **Local-first storage.** Notes live in `localStorage`; media (images & videos)
  live in IndexedDB as Blobs — no base64 inflation, browser-allotted quotas
  (often hundreds of MB up to several GB).
- **Smart media compression.** Images are downscaled to 2048 px on the longest
  side and re-encoded as WebP (with JPEG fallback). Originals are kept only if
  smaller. Videos are stored as-is.
- **Persistent storage.** The app requests `navigator.storage.persist()` so the
  browser does not evict your data under pressure.
- **Facebook Page publishing.** Connect a Page Access Token + Page ID and
  publish notes (with attached photos or a video) directly from the editor.
  Edits to a published note can be synced back; posts can be deleted.
- **Encrypted S3 backups.** Notes _and_ all referenced media blobs are bundled,
  encrypted with AES-GCM (PBKDF2-SHA-256, 150 k iterations, password-derived),
  and uploaded to an S3-compatible bucket. Restore on any device.
- **Installable PWA.** Auto-updating service worker, install prompt for
  Chromium/Android, manual hint for iOS.

## Tech stack

- React 19 + TypeScript
- Vite 8 + `vite-plugin-pwa` (Workbox)
- Web Crypto, IndexedDB, Web Storage APIs (zero runtime deps for storage/crypto)
- Sync server (`server/`) — Node + `ws` WebSocket relay backed by SQLite
  (`better-sqlite3`); an ephemeral mailbox that only relays client-encrypted
  blobs. Also handles the Facebook token exchange. Optional — the app works
  fully without it.
- Nginx (production runtime) — serves the SPA and reverse-proxies `/ws` and
  `/api` to the sync server

## Local development

```bash
npm install
npm run dev          # Vite dev server (default http://localhost:5173)
npm run build        # tsc -b && vite build  → ./dist
npm run preview      # preview the built bundle
```

Per-user settings (S3 credentials, theme, sync code) are entered at runtime in
**Settings** and stored in the browser only. A few environment variables
configure the optional sync server and Facebook integration — see
[`.env.example`](.env.example):

- `VITE_FB_APP_ID` — **build-time** (baked into the frontend bundle); enables
  the "Connect Facebook Page" button.
- `FB_APP_SECRET` — server-only; used for the Facebook token exchange.
- `SYNC_SERVER_KEY` — server-only; signs WebSocket join tokens. If unset, a
  random key is generated at boot and all join tokens are invalidated on every
  restart, so set it in production.
- `SYNC_PORT`, `SYNC_DATA_DIR` — sync server port and SQLite data directory.

None are required to run the core local-first app; they only enable sync and
Facebook publishing.

## Configuration (in-app)

Open the **⚙ Settings** panel from the sidebar:

- **Facebook Page** — click **Connect Facebook Page** to run the Facebook
  Login flow. The browser obtains a short-lived user token, the sync server
  exchanges it for permanent Page access tokens (requires `VITE_FB_APP_ID` +
  `FB_APP_SECRET`), and you pick which Page(s) to connect. Page posts and
  insights are then called directly from the browser via Graph API v19.
  Requires the `pages_manage_posts`, `pages_read_engagement`, `pages_show_list`,
  `pages_manage_metadata` and `business_management` scopes.
- **S3 backup** — region, bucket, access key, secret key, and an optional
  **endpoint**. With no endpoint it targets AWS S3; set the endpoint to use any
  S3-compatible provider (Cloudflare R2, Backblaze B2, MinIO, …). The bucket
  must allow CORS `PUT`/`GET`/`LIST` from your domain, and non-AWS endpoint
  hosts must be allowed by the page's CSP `connect-src` (see `nginx.conf`).
- **Storage** — see current usage versus the browser's quota and request
  persistent storage if it's still "best-effort".

## Deployment with Dokploy

The repo ships a production-ready Docker setup:

- [`Dockerfile`](Dockerfile) — multi-stage build (frontend + sync server) on a
  Node 20 Alpine runtime with nginx installed; [`entrypoint.sh`](entrypoint.sh)
  starts both the sync server and nginx
- [`nginx.conf`](nginx.conf) — SPA fallback, gzip, immutable cache for
  `/assets/*`, no-cache for `index.html`, `sw.js`, and the manifest
- [`.dockerignore`](.dockerignore) — keeps build context lean and prevents
  `.env` files from ever entering the image

### Steps in Dokploy

1. **Create a new Application** → choose your Git provider and point it at this
   repository (and the branch you want to deploy).
2. **Build type:** select **Dockerfile**. Leave the build context as the repo
   root and the Dockerfile path as `./Dockerfile`.
3. **Port:** expose container port **80**.
4. **Domain:** attach your domain in Dokploy and enable HTTPS (Let's Encrypt).
   The PWA's installability and service worker require HTTPS in production.
5. **Environment variables:** none are required for the core local-first app.
   To enable sync and Facebook publishing, set the variables from
   [`.env.example`](.env.example) — notably `SYNC_SERVER_KEY` (persist it so
   join tokens survive restarts), `VITE_FB_APP_ID` (build-time) and
   `FB_APP_SECRET`. Mount a volume at `SYNC_DATA_DIR` (default `/data/sync`) so
   the sync SQLite database persists across deploys.
6. **Deploy.** On every push, Dokploy will rebuild the image and roll out a new
   container.

### Notes on caching

`sw.js`, `registerSW.js`, `manifest.webmanifest`, and `index.html` are served
with `Cache-Control: no-cache` so users always get the latest service worker;
hashed assets in `/assets/*` are served `immutable, max-age=1y`. The PWA is
configured with `registerType: 'autoUpdate'`, so users will get the new build
on their next navigation after deploy.

### Health check

The Dockerfile defines a `HEALTHCHECK` that hits `http://localhost/`. Dokploy
will use it to gate rolling deploys.

## Privacy & data

- Notes and media never leave your browser unless you explicitly publish to
  Facebook or upload an encrypted backup to your own S3 bucket.
- Backups are encrypted client-side with AES-GCM. The server (S3) only ever
  sees ciphertext; losing the password means losing the backup.

## License

MIT
