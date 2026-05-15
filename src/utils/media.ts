/**
 * Media store — IndexedDB-backed Blob storage for note attachments.
 *
 * Why IndexedDB?
 *   - localStorage caps at ~5–10 MB per origin. Even a few photos blow that.
 *   - IndexedDB can use up to ~60 % of the device's disk quota (much higher
 *     when the origin is granted persistent storage), and stores Blobs
 *     directly without the ~33 % base64 inflation.
 *
 * Design:
 *   - One object store: `media` keyed by string id.
 *   - Records: { id, type, mime, blob, size, width?, height?, durationMs?, createdAt }
 *   - Object URLs are cached per id (refcounted) so the UI can mount many
 *     thumbnails without churn. URLs are revoked when nothing holds them.
 */

export type MediaType = 'image' | 'video'

export interface MediaRecord {
  id: string
  type: MediaType
  mime: string
  blob: Blob
  size: number
  width?: number
  height?: number
  durationMs?: number
  createdAt: number
}

export interface MediaRef {
  id: string
  type: MediaType
  mime: string
  size: number
  width?: number
  height?: number
  durationMs?: number
}

const DB_NAME       = 'notes-media'
const DB_VERSION    = 2
const STORE         = 'media'
const GALLERY_STORE = 'gallery'

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = (event) => {
      const db = req.result
      const oldVersion = (event as IDBVersionChangeEvent).oldVersion
      if (oldVersion < 1) {
        db.createObjectStore(STORE, { keyPath: 'id' })
      }
      if (oldVersion < 2) {
        db.createObjectStore(GALLERY_STORE, { keyPath: 'id' })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror   = () => reject(req.error ?? new Error('IndexedDB open failed'))
  })
  return dbPromise
}

function tx(mode: IDBTransactionMode): Promise<IDBObjectStore> {
  return openDb().then(db => db.transaction(STORE, mode).objectStore(STORE))
}

function galleryTx(mode: IDBTransactionMode): Promise<IDBObjectStore> {
  return openDb().then(db => db.transaction(GALLERY_STORE, mode).objectStore(GALLERY_STORE))
}

function reqAsPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror   = () => reject(req.error)
  })
}

// ── CRUD ─────────────────────────────────────────────────────────────────────

export async function putMedia(record: MediaRecord): Promise<void> {
  const store = await tx('readwrite')
  await reqAsPromise(store.put(record))
}

export async function getMedia(id: string): Promise<MediaRecord | undefined> {
  const store = await tx('readonly')
  return reqAsPromise(store.get(id) as IDBRequest<MediaRecord | undefined>)
}

export async function getMediaBlob(id: string): Promise<Blob | undefined> {
  const r = await getMedia(id)
  return r?.blob
}

export async function deleteMedia(id: string): Promise<void> {
  const store = await tx('readwrite')
  await reqAsPromise(store.delete(id))
  // Drop URL cache entry; revoke if nothing else holds it.
  const cached = urlCache.get(id)
  if (cached) {
    URL.revokeObjectURL(cached.url)
    urlCache.delete(id)
  }
}

export async function getAllMedia(): Promise<MediaRecord[]> {
  const store = await tx('readonly')
  return reqAsPromise(store.getAll() as IDBRequest<MediaRecord[]>)
}

export async function clearAllMedia(): Promise<void> {
  const store = await tx('readwrite')
  await reqAsPromise(store.clear())
  for (const { url } of urlCache.values()) URL.revokeObjectURL(url)
  urlCache.clear()
}

// ── Gallery store (manifest of unattached media items) ────────────────────────

import type { GalleryItem } from '../types'

/** Add a media record to the gallery manifest (blob already in media store). */
export async function addToGallery(item: GalleryItem): Promise<void> {
  const store = await galleryTx('readwrite')
  await reqAsPromise(store.put(item))
}

/** Remove an item from the gallery manifest (does NOT delete the blob). */
export async function removeFromGallery(id: string): Promise<void> {
  const store = await galleryTx('readwrite')
  await reqAsPromise(store.delete(id))
}

/** Return all items currently in the gallery manifest. */
export async function getAllGalleryItems(): Promise<GalleryItem[]> {
  const store = await galleryTx('readonly')
  return reqAsPromise(store.getAll() as IDBRequest<GalleryItem[]>)
}

/** Fully delete a gallery item — removes from gallery manifest AND media store. */
export async function deleteGalleryItem(id: string): Promise<void> {
  await removeFromGallery(id)
  await deleteMedia(id)
}

// ── Object URL cache ─────────────────────────────────────────────────────────

interface UrlEntry { url: string; refs: number }
const urlCache = new Map<string, UrlEntry>()

export async function getMediaUrl(id: string): Promise<string | null> {
  const cached = urlCache.get(id)
  if (cached) {
    cached.refs += 1
    return cached.url
  }
  const blob = await getMediaBlob(id)
  if (!blob) return null
  const url = URL.createObjectURL(blob)
  urlCache.set(id, { url, refs: 1 })
  return url
}

export function releaseMediaUrl(id: string): void {
  const entry = urlCache.get(id)
  if (!entry) return
  entry.refs -= 1
  if (entry.refs <= 0) {
    URL.revokeObjectURL(entry.url)
    urlCache.delete(id)
  }
}

