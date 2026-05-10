/**
 * Multi-device sync via WebSocket — real-time, E2E encrypted.
 *
 * Architecture:
 *   - Client encrypts notes with AES-256-GCM using the user's sync password.
 *   - Encrypted blobs are sent to the sync server over WebSocket.
 *   - Server adds a second encryption layer and stores in SQLite.
 *   - Real-time: when one device pushes, all others in the same room get
 *     the update instantly via WebSocket broadcast.
 *   - Offline: edits are queued locally and pushed on reconnect.
 *   - Room ID = SHA-256(password) — devices with the same password auto-group.
 *   - Credentials (FB, S3, etc.) NEVER leave the device.
 *
 * The sync password serves dual purpose:
 *   1. Derive AES-256 encryption key (client-side, via PBKDF2)
 *   2. Derive room ID (SHA-256 hash) for server grouping
 */

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
const SYNC_PUSHED_KEY   = 'notes-sync-pushed'      // { [noteId]: updatedAt }
const SYNC_QUEUE_KEY    = 'notes-sync-queue'        // offline queue
const SYNC_LAST_KEY     = 'notes-sync-last'         // last sync timestamp

// ── Public types ───────────────────────────────────────────────────────────

export type SyncStatus = 'idle' | 'syncing' | 'connecting' | 'error' | 'disabled' | 'offline'

export interface SyncState {
  enabled: boolean
  status: SyncStatus
  lastSync: number | null
  error: string | null
  deviceCount: number
}

export interface SyncCallbacks {
  getNotes: () => Note[]
  onNotesChanged: (notes: Note[]) => void
  onNoteUpdated: (note: Note) => void
  onNoteDeleted: (noteId: string) => void
  onStatusChange: (state: SyncState) => void
}

// ── Offline queue ─────────────────────────────────────────────────────────

interface QueueEntry {
  action: 'push-note' | 'delete-note' | 'push-media'
  noteId?: string
  mediaId?: string
  timestamp: number
}

function getQueue(): QueueEntry[] {
  try {
    const raw = localStorage.getItem(SYNC_QUEUE_KEY)
    return raw ? JSON.parse(raw) : []
  } catch { return [] }
}

function setQueue(q: QueueEntry[]): void {
  localStorage.setItem(SYNC_QUEUE_KEY, JSON.stringify(q))
}

function enqueue(entry: QueueEntry): void {
  const q = getQueue()
  // Deduplicate: remove older entries for the same note/media
  const filtered = q.filter(e => {
    if (entry.noteId && e.noteId === entry.noteId && e.action === entry.action) return false
    if (entry.mediaId && e.mediaId === entry.mediaId) return false
    return true
  })
  filtered.push(entry)
  setQueue(filtered)
}

function clearQueue(): void {
  localStorage.removeItem(SYNC_QUEUE_KEY)
}

// ── Helpers ────────────────────────────────────────────────────────────────

function getPushedMap(): Record<string, number> {
  try {
    const raw = localStorage.getItem(SYNC_PUSHED_KEY)
    return raw ? JSON.parse(raw) : {}
  } catch { return {} }
}

function setPushedMap(m: Record<string, number>): void {
  localStorage.setItem(SYNC_PUSHED_KEY, JSON.stringify(m))
}

async function deriveRoomId(password: string): Promise<string> {
  const data = new TextEncoder().encode(password)
  const hash = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('')
}

// ── Encrypted note envelope ────────────────────────────────────────────────

interface NoteEnvelope {
  note: Note
  media: { id: string; mime: string; data: string }[]  // base64 media inlined
}

async function encryptNote(note: Note, password: string): Promise<ArrayBuffer> {
  // Inline small media (< 512 KB) for atomic sync
  const inlinedMedia: NoteEnvelope['media'] = []
  for (const ref of note.media) {
    const blob = await getMediaBlob(ref.id)
    if (!blob) continue
    if (blob.size <= 512 * 1024) {
      inlinedMedia.push({ id: ref.id, mime: ref.mime, data: await blobToBase64(blob) })
    }
  }
  const envelope: NoteEnvelope = { note, media: inlinedMedia }
  return encryptBackup(password, JSON.stringify(envelope))
}

async function decryptNoteEnvelope(data: ArrayBuffer, password: string): Promise<NoteEnvelope> {
  const json = await decryptBackup(password, data)
  return JSON.parse(json) as NoteEnvelope
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let bin = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(bin)
}

function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes.buffer as ArrayBuffer
}

// ── Restore media from envelope into IDB ──────────────────────────────────

