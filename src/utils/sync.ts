/**
 * Multi-device sync via S3 — no extra servers needed.
 *
 * Strategy:
 *   - Each note is stored as an encrypted object: `sync/notes/{id}.enc`
 *   - Media blobs are stored as:                   `sync/media/{id}`
 *   - A deletion manifest lives at:                `sync/deleted.json.enc`
 *   - On push: upload any locally-changed notes + their media.
 *   - On pull: list `sync/notes/`, download any objects newer than our
 *     last-pull watermark, merge by last-write-wins on `updatedAt`.
 *   - Deletions: append to the manifest; remote devices prune on pull.
 *
 * The encryption password is the same one the user sets in the Sync panel.
 * All note payloads are encrypted with AES-256-GCM via utils/crypto.ts.
 * Media blobs are uploaded raw (they're already opaque binary).
 */

import type { S3Config } from './s3'
import {
  uploadBackup,
  downloadObject,
  deleteObject,
  listPrefix,
} from './s3'
import { encryptBackup, decryptBackup } from './crypto'
import {
  getMedia,
  putMedia,
  getMediaBlob,
  blobToBase64,
  base64ToBlob,
  type MediaRecord,
} from './media'
import type { Note } from '../types'

// ── Config / persistence keys ──────────────────────────────────────────────

const SYNC_ENABLED_KEY  = 'notes-sync-enabled'
const SYNC_PASSWORD_KEY = 'notes-sync-password'
const SYNC_WATERMARK    = 'notes-sync-watermark'   // ISO timestamp of last pull
const SYNC_PUSHED_KEY   = 'notes-sync-pushed'      // { [noteId]: updatedAt }
const SYNC_DEVICE_KEY   = 'notes-sync-device-id'

const NOTE_PREFIX   = 'sync/notes/'
const MEDIA_PREFIX  = 'sync/media/'
const DELETE_KEY    = 'sync/deleted.json.enc'

// ── Public types ───────────────────────────────────────────────────────────

export type SyncStatus = 'idle' | 'syncing' | 'error' | 'disabled'

export interface SyncState {
  enabled: boolean
  status: SyncStatus
  lastSync: number | null   // timestamp
  error: string | null
}

export interface SyncCallbacks {
  getNotes: () => Note[]
  onNotesChanged: (notes: Note[]) => void
  onStatusChange: (state: SyncState) => void
}

// ── Helpers ────────────────────────────────────────────────────────────────

function getDeviceId(): string {
  let id = localStorage.getItem(SYNC_DEVICE_KEY)
  if (!id) {
    id = crypto.randomUUID()
    localStorage.setItem(SYNC_DEVICE_KEY, id)
  }
  return id
}

function getPushedMap(): Record<string, number> {
  try {
    const raw = localStorage.getItem(SYNC_PUSHED_KEY)
    return raw ? JSON.parse(raw) : {}
  } catch { return {} }
}

function setPushedMap(m: Record<string, number>): void {
  localStorage.setItem(SYNC_PUSHED_KEY, JSON.stringify(m))
}

function getWatermark(): string | null {
  return localStorage.getItem(SYNC_WATERMARK)
}

function setWatermark(ts: string): void {
  localStorage.setItem(SYNC_WATERMARK, ts)
}

function getDeletedSet(raw: string[]): Set<string> {
  return new Set(raw)
}

// ── Encrypted note envelope ────────────────────────────────────────────────

interface NoteEnvelope {
  note: Note
  deviceId: string
  media: { id: string; mime: string; data: string }[]  // base64 media inlined
}

async function encryptNote(note: Note, password: string, deviceId: string): Promise<ArrayBuffer> {
  // Inline small media (< 512 KB) into the envelope for atomic sync.
  // Larger media is synced separately.
  const inlinedMedia: NoteEnvelope['media'] = []
  for (const ref of note.media) {
    const blob = await getMediaBlob(ref.id)
    if (!blob) continue
    if (blob.size <= 512 * 1024) {
      inlinedMedia.push({ id: ref.id, mime: ref.mime, data: await blobToBase64(blob) })
    }
  }
  const envelope: NoteEnvelope = { note, deviceId, media: inlinedMedia }
  return encryptBackup(password, JSON.stringify(envelope))
}

async function decryptNote(data: ArrayBuffer, password: string): Promise<NoteEnvelope> {
  const json = await decryptBackup(password, data)
  return JSON.parse(json) as NoteEnvelope
}

// ── Push: upload changed notes ─────────────────────────────────────────────