// ── Image compression ────────────────────────────────────────────────────────

const MAX_IMAGE_DIM   = 2048
const WEBP_QUALITY    = 0.82
const JPEG_QUALITY    = 0.85

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload  = () => resolve(img)
    img.onerror = () => reject(new Error('Image decode failed'))
    img.src = src
  })
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => b ? resolve(b) : reject(new Error('Canvas encode failed')),
      type,
      quality,
    )
  })
}

const supportsWebp: Promise<boolean> = (async () => {
  try {
    const c = document.createElement('canvas')
    c.width = c.height = 1
    const blob = await canvasToBlob(c, 'image/webp', 0.5)
    return blob.type === 'image/webp'
  } catch { return false }
})()

/**
 * Compress + downscale an image File. Returns a record ready for IDB.
 * GIFs and SVGs are kept as-is (animation / vector should not be rasterized).
 */
export async function ingestImageFile(file: File): Promise<MediaRecord> {
  const id = crypto.randomUUID()
  const passthrough = file.type === 'image/gif' || file.type === 'image/svg+xml'
  if (passthrough) {
    return {
      id, type: 'image', mime: file.type, blob: file,
      size: file.size, createdAt: Date.now(),
    }
  }

  const objectUrl = URL.createObjectURL(file)
  try {
    const img = await loadImage(objectUrl)
    const { width: ow, height: oh } = img
    const longest = Math.max(ow, oh)
    const scale   = longest > MAX_IMAGE_DIM ? MAX_IMAGE_DIM / longest : 1
    const w = Math.round(ow * scale)
    const h = Math.round(oh * scale)

    const canvas = document.createElement('canvas')
    canvas.width  = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Canvas 2D context unavailable')
    ctx.drawImage(img, 0, 0, w, h)

    const useWebp = await supportsWebp
    const mime    = useWebp ? 'image/webp' : 'image/jpeg'
    const quality = useWebp ? WEBP_QUALITY : JPEG_QUALITY
    let blob = await canvasToBlob(canvas, mime, quality)

    // If "compression" produced something larger than the original, keep original.
    if (blob.size > file.size && file.type.startsWith('image/')) {
      blob = file
    }

    return {
      id,
      type: 'image',
      mime: blob.type || mime,
      blob,
      size: blob.size,
      width:  w,
      height: h,
      createdAt: Date.now(),
    }
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
}

/** Read minimal metadata for a video and store it as-is. */
export async function ingestVideoFile(file: File): Promise<MediaRecord> {
  const id = crypto.randomUUID()
  const objectUrl = URL.createObjectURL(file)
  let width: number | undefined
  let height: number | undefined
  let durationMs: number | undefined
  try {
    await new Promise<void>((resolve) => {
      const v = document.createElement('video')
      v.preload  = 'metadata'
      v.muted    = true
      v.playsInline = true
      v.onloadedmetadata = () => {
        width  = v.videoWidth  || undefined
        height = v.videoHeight || undefined
        durationMs = isFinite(v.duration) ? Math.round(v.duration * 1000) : undefined
        resolve()
      }
      v.onerror = () => resolve()
      v.src = objectUrl
    })
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
  return {
    id,
    type: 'video',
    mime: file.type || 'video/mp4',
    blob: file,
    size: file.size,
    width, height, durationMs,
    createdAt: Date.now(),
  }
}

export function toRef(rec: MediaRecord): MediaRef {
  return {
    id: rec.id, type: rec.type, mime: rec.mime, size: rec.size,
    width: rec.width, height: rec.height, durationMs: rec.durationMs,
  }
}

// ── Helpers for backup serialization ─────────────────────────────────────────

export async function blobToBase64(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer()
  const bytes = new Uint8Array(buf)
  let bin = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(bin)
}

export function base64ToBlob(b64: string, mime: string): Blob {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new Blob([bytes], { type: mime })
}

// ── Storage estimate / persistence ──────────────────────────────────────────

export interface StorageInfo {
  usage:     number | null
  quota:     number | null
  persisted: boolean
}

export async function getStorageInfo(): Promise<StorageInfo> {
  let usage: number | null = null
  let quota: number | null = null
  let persisted = false
  try {
    if (navigator.storage?.estimate) {
      const e = await navigator.storage.estimate()
      usage = e.usage ?? null
      quota = e.quota ?? null
    }
    if (navigator.storage?.persisted) {
      persisted = await navigator.storage.persisted()
    }
  } catch { /* ignore */ }
  return { usage, quota, persisted }
}

export async function requestPersistentStorage(): Promise<boolean> {
  try {
    if (navigator.storage?.persist) {
      return await navigator.storage.persist()
    }
  } catch { /* ignore */ }
  return false
}

/** Garbage-collect orphan media records not referenced by any note. */
export async function pruneOrphans(referencedIds: Set<string>): Promise<number> {
  const all = await getAllMedia()
  let removed = 0
  for (const rec of all) {
    if (!referencedIds.has(rec.id)) {
      await deleteMedia(rec.id)
      removed += 1
    }
  }
  return removed
}