async function restoreEnvelopeMedia(envelope: NoteEnvelope): Promise<void> {
  const note = envelope.note
  // Restore inlined media
  for (const m of envelope.media) {
    const existing = await getMedia(m.id)
    if (existing) continue
    const blob = base64ToBlob(m.data, m.mime)
    const ref = note.media.find(r => r.id === m.id)
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

// ── WebSocket sync engine ─────────────────────────────────────────────────

let ws: WebSocket | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let callbacks: SyncCallbacks | null = null
let currentState: SyncState = {
  enabled: false,
  status: 'disabled',
  lastSync: null,
  error: null,
  deviceCount: 0,
}

function updateState(patch: Partial<SyncState>): void {
  currentState = { ...currentState, ...patch }
  callbacks?.onStatusChange(currentState)
}

function getWsUrl(): string {
  const loc = window.location
  const proto = loc.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${loc.host}/ws`
}

async function connect(): Promise<void> {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return

  const password = getSyncPassword()
  if (!password) return

  const roomId = await deriveRoomId(password)

  updateState({ status: 'connecting', error: null })

  try {
    ws = new WebSocket(getWsUrl())
  } catch (e) {
    updateState({ status: 'offline', error: (e as Error).message })
    scheduleReconnect()
    return
  }

  ws.onopen = () => {
    ws!.send(JSON.stringify({ type: 'join', roomId }))
  }

  ws.onmessage = async (event) => {
    try {
      const msg = JSON.parse(typeof event.data === 'string' ? event.data : '')
      await handleServerMessage(msg)
    } catch (e) {
      console.warn('[sync] Failed to handle message:', e)
    }
  }

  ws.onclose = () => {
    ws = null
    if (isSyncEnabled()) {
      updateState({ status: 'offline', deviceCount: 0 })
      scheduleReconnect()
    }
  }

  ws.onerror = () => {
    // onclose will fire after this
  }
}

function scheduleReconnect(): void {
  if (reconnectTimer) clearTimeout(reconnectTimer)
  if (!isSyncEnabled()) return
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    connect().catch(() => {})
  }, 5000)
}

async function handleServerMessage(msg: Record<string, unknown>): Promise<void> {
  const password = getSyncPassword()
  if (!password) return

  switch (msg.type) {
    case 'welcome': {
      updateState({
        status: 'idle',
        deviceCount: msg.deviceCount as number,
        error: null,
      })
      // Flush offline queue
      await flushQueue()
      // Push all local notes that the server might not have
      await pushAllNotes()
      break
    }

    case 'sync': {
      // Full sync response — merge all notes
      const remoteNotes = msg.notes as { noteId: string; data: string; updatedAt: number }[]
      const deletions = msg.deletions as { noteId: string; deletedAt: number }[]

      const localNotes = callbacks?.getNotes() ?? []
      const localMap = new Map(localNotes.map(n => [n.id, n]))
      const deletedIds = new Set(deletions.map(d => d.noteId))
      let changed = false

      for (const rn of remoteNotes) {
        if (deletedIds.has(rn.noteId)) continue
        try {
          const buf = base64ToArrayBuffer(rn.data)
          const envelope = await decryptNoteEnvelope(buf, password)
          await restoreEnvelopeMedia(envelope)

          // Request large media from server
          for (const ref of envelope.note.media) {
            if (envelope.media.some(m => m.id === ref.id)) continue
            const existing = await getMedia(ref.id)
            if (!existing) requestMedia(ref.id)
          }

          const local = localMap.get(envelope.note.id)
          if (!local || rn.updatedAt > local.updatedAt) {
            localMap.set(envelope.note.id, envelope.note)
            changed = true
          }
        } catch (e) {
          console.warn(`[sync] Failed to decrypt note ${rn.noteId}:`, e)
        }
      }

      // Process deletions
      for (const d of deletions) {
        if (localMap.has(d.noteId)) {
          localMap.delete(d.noteId)
          changed = true
        }
      }

      if (changed) {
        callbacks?.onNotesChanged(Array.from(localMap.values()))
      }

      updateState({ lastSync: Date.now() })
      localStorage.setItem(SYNC_LAST_KEY, String(Date.now()))
      break
    }

    case 'note-update': {
      // Real-time update from another device
      const data = msg.data as string
      const updatedAt = msg.updatedAt as number
      try {
        const buf = base64ToArrayBuffer(data)
        const envelope = await decryptNoteEnvelope(buf, password)
        await restoreEnvelopeMedia(envelope)

        // Request large media
        for (const ref of envelope.note.media) {
          if (envelope.media.some(m => m.id === ref.id)) continue
          const existing = await getMedia(ref.id)
          if (!existing) requestMedia(ref.id)
        }

        const localNotes = callbacks?.getNotes() ?? []
        const existing = localNotes.find(n => n.id === envelope.note.id)
        if (!existing || updatedAt > existing.updatedAt) {
          callbacks?.onNoteUpdated(envelope.note)
        }
      } catch (e) {
        console.warn('[sync] Failed to process real-time update:', e)
      }
      updateState({ lastSync: Date.now() })
      localStorage.setItem(SYNC_LAST_KEY, String(Date.now()))
      break
    }

    case 'note-deleted': {
      const noteId = msg.noteId as string
      callbacks?.onNoteDeleted(noteId)
      updateState({ lastSync: Date.now() })
      localStorage.setItem(SYNC_LAST_KEY, String(Date.now()))
      break
    }

    case 'media-data': {
      const mediaId = msg.mediaId as string
      const data = msg.data as string
      try {
        const buf = base64ToArrayBuffer(data)
        const blob = new Blob([buf])
        // We don't have full metadata here; store with minimal info
        const existing = await getMedia(mediaId)
        if (!existing) {
          const rec: MediaRecord = {
            id: mediaId,
            type: 'image',
            mime: blob.type || 'application/octet-stream',
            blob,
            size: blob.size,
            createdAt: Date.now(),
          }
          await putMedia(rec)
        }
      } catch (e) {
        console.warn(`[sync] Failed to store media ${mediaId}:`, e)
      }
      break
    }

    case 'device-joined':
    case 'device-left': {
      // Re-request device count isn't sent with these messages,
      // just adjust optimistically
      const delta = msg.type === 'device-joined' ? 1 : -1
      updateState({ deviceCount: Math.max(1, currentState.deviceCount + delta) })
      break
    }

    case 'error': {
      console.warn('[sync] Server error:', msg.message)
      break
    }
  }
}

function requestMedia(mediaId: string): void {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'pull-media', mediaId }))
  }
}

// ── Push operations ───────────────────────────────────────────────────────

async function pushNote(note: Note): Promise<void> {
  const password = getSyncPassword()
  if (!password) return

  const buf = await encryptNote(note, password)
  const b64 = arrayBufferToBase64(buf)

  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: 'push-note',
      noteId: note.id,
      data: b64,
      updatedAt: note.updatedAt,
    }))

    // Push large media separately
    for (const ref of note.media) {
      const blob = await getMediaBlob(ref.id)
      if (!blob || blob.size <= 512 * 1024) continue // inlined
      const mediaBuf = await blob.arrayBuffer()
      const mediaB64 = arrayBufferToBase64(mediaBuf)
      ws.send(JSON.stringify({ type: 'push-media', mediaId: ref.id, data: mediaB64 }))
    }

    const pushed = getPushedMap()
    pushed[note.id] = note.updatedAt
    setPushedMap(pushed)
  } else {
    // Offline — queue it
    enqueue({ action: 'push-note', noteId: note.id, timestamp: Date.now() })
  }
}

async function pushAllNotes(): Promise<void> {
  if (!callbacks) return
  const notes = callbacks.getNotes()
  const pushed = getPushedMap()

  for (const note of notes) {
    if (pushed[note.id] === note.updatedAt) continue
    await pushNote(note)
  }
}

async function flushQueue(): Promise<void> {
  if (!callbacks || ws?.readyState !== WebSocket.OPEN) return
  const password = getSyncPassword()
  if (!password) return

  const queue = getQueue()
  if (!queue.length) return

  const notes = callbacks.getNotes()
  const noteMap = new Map(notes.map(n => [n.id, n]))

  for (const entry of queue) {
    try {
      if (entry.action === 'push-note' && entry.noteId) {
        const note = noteMap.get(entry.noteId)
        if (note) await pushNote(note)
      } else if (entry.action === 'delete-note' && entry.noteId) {
        ws!.send(JSON.stringify({
          type: 'delete-note',
          noteId: entry.noteId,
          deletedAt: entry.timestamp,
        }))
      }
    } catch (e) {
      console.warn('[sync] Failed to flush queue entry:', e)
    }
  }

  clearQueue()
}

// ── Public API ────────────────────────────────────────────────────────────

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
  localStorage.removeItem(SYNC_PUSHED_KEY)
  localStorage.removeItem(SYNC_QUEUE_KEY)
  localStorage.removeItem(SYNC_LAST_KEY)
  stopSync()
}

export function getLastSyncTime(): number | null {
  const raw = localStorage.getItem(SYNC_LAST_KEY)
  if (!raw) return null
  const t = parseInt(raw, 10)
  return Number.isFinite(t) ? t : null
}

export function startSync(cbs: SyncCallbacks): void {
  stopSync()
  if (!isSyncEnabled()) return
  callbacks = cbs
  updateState({ enabled: true, status: 'connecting' })
  connect().catch(() => {})
}

export function stopSync(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  if (ws) {
    ws.onclose = null // prevent reconnect
    ws.close()
    ws = null
  }
  callbacks = null
  updateState({ enabled: false, status: 'disabled', deviceCount: 0, error: null })
}

export async function syncPushSingle(note: Note): Promise<void> {
  if (!isSyncEnabled()) return
  await pushNote(note)
}

export async function syncDeleteNote(noteId: string): Promise<void> {
  if (!isSyncEnabled()) return

  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: 'delete-note',
      noteId,
      deletedAt: Date.now(),
    }))
  } else {
    enqueue({ action: 'delete-note', noteId, timestamp: Date.now() })
  }

  // Clean pushed map
  const pushed = getPushedMap()
  delete pushed[noteId]
  setPushedMap(pushed)
}

export async function triggerSync(): Promise<void> {
  if (!isSyncEnabled()) return

  if (ws?.readyState === WebSocket.OPEN) {
    // Request full sync from server
    ws.send(JSON.stringify({ type: 'pull', since: 0 }))
    await pushAllNotes()
  } else {
    // Try to reconnect
    await connect()
  }
}