async function pushNotes(
  notes: Note[],
  password: string,
  s3: S3Config,
): Promise<number> {
  const deviceId = getDeviceId()
  const pushed = getPushedMap()
  let count = 0

  for (const note of notes) {
    // Skip if we already pushed this exact version
    if (pushed[note.id] === note.updatedAt) continue

    const buf = await encryptNote(note, password, deviceId)
    await uploadBackup(s3, `${NOTE_PREFIX}${note.id}.enc`, buf)

    // Upload large media blobs separately
    for (const ref of note.media) {
      const blob = await getMediaBlob(ref.id)
      if (!blob || blob.size <= 512 * 1024) continue // already inlined
      const arrayBuf = await blob.arrayBuffer()
      await uploadBackup(s3, `${MEDIA_PREFIX}${ref.id}`, arrayBuf)
    }

    pushed[note.id] = note.updatedAt
    count++
  }

  setPushedMap(pushed)
  return count
}

// ── Pull: download remote notes ────────────────────────────────────────────

async function pullNotes(
  localNotes: Note[],
  password: string,
  s3: S3Config,
): Promise<{ merged: Note[]; changed: boolean }> {
  const watermark = getWatermark()

  // List remote note objects
  const remoteObjects = await listPrefix(s3, NOTE_PREFIX)

  // Load deletion manifest
  let deletedIds: Set<string> = new Set()
  try {
    const delBuf = await downloadObject(s3, DELETE_KEY)
    const delJson = await decryptBackup(password, delBuf)
    deletedIds = getDeletedSet(JSON.parse(delJson) as string[])
  } catch {
    // No manifest yet or wrong password — that's fine
  }

  const localMap = new Map(localNotes.map(n => [n.id, n]))
  let changed = false

  for (const obj of remoteObjects) {
    // Skip objects older than watermark (we already have them)
    if (watermark && obj.lastModified && obj.lastModified <= watermark) continue

    // Extract note ID from key: sync/notes/{id}.enc
    const noteId = obj.key.replace(NOTE_PREFIX, '').replace('.enc', '')
    if (!noteId) continue

    // Skip if this note was deleted
    if (deletedIds.has(noteId)) continue

    try {
      const buf = await downloadObject(s3, obj.key)
      const envelope = await decryptNote(buf, password)
      const remote = envelope.note

      // Restore inlined media into IDB
      for (const m of envelope.media) {
        const existing = await getMedia(m.id)
        if (!existing) {
          const blob = base64ToBlob(m.data, m.mime)
          // Find the matching ref for metadata
          const ref = remote.media.find(r => r.id === m.id)
          const rec: MediaRecord = {
            id: m.id,
            type: ref?.type ?? 'image',
            mime: m.mime,
            blob,
            size: blob.size,
            width: ref?.width,
            height: ref?.height,
            durationMs: ref?.durationMs,
            createdAt: Date.now(),
          }
          await putMedia(rec)
        }
      }

      // Download large media that wasn't inlined
      for (const ref of remote.media) {
        const existing = await getMedia(ref.id)
        if (existing) continue
        // Check if it was inlined
        if (envelope.media.some(m => m.id === ref.id)) continue
        try {
          const mediaBuf = await downloadObject(s3, `${MEDIA_PREFIX}${ref.id}`)
          const blob = new Blob([mediaBuf], { type: ref.mime })
          const rec: MediaRecord = {
            id: ref.id,
            type: ref.type,
            mime: ref.mime,
            blob,
            size: blob.size,
            width: ref.width,
            height: ref.height,
            durationMs: ref.durationMs,
            createdAt: Date.now(),
          }
          await putMedia(rec)
        } catch {
          // Media not found remotely — skip
        }
      }

      // Merge: last-write-wins by updatedAt
      const local = localMap.get(remote.id)
      if (!local || remote.updatedAt > local.updatedAt) {
        localMap.set(remote.id, remote)
        changed = true
      }
    } catch (e) {
      console.warn(`[sync] Failed to pull note ${noteId}:`, e)
    }
  }

  // Process deletions: remove locally any notes the manifest says are deleted
  for (const id of deletedIds) {
    if (localMap.has(id)) {
      localMap.delete(id)
      changed = true
    }
  }

  // Update watermark to the most recent object timestamp
  const latest = remoteObjects
    .map(o => o.lastModified)
    .filter(Boolean)
    .sort()
    .pop()
  if (latest) setWatermark(latest)

  return { merged: Array.from(localMap.values()), changed }
}

// ── Deletion sync ──────────────────────────────────────────────────────────

