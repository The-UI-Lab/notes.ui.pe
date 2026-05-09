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
- Nginx (production runtime)

## Local development

```bash
npm install
npm run dev          # Vite dev server (default http://localhost:5173)
npm run build        # tsc -b && vite build  → ./dist
npm run preview      # preview the built bundle
```

There are **no build-time environment variables**. All settings (Facebook
credentials, S3 credentials, theme) are entered at runtime in **Settings** and
stored in the browser only.

## Configuration (in-app)

Open the **⚙ Settings** panel from the sidebar:

- **Facebook Page** — paste a long-lived **Page Access Token** and the **Page
  ID**. The token is used directly from the browser via Graph API v19; ensure
  the token has the `pages_manage_posts` and `pages_read_engagement` scopes.
- **S3 backup** — endpoint, region, bucket, access key, secret key. Works with
  AWS, Cloudflare R2, Backblaze B2, MinIO, etc. The bucket must allow CORS
  `PUT`/`GET`/`LIST` from your domain.
- **Storage** — see current usage versus the browser's quota and request
  persistent storage if it's still "best-effort".

## Deployment with Dokploy

The repo ships a production-ready Docker setup:

- [`Dockerfile`](Dockerfile) — multi-stage Node 20 build → Nginx Alpine runtime
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
5. **Environment variables:** **none required.** All app settings are stored
   client-side per browser; no server-side secrets exist.
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