async function pushDeletion(
  noteId: string,
  password: string,
  s3: S3Config,
): Promise<void> {
  // Load existing manifest
  let existing: string[] = []
  try {
    const buf = await downloadObject(s3, DELETE_KEY)
    const json = await decryptBackup(password, buf)
    existing = JSON.parse(json) as string[]
  } catch {
    // first deletion or decrypt failed
  }

  if (!existing.includes(noteId)) {
    existing.push(noteId)
  }

  const encrypted = await encryptBackup(password, JSON.stringify(existing))
  await uploadBackup(s3, DELETE_KEY, encrypted)

  // Also remove the note object from S3
  try {
    await deleteObject(s3, `${NOTE_PREFIX}${noteId}.enc`)
  } catch {
    // best-effort
  }

  // Clean up pushed map
  const pushed = getPushedMap()
  delete pushed[noteId]
  setPushedMap(pushed)
}

// ── Sync engine ────────────────────────────────────────────────────────────

let syncTimer: ReturnType<typeof setInterval> | null = null
let isSyncing = false

export function isSyncEnabled(): boolean {
  return localStorage.getItem(SYNC_ENABLED_KEY) === '1'
}

export function getSyncPassword(): string {
  return localStorage.getItem(SYNC_PASSWORD_KEY) ?? ''
}

export function enableSync(password: string): void {
  localStorage.setItem(SYNC_ENABLED_KEY, '1')
  localStorage.setItem(SYNC_PASSWORD_KEY, password)
}

export function disableSync(): void {
  localStorage.removeItem(SYNC_ENABLED_KEY)
  localStorage.removeItem(SYNC_PASSWORD_KEY)
  localStorage.removeItem(SYNC_WATERMARK)
  localStorage.removeItem(SYNC_PUSHED_KEY)
  stopSync()
}

export function getLastSyncTime(): number | null {
  const wm = getWatermark()
  if (!wm) return null
  const t = new Date(wm).getTime()
  return Number.isFinite(t) ? t : null
}

export async function syncOnce(
  getNotes: () => Note[],
  onNotesChanged: (notes: Note[]) => void,
  s3: S3Config,
): Promise<void> {
  if (isSyncing) return
  if (!isSyncEnabled()) return
  const password = getSyncPassword()
  if (!password) return

  isSyncing = true
  try {
    // Push local changes first
    const notes = getNotes()
    await pushNotes(notes, password, s3)

    // Then pull remote changes
    const { merged, changed } = await pullNotes(notes, password, s3)
    if (changed) {
      onNotesChanged(merged)
    }
  } finally {
    isSyncing = false
  }
}

export function startSync(
  callbacks: SyncCallbacks,
  s3: S3Config,
  intervalMs = 30_000,
): void {
  stopSync()
  if (!isSyncEnabled()) return

  const run = async () => {
    callbacks.onStatusChange({
      enabled: true,
      status: 'syncing',
      lastSync: getLastSyncTime(),
      error: null,
    })
    try {
      await syncOnce(callbacks.getNotes, callbacks.onNotesChanged, s3)
      callbacks.onStatusChange({
        enabled: true,
        status: 'idle',
        lastSync: Date.now(),
        error: null,
      })
    } catch (e) {
      callbacks.onStatusChange({
        enabled: true,
        status: 'error',
        lastSync: getLastSyncTime(),
        error: (e as Error).message,
      })
    }
  }

  // Run immediately, then on interval
  void run()
  syncTimer = setInterval(() => void run(), intervalMs)
}

export function stopSync(): void {
  if (syncTimer) {
    clearInterval(syncTimer)
    syncTimer = null
  }
}

export async function syncDeleteNote(
  noteId: string,
  s3: S3Config,
): Promise<void> {
  if (!isSyncEnabled()) return
  const password = getSyncPassword()
  if (!password) return
  try {
    await pushDeletion(noteId, password, s3)
  } catch (e) {
    console.warn('[sync] Failed to push deletion:', e)
  }
}

export async function syncPushSingle(
  note: Note,
  s3: S3Config,
): Promise<void> {
  if (!isSyncEnabled()) return
  const password = getSyncPassword()
  if (!password) return
  const deviceId = getDeviceId()
  try {
    const buf = await encryptNote(note, password, deviceId)
    await uploadBackup(s3, `${NOTE_PREFIX}${note.id}.enc`, buf)

    // Upload large media
    for (const ref of note.media) {
      const blob = await getMediaBlob(ref.id)
      if (!blob || blob.size <= 512 * 1024) continue
      const arrayBuf = await blob.arrayBuffer()
      await uploadBackup(s3, `${MEDIA_PREFIX}${ref.id}`, arrayBuf)
    }

    const pushed = getPushedMap()
    pushed[note.id] = note.updatedAt
    setPushedMap(pushed)
  } catch (e) {
    console.warn('[sync] Failed to push note:', e)
  }
}
