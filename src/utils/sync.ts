/**
 * Ephemeral Relay Sync — cursor-based, zero server persistence.
 *
 * Architecture:
 *   - Server is a mailbox, not a vault. Data exists only until all devices ACK.
 *   - Each device has a unique ID and a cursor (last consumed sequence number).
 *   - Operations (encrypted note changes) are appended to a log on the server.
 *   - Server deletes ops once all active device cursors have passed them.
 *   - New devices receive their initial data from another device via peer transfer
 *     (server-relayed, requires approval from an existing device).
 *   - Conflict resolution: LWW per note + conflict copies for close-timestamp divergence.
 *
 * Flow:
 *   New user → POST /api/sync-code/generate → receives sync code + token
 *   Existing user → POST /api/sync-code/validate → verifies code + gets token
 *   Both → WebSocket join with { roomId, token, deviceId, deviceName }
 *   New device (no data) → request-transfer → wait approval → receive chunks
 *   Existing device → receive pending ops → push local changes
 */

import { encryptBackup, decryptBackup } from './crypto'
import {
  getMedia,
  putMedia,
  getMediaBlob,
  blobToBase64,
  base64ToBlob,
  addToGallery,
  removeFromGallery,
  type MediaRecord,
} from './media'
import type { Note, GalleryItem, MediaRef } from '../types'
import { secureGet, secureSet } from './vault'

// ── Config / persistence keys ──────────────────────────────────────────────

const SYNC_ENABLED_KEY   = 'notes-sync-enabled'
const SYNC_CODE_KEY      = 'notes-sync-code'
const SYNC_ROOM_KEY      = 'notes-sync-room'
const SYNC_TOKEN_KEY     = 'notes-sync-token'
const SYNC_DEVICE_ID_KEY = 'notes-sync-device-id'
const SYNC_DEVICE_NAME_KEY = 'notes-sync-device-name'
const SYNC_CURSOR_KEY    = 'notes-sync-cursor'
const SYNC_QUEUE_KEY     = 'notes-sync-queue'
const SYNC_LAST_KEY      = 'notes-sync-last'
const SYNC_TOMBSTONES_KEY = 'notes-sync-tombstones'

// How long to keep tombstones around. A device that's been offline longer
// than this and then re-broadcasts an old note will be allowed to resurrect
// it — which is the right trade-off (we can't keep tombstones forever).
const TOMBSTONE_TTL_MS = 90 * 24 * 60 * 60 * 1000 // 90 days

// Legacy keys — used for migration
const SYNC_PASSWORD_KEY  = 'notes-sync-password'
const SYNC_PUSHED_KEY    = 'notes-sync-pushed'

// ── Constants ─────────────────────────────────────────────────────────────

// Largest per-blob size we will sync. Compressed photos (2048px WebP) and
// short clips fit comfortably; very large videos are intentionally excluded
// from sync to keep relay payloads bounded (the WS relay caps frames at 16MB).
// The previous 512KB cap silently dropped most attachments — including
// ordinary photos — so notes synced as text with broken image refs.
const MAX_SYNC_MEDIA_BYTES = 5 * 1024 * 1024 // 5 MB

// Target encoded size per initial-transfer chunk. Notes are grouped up to this
// budget (with their inlined media) so a single chunk never approaches the
// relay's 16MB frame limit even after base64 inflation.
const TRANSFER_CHUNK_BUDGET_BYTES = 3 * 1024 * 1024 // 3 MB

// ── Public types ───────────────────────────────────────────────────────────

export type SyncStatus = 'idle' | 'syncing' | 'connecting' | 'error' | 'disabled' | 'offline' | 'transferring' | 'awaiting-source'

export interface SyncDevice {
  deviceId: string
  deviceName: string
  online: boolean
  lastSeenAt?: number
  isSelf: boolean
}

export interface SyncState {
  enabled: boolean
  status: SyncStatus
  lastSync: number | null
  error: string | null
  deviceCount: number
  devices: SyncDevice[]
  selfDeviceId: string | null
  needsTransfer: boolean
  /** When a chosen transfer source is currently offline. */
  awaitingDeviceId: string | null
  awaitingDeviceName: string | null
  transferProgress?: { current: number; total: number }
  pendingTransfer?: { transferId: number; requesterId: string; requesterName: string }
}

export interface SyncCallbacks {
  getNotes: () => Note[]
  onNotesChanged: (notes: Note[]) => void
  onNoteUpdated: (note: Note) => void
  onNoteDeleted: (noteId: string) => void
  onStatusChange: (state: SyncState) => void
  onTransferRequest?: (request: { transferId: number; requesterName: string }) => void
  // Gallery callbacks (optional — only wired when gallery feature is mounted)
  getGalleryItems?: () => GalleryItem[]
  onGalleryItemAdded?: (item: GalleryItem) => void
  onGalleryItemRemoved?: (id: string) => void
}

// ── Operation types (encrypted payloads contain these) ────────────────────

interface OpNoteUpdate {
  type: 'note-update'
  noteId: string
  note: Note
  media: { id: string; mime: string; data: string }[]
  updatedAt: number
}

interface OpNoteDelete {
  type: 'note-delete'
  noteId: string
  deletedAt: number
}

interface OpGalleryAdd {
  type: 'gallery-add'
  id: string
  item: GalleryItem
  mediaData: { id: string; mime: string; data: string } | null
  createdAt: number
}

interface OpGalleryRemove {
  type: 'gallery-remove'
  id: string
  removedAt: number
}

type SyncOp = OpNoteUpdate | OpNoteDelete | OpGalleryAdd | OpGalleryRemove

// ── Device ID management ─────────────────────────────────────────────────

function getDeviceId(): string {
  let id = localStorage.getItem(SYNC_DEVICE_ID_KEY)
  if (!id) {
    id = crypto.randomUUID()
    localStorage.setItem(SYNC_DEVICE_ID_KEY, id)
  }
  return id
}

function getDeviceName(): string {
  let name = localStorage.getItem(SYNC_DEVICE_NAME_KEY)
  if (!name) {
    // Auto-detect device name
    const ua = navigator.userAgent
    if (/iPhone/.test(ua)) name = 'iPhone'
    else if (/iPad/.test(ua)) name = 'iPad'
    else if (/Android/.test(ua)) name = 'Android'
    else if (/Mac/.test(ua)) name = 'Mac'
    else if (/Windows/.test(ua)) name = 'Windows PC'
    else if (/Linux/.test(ua)) name = 'Linux'
    else name = 'Device'
    localStorage.setItem(SYNC_DEVICE_NAME_KEY, name)
  }
  return name
}

export function setDeviceName(name: string): void {
  localStorage.setItem(SYNC_DEVICE_NAME_KEY, name)
}

// ── Cursor management ────────────────────────────────────────────────────

function getCursor(): number {
  const raw = localStorage.getItem(SYNC_CURSOR_KEY)
  return raw ? parseInt(raw, 10) : 0
}

function setCursor(cursor: number): void {
  localStorage.setItem(SYNC_CURSOR_KEY, String(cursor))
}

// ── Tombstones ────────────────────────────────────────────────────────────
//
// When a note is deleted we record { noteId -> deletedAt }. Any incoming
// note-update with updatedAt <= deletedAt is dropped, which prevents a
// peer that hasn't yet seen our delete from resurrecting the note. Without
// this, deleting old "[Conflict Copy]" duplicates was futile: every other
// device would just re-upload them on its next reconnect.

type TombstoneMap = Record<string, number>

function loadTombstones(): TombstoneMap {
  try {
    const raw = localStorage.getItem(SYNC_TOMBSTONES_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as TombstoneMap
    // Garbage-collect stale entries
    const cutoff = Date.now() - TOMBSTONE_TTL_MS
    let mutated = false
    for (const id of Object.keys(parsed)) {
      if (parsed[id] < cutoff) { delete parsed[id]; mutated = true }
    }
    if (mutated) localStorage.setItem(SYNC_TOMBSTONES_KEY, JSON.stringify(parsed))
    return parsed
  } catch { return {} }
}

function recordTombstone(noteId: string, deletedAt: number): void {
  const map = loadTombstones()
  if ((map[noteId] ?? 0) < deletedAt) {
    map[noteId] = deletedAt
    localStorage.setItem(SYNC_TOMBSTONES_KEY, JSON.stringify(map))
  }
}

function isTombstoned(noteId: string, updatedAt: number): boolean {
  const map = loadTombstones()
  const t = map[noteId]
  return typeof t === 'number' && updatedAt <= t
}

// ── Offline queue ─────────────────────────────────────────────────────────

interface QueueEntry {
  op: SyncOp
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
  // Deduplicate: remove older entries for the same note
  const noteId = 'noteId' in entry.op ? entry.op.noteId : undefined
  const filtered = q.filter(e => {
    if (noteId && 'noteId' in e.op && e.op.noteId === noteId) return false
    return true
  })
  filtered.push(entry)
  setQueue(filtered)
}

function clearQueue(): void {
  localStorage.removeItem(SYNC_QUEUE_KEY)
}

// ── Helpers ────────────────────────────────────────────────────────────────

function normalizeSyncCode(input: string): string {
  return input.replace(/[-\s]/g, '')
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

// ── Encrypt/decrypt operations ───────────────────────────────────────────

async function encryptOp(op: SyncOp, syncCode: string): Promise<string> {
  const buf = await encryptBackup(syncCode, JSON.stringify(op))
  return arrayBufferToBase64(buf)
}

async function decryptOp(payloadB64: string, syncCode: string): Promise<SyncOp> {
  const buf = base64ToArrayBuffer(payloadB64)
  const json = await decryptBackup(syncCode, buf)
  return JSON.parse(json) as SyncOp
}

// ── Build operation from a note ──────────────────────────────────────────

async function buildNoteUpdateOp(note: Note): Promise<OpNoteUpdate> {
  const inlinedMedia: OpNoteUpdate['media'] = []
  for (const ref of note.media) {
    const blob = await getMediaBlob(ref.id)
    if (!blob) continue
    if (blob.size <= MAX_SYNC_MEDIA_BYTES) {
      inlinedMedia.push({ id: ref.id, mime: ref.mime, data: await blobToBase64(blob) })
    }
  }
  return {
    type: 'note-update',
    noteId: note.id,
    note,
    media: inlinedMedia,
    updatedAt: note.updatedAt,
  }
}

// ── Restore media from operation / transfer ──────────────────────────────

/**
 * Restore a batch of inlined media blobs into IndexedDB, skipping any that
 * already exist locally. `refNotes` supplies the MediaRef metadata (type,
 * dimensions) for each blob so restored records carry their original shape.
 */
async function restoreMediaList(
  media: { id: string; mime: string; data: string }[],
  refNotes: Note[],
): Promise<void> {
  if (!media.length) return
  const refById = new Map<string, MediaRef>()
  for (const note of refNotes) {
    for (const ref of note.media) refById.set(ref.id, ref)
  }
  for (const m of media) {
    const existing = await getMedia(m.id)
    if (existing) continue
    const blob = base64ToBlob(m.data, m.mime)
    const ref = refById.get(m.id)
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

async function restoreOpMedia(op: OpNoteUpdate): Promise<void> {
  await restoreMediaList(op.media, [op.note])
}

// ── Conflict resolution ──────────────────────────────────────────────────
//
// We use pure last-writer-wins (LWW) on `updatedAt`. The previous
// implementation generated a "conflict copy" whenever an incoming op was
// within a 5-minute wall-clock window of the local note and the bodies
// differed. That heuristic could not distinguish a true concurrent edit
// from a stale re-push, so reconnect storms (mobile networks, etc.) would
// reliably produce duplicate notes. A correct conflict detector requires a
// per-note "last synced version" marker; until that is implemented, LWW is
// the safer default for a personal notes app.

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
  devices: [],
  selfDeviceId: null,
  needsTransfer: false,
  awaitingDeviceId: null,
  awaitingDeviceName: null,
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

async function getJoinToken(): Promise<{ roomId: string; token: string } | null> {
  const syncCode = getSyncCode()
  if (!syncCode) return null

  const cachedToken = localStorage.getItem(SYNC_TOKEN_KEY)
  const cachedRoom = localStorage.getItem(SYNC_ROOM_KEY)
  if (cachedToken && cachedRoom) {
    return { roomId: cachedRoom, token: cachedToken }
  }

  try {
    const resp = await fetch(getApiUrl('/api/sync-code/validate'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ syncCode: normalizeSyncCode(syncCode) }),
    })

    if (resp.status === 429) {
      const data = await resp.json() as { error: string; retryAfter?: number }
      throw new Error(data.error || 'Rate limited')
    }

    if (!resp.ok) {
      throw new Error('Invalid sync code')
    }

    const data = await resp.json() as { roomId: string; token: string }
    localStorage.setItem(SYNC_TOKEN_KEY, data.token)
    localStorage.setItem(SYNC_ROOM_KEY, data.roomId)
    return data
  } catch (e) {
    console.warn('[sync] Failed to validate sync code:', e)
    return null
  }
}

async function refreshJoinToken(): Promise<{ roomId: string; token: string } | null> {
  localStorage.removeItem(SYNC_TOKEN_KEY)
  return getJoinToken()
}

// Build the `join` payload. `hasData` tells the server whether this device
// already holds notes locally. The server can't inspect our (E2E-encrypted)
// data, so without this hint it inferred "new device" purely from cursor === 0
// — which wrongly flagged the device that *generated* the sync code (and owns
// all the notes, but hasn't pushed any ops yet, so cursor is still 0) as a
// device needing a transfer. That left both devices stuck on "Choose a source
// device" with neither ever showing the approval prompt. A device that has
// local notes is a source/approver, never a transfer requester.
function buildJoinPayload(roomId: string, token: string): string {
  return JSON.stringify({
    type: 'join',
    roomId,
    token,
    deviceId: getDeviceId(),
    deviceName: getDeviceName(),
    hasData: (callbacks?.getNotes()?.length ?? 0) > 0,
  })
}

async function connect(): Promise<void> {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return

  const syncCode = getSyncCode()
  if (!syncCode) return

  updateState({ status: 'connecting', error: null })

  const joinInfo = await getJoinToken()
  if (!joinInfo) {
    updateState({ status: 'error', error: 'Failed to authenticate sync code' })
    scheduleReconnect()
    return
  }

  const { roomId, token } = joinInfo

  try {
    ws = new WebSocket(getWsUrl())
  } catch (e) {
    updateState({ status: 'offline', error: (e as Error).message })
    scheduleReconnect()
    return
  }

  ws.onopen = () => {
    ws!.send(buildJoinPayload(roomId, token))
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
  const syncCode = getSyncCode()
  if (!syncCode) return

  switch (msg.type) {
    case 'welcome': {
      const needsTransfer = msg.needsTransfer as boolean
      const cursor = msg.cursor as number
      const selfId = (msg.selfDeviceId as string) || getDeviceId()
      const rawDevices = (msg.devices as Array<{
        deviceId: string; deviceName: string; online?: boolean; lastSeenAt?: number
      }>) || []
      const devices: SyncDevice[] = rawDevices.map(d => ({
        deviceId: d.deviceId,
        deviceName: d.deviceName,
        online: d.online ?? (d.deviceId === selfId),
        lastSeenAt: d.lastSeenAt,
        isSelf: d.deviceId === selfId,
      }))

      updateState({
        status: needsTransfer ? 'awaiting-source' : 'idle',
        deviceCount: msg.deviceCount as number,
        devices,
        selfDeviceId: selfId,
        needsTransfer,
        error: null,
      })

      // Update local cursor from server
      if (cursor > getCursor()) {
        setCursor(cursor)
      }

      if (!needsTransfer) {
        // Existing device — flush anything queued while offline. Do NOT
        // re-push the full note set: live edits are already pushed via
        // syncPushSingle, offline edits are in the queue, and brand-new
        // peers receive data through the transfer flow. Re-broadcasting
        // every note on every reconnect was the main source of duplicate
        // "conflict copy" notes.
        await flushQueue()
      }
      // New devices wait for the user to pick a source device explicitly
      // (handled by UI calling requestTransferFromDevice).
      break
    }

    case 'ops': {
      // Batch of operations from the server (catch-up)
      const entries = msg.entries as { seq: number; payload: string; deviceId: string; createdAt: number }[]
      if (!entries || entries.length === 0) break

      let maxSeq = getCursor()
      for (const entry of entries) {
        // Skip ops from ourselves
        if (entry.deviceId === getDeviceId()) {
          maxSeq = Math.max(maxSeq, entry.seq)
          continue
        }
        await applyRemoteOp(entry.payload, syncCode)
        maxSeq = Math.max(maxSeq, entry.seq)
      }

      // ACK the highest sequence we processed
      setCursor(maxSeq)
      ws?.send(JSON.stringify({ type: 'ack', cursor: maxSeq }))

      updateState({ lastSync: Date.now() })
      localStorage.setItem(SYNC_LAST_KEY, String(Date.now()))
      break
    }

    case 'op-broadcast': {
      // Real-time operation from another device
      const seq = msg.seq as number
      const payloadB64 = msg.payload as string
      const fromDevice = msg.deviceId as string

      if (fromDevice === getDeviceId()) break

      await applyRemoteOp(payloadB64, syncCode)

      // Update cursor and ACK
      setCursor(seq)
      ws?.send(JSON.stringify({ type: 'ack', cursor: seq }))

      updateState({ lastSync: Date.now() })
      localStorage.setItem(SYNC_LAST_KEY, String(Date.now()))
      break
    }

    case 'ack': {
      // Server confirmed our push
      const cursor = msg.cursor as number
      setCursor(cursor)
      break
    }

    case 'transfer-pending': {
      // Our transfer request is pending approval
      void (msg.transferId as number)
      updateState({ status: 'transferring', transferProgress: { current: 0, total: 0 } })
      break
    }

    case 'transfer-requested': {
      // Another device wants our notes — notify the UI for approval
      const transferId = msg.transferId as number
      const requesterName = msg.requesterName as string
      const requesterId = msg.requesterId as string

      updateState({
        pendingTransfer: { transferId, requesterId, requesterName },
      })
      callbacks?.onTransferRequest?.({ transferId, requesterName })
      break
    }

    case 'transfer-approved': {
      // Our transfer request was approved — we'll start receiving chunks
      updateState({ status: 'transferring', transferProgress: { current: 0, total: 0 } })
      break
    }

    case 'transfer-denied': {
      // Transfer was denied
      updateState({ status: 'idle', error: 'Transfer denied by the other device', transferProgress: undefined })
      break
    }

    case 'transfer-chunk': {
      // Receiving a chunk of notes from the approver
      const chunkIndex = msg.chunkIndex as number
      const totalChunks = msg.totalChunks as number
      const chunk = msg.chunk as string
      const transferId = msg.transferId as number

      updateState({ transferProgress: { current: chunkIndex + 1, total: totalChunks } })

      // Decrypt and apply the chunk
      try {
        const decrypted = await decryptBackup(syncCode, base64ToArrayBuffer(chunk))
        const parsed = JSON.parse(decrypted) as
          | Note[]
          | { notes: Note[]; media: { id: string; mime: string; data: string }[] }

        // Backward-compatible: legacy approvers sent a bare Note[] with no
        // media. New approvers send { notes, media } so attachments transfer.
        const notes: Note[] = Array.isArray(parsed) ? parsed : (parsed.notes ?? [])
        const media = Array.isArray(parsed) ? [] : (parsed.media ?? [])

        // Restore the actual media blobs BEFORE merging notes so the UI never
        // renders a note whose attachment blob isn't present yet.
        await restoreMediaList(media, notes)

        const localNotes = callbacks?.getNotes() ?? []
        const localMap = new Map(localNotes.map(n => [n.id, n]))
        for (const note of notes) {
          localMap.set(note.id, note)
        }

        callbacks?.onNotesChanged(Array.from(localMap.values()))
      } catch (e) {
        console.warn('[sync] Failed to process transfer chunk:', e)
      }

      // If this was the last chunk, mark transfer complete
      if (chunkIndex + 1 >= totalChunks) {
        ws?.send(JSON.stringify({ type: 'transfer-complete', transferId }))
        updateState({ status: 'idle', transferProgress: undefined })
        // Any local edits made during the transfer were already pushed
        // live via syncPushSingle (ws was open). Just flush anything that
        // happened to land in the queue.
        await flushQueue()
      }
      break
    }

    case 'transfer-resume': {
      // We're the approver and need to resume sending chunks
      const transferId = msg.transferId as number
      const resumeToken = msg.resumeToken as string
      const startIndex = resumeToken ? parseInt(resumeToken, 10) : 0
      await sendTransferChunks(transferId, startIndex)
      break
    }

    case 'transfer-complete': {
      // Transfer finished (confirmation)
      updateState({ status: 'idle', transferProgress: undefined, pendingTransfer: undefined })
      break
    }

    case 'device-joined': {
      const joinedId = msg.deviceId as string
      const joinedName = (msg.deviceName as string) || 'Device'
      const selfId = currentState.selfDeviceId
      const existing = currentState.devices.find(d => d.deviceId === joinedId)
      let nextDevices: SyncDevice[]
      if (existing) {
        nextDevices = currentState.devices.map(d => d.deviceId === joinedId
          ? { ...d, online: true, deviceName: joinedName, lastSeenAt: Date.now() }
          : d)
      } else {
        nextDevices = [
          ...currentState.devices,
          {
            deviceId: joinedId,
            deviceName: joinedName,
            online: true,
            lastSeenAt: Date.now(),
            isSelf: joinedId === selfId,
          },
        ]
      }
      updateState({
        devices: nextDevices,
        deviceCount: Math.max(1, currentState.deviceCount + (existing ? 0 : 1)),
      })

      // If we were waiting for this specific device to come online, auto-retry.
      if (currentState.awaitingDeviceId === joinedId && ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'request-transfer-from', targetDeviceId: joinedId }))
        updateState({ status: 'transferring', error: null, awaitingDeviceId: null, awaitingDeviceName: null })
      }
      break
    }

    case 'device-left': {
      const leftId = msg.deviceId as string
      const nextDevices = currentState.devices.map(d =>
        d.deviceId === leftId ? { ...d, online: false } : d
      )
      updateState({
        devices: nextDevices,
        deviceCount: Math.max(1, currentState.deviceCount - 1),
      })
      break
    }

    case 'device-removed': {
      const removedId = msg.deviceId as string
      const selfId = currentState.selfDeviceId
      if (removedId === selfId) {
        // We were removed from the sync chain. Disable sync locally.
        disableSync()
        updateState({
          enabled: false,
          status: 'disabled',
          devices: [],
          deviceCount: 0,
          needsTransfer: false,
          error: 'This device was removed from the sync chain.',
        })
      } else {
        updateState({
          devices: currentState.devices.filter(d => d.deviceId !== removedId),
          deviceCount: Math.max(1, currentState.deviceCount - 1),
        })
      }
      break
    }

    case 'transfer-target-offline': {
      const targetId = msg.targetDeviceId as string
      const targetName = (msg.targetDeviceName as string) || 'that device'
      updateState({
        status: 'awaiting-source',
        awaitingDeviceId: targetId,
        awaitingDeviceName: targetName,
        error: null,
      })
      break
    }

    case 'error': {
      const errMsg = msg.message as string
      console.warn('[sync] Server error:', errMsg)

      if (errMsg?.includes('expired') || errMsg?.includes('Invalid or expired token')) {
        console.log('[sync] Token expired, refreshing…')
        const newJoin = await refreshJoinToken()
        if (newJoin && ws?.readyState === WebSocket.OPEN) {
          ws.send(buildJoinPayload(newJoin.roomId, newJoin.token))
        }
      }
      break
    }
  }
}

// ── Apply a remote operation ─────────────────────────────────────────────

async function applyRemoteOp(payloadB64: string, syncCode: string): Promise<void> {
  try {
    const op = await decryptOp(payloadB64, syncCode)

    switch (op.type) {
      case 'note-update': {
        // Drop ops for notes we've already deleted; otherwise a peer that
        // hasn't seen the delete yet would resurrect the note.
        if (isTombstoned(op.noteId, op.updatedAt)) break
        await restoreOpMedia(op)
        const localNotes = callbacks?.getNotes() ?? []
        const existing = localNotes.find(n => n.id === op.noteId)

        if (existing) {
          // Pure last-writer-wins. If the remote op is older than (or
          // equal to) what we have locally, drop it — this is what
          // prevents stale re-pushes from spawning duplicate notes.
          if (op.updatedAt > existing.updatedAt) {
            callbacks?.onNoteUpdated(op.note)
          }
        } else {
          // New note from remote
          callbacks?.onNoteUpdated(op.note)
        }
        break
      }
      case 'note-delete': {
        recordTombstone(op.noteId, op.deletedAt)
        callbacks?.onNoteDeleted(op.noteId)
        break
      }
      case 'gallery-add': {
        // Restore blob if included
        if (op.mediaData) {
          const existing = await getMedia(op.id)
          if (!existing) {
            const blob = base64ToBlob(op.mediaData.data, op.mediaData.mime)
            const rec: MediaRecord = {
              id: op.id,
              type: op.item.type,
              mime: op.mediaData.mime,
              blob,
              size: blob.size,
              width: op.item.width,
              height: op.item.height,
              durationMs: op.item.durationMs,
              createdAt: op.item.createdAt,
            }
            await putMedia(rec)
          }
        }
        // Add to gallery manifest
        await addToGallery(op.item)
        callbacks?.onGalleryItemAdded?.(op.item)
        break
      }
      case 'gallery-remove': {
        await removeFromGallery(op.id)
        callbacks?.onGalleryItemRemoved?.(op.id)
        break
      }
    }
  } catch (e) {
    console.warn('[sync] Failed to apply remote op:', e)
  }
}

// ── Transfer: send chunks to a new device ────────────────────────────────

interface TransferChunkPayload {
  notes: Note[]
  media: { id: string; mime: string; data: string }[]
}

/**
 * Partition notes into size-bounded chunks, inlining each note's media blobs
 * (deduplicated across the whole transfer). Grouping by encoded byte budget —
 * rather than a fixed note count — keeps every chunk under the relay's frame
 * limit regardless of how large individual attachments are.
 */
async function buildTransferChunks(notes: Note[]): Promise<TransferChunkPayload[]> {
  const chunks: TransferChunkPayload[] = []
  const seenMedia = new Set<string>()
  let current: TransferChunkPayload = { notes: [], media: [] }
  let currentBytes = 0

  for (const note of notes) {
    // Collect this note's not-yet-sent media blobs (under the size cap).
    const noteMedia: TransferChunkPayload['media'] = []
    for (const ref of note.media) {
      if (seenMedia.has(ref.id)) continue
      const blob = await getMediaBlob(ref.id)
      if (!blob || blob.size > MAX_SYNC_MEDIA_BYTES) continue
      seenMedia.add(ref.id)
      noteMedia.push({ id: ref.id, mime: ref.mime, data: await blobToBase64(blob) })
    }

    const addedBytes =
      JSON.stringify(note).length + noteMedia.reduce((sum, m) => sum + m.data.length, 0)

    // Flush the current chunk if adding this note would blow the budget
    // (but never produce an empty chunk).
    if (current.notes.length > 0 && currentBytes + addedBytes > TRANSFER_CHUNK_BUDGET_BYTES) {
      chunks.push(current)
      current = { notes: [], media: [] }
      currentBytes = 0
    }

    current.notes.push(note)
    current.media.push(...noteMedia)
    currentBytes += addedBytes
  }

  // Always send at least one chunk so a brand-new device with zero notes still
  // receives a (terminal) chunk and completes the transfer handshake.
  if (current.notes.length > 0 || chunks.length === 0) chunks.push(current)
  return chunks
}

async function sendTransferChunks(transferId: number, startIndex: number = 0): Promise<void> {
  const syncCode = getSyncCode()
  if (!syncCode || !callbacks) return

  const notes = callbacks.getNotes()
  const chunks = await buildTransferChunks(notes)
  const totalChunks = chunks.length

  for (let i = startIndex; i < totalChunks; i++) {
    const encrypted = await encryptBackup(syncCode, JSON.stringify(chunks[i]))
    const chunkB64 = arrayBufferToBase64(encrypted)

    const resumeToken = String(i + 1)

    if (ws?.readyState !== WebSocket.OPEN) break

    ws.send(JSON.stringify({
      type: 'transfer-chunk',
      transferId,
      chunk: chunkB64,
      chunkIndex: i,
      totalChunks,
      resumeToken,
    }))

    // Small delay between chunks to avoid overwhelming the connection
    await new Promise(r => setTimeout(r, 100))
  }
}

// ── Push operations ───────────────────────────────────────────────────────

async function pushOp(op: SyncOp): Promise<void> {
  const syncCode = getSyncCode()
  if (!syncCode) return

  if (ws?.readyState === WebSocket.OPEN) {
    const payloadB64 = await encryptOp(op, syncCode)
    ws.send(JSON.stringify({ type: 'push-op', payload: payloadB64 }))
  } else {
    enqueue({ op, timestamp: Date.now() })
  }
}

async function pushNoteUpdate(note: Note): Promise<void> {
  const op = await buildNoteUpdateOp(note)
  await pushOp(op)
}

async function flushQueue(): Promise<void> {
  if (!callbacks || ws?.readyState !== WebSocket.OPEN) return
  const syncCode = getSyncCode()
  if (!syncCode) return

  const queue = getQueue()
  if (!queue.length) return

  for (const entry of queue) {
    try {
      await pushOp(entry.op)
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

function getApiUrl(path: string): string {
  return `${window.location.origin}${path}`
}

/** Generate a new sync code from the server. */
export async function generateSyncCode(): Promise<{ syncCode: string; roomId: string; token: string }> {
  const resp = await fetch(getApiUrl('/api/sync-code/generate'), { method: 'POST' })
  if (resp.status === 429) {
    const data = await resp.json() as { error: string; retryAfter?: number }
    throw new Error(data.error || 'Rate limited. Please try again later.')
  }
  if (!resp.ok) throw new Error('Failed to generate sync code')
  return resp.json() as Promise<{ syncCode: string; roomId: string; token: string }>
}

/** Validate an existing sync code with the server. */
export async function validateSyncCode(syncCode: string): Promise<{ roomId: string; token: string }> {
  const normalized = normalizeSyncCode(syncCode)
  const resp = await fetch(getApiUrl('/api/sync-code/validate'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ syncCode: normalized }),
  })
  if (resp.status === 429) {
    const data = await resp.json() as { error: string; retryAfter?: number }
    throw new Error(data.error || 'Too many attempts. Please try again later.')
  }
  if (resp.status === 401) {
    throw new Error('Invalid sync code. Please check and try again.')
  }
  if (!resp.ok) throw new Error('Failed to validate sync code')
  return resp.json() as Promise<{ roomId: string; token: string }>
}

// Sync code is cached in memory after vault decrypts it at startup
let cachedSyncCode: string | null = null

export function getSyncCode(): string {
  if (cachedSyncCode !== null) return cachedSyncCode
  return localStorage.getItem(SYNC_CODE_KEY)
    ?? localStorage.getItem(SYNC_PASSWORD_KEY)
    ?? ''
}

export async function loadSyncCode(): Promise<string> {
  let val = await secureGet(SYNC_CODE_KEY)
  if (!val) {
    val = await secureGet(SYNC_PASSWORD_KEY)
    if (val) {
      await secureSet(SYNC_CODE_KEY, val)
    }
  }
  cachedSyncCode = val ?? ''
  return cachedSyncCode
}

// Legacy export for backward compatibility during migration
export function getSyncPassword(): string {
  return getSyncCode()
}

export async function loadSyncPassword(): Promise<string> {
  return loadSyncCode()
}

export function enableSync(syncCode: string, roomId?: string, token?: string): void {
  localStorage.setItem(SYNC_ENABLED_KEY, '1')
  cachedSyncCode = normalizeSyncCode(syncCode)
  secureSet(SYNC_CODE_KEY, cachedSyncCode).catch(() => {})
  if (roomId) localStorage.setItem(SYNC_ROOM_KEY, roomId)
  if (token) localStorage.setItem(SYNC_TOKEN_KEY, token)
}

export function disableSync(): void {
  localStorage.removeItem(SYNC_ENABLED_KEY)
  localStorage.removeItem(SYNC_CODE_KEY)
  localStorage.removeItem(SYNC_PASSWORD_KEY)
  localStorage.removeItem(SYNC_ROOM_KEY)
  localStorage.removeItem(SYNC_TOKEN_KEY)
  localStorage.removeItem(SYNC_CURSOR_KEY)
  localStorage.removeItem(SYNC_PUSHED_KEY)
  localStorage.removeItem(SYNC_QUEUE_KEY)
  localStorage.removeItem(SYNC_LAST_KEY)
  localStorage.removeItem(SYNC_TOMBSTONES_KEY)
  cachedSyncCode = null
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
  loadSyncCode().then(() => connect()).catch(() => {})
}

export function stopSync(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  if (ws) {
    ws.onclose = null
    ws.close()
    ws = null
  }
  callbacks = null
  updateState({
    enabled: false,
    status: 'disabled',
    deviceCount: 0,
    devices: [],
    selfDeviceId: null,
    needsTransfer: false,
    awaitingDeviceId: null,
    awaitingDeviceName: null,
    error: null,
  })
}

export async function syncPushSingle(note: Note): Promise<void> {
  if (!isSyncEnabled()) return
  await pushNoteUpdate(note)
}

export async function syncDeleteNote(noteId: string): Promise<void> {
  if (!isSyncEnabled()) return

  const deletedAt = Date.now()
  recordTombstone(noteId, deletedAt)
  const op: OpNoteDelete = {
    type: 'note-delete',
    noteId,
    deletedAt,
  }
  await pushOp(op)
}

export async function triggerSync(): Promise<void> {
  if (!isSyncEnabled()) return

  if (ws?.readyState === WebSocket.OPEN) {
    // Request ops since our cursor. We deliberately do NOT re-push every
    // local note here — live edits are already pushed via syncPushSingle,
    // and offline edits are in the queue (flushed on welcome). Forcing a
    // full re-broadcast caused stale ops to be re-delivered to peers and
    // generated duplicate notes.
    ws.send(JSON.stringify({ type: 'pull', since: getCursor() }))
    await flushQueue()
  } else {
    await connect()
  }
}

/** Approve a transfer request from another device. */
export async function approveTransfer(transferId: number): Promise<void> {
  if (ws?.readyState !== WebSocket.OPEN) return
  ws.send(JSON.stringify({ type: 'approve-transfer', transferId }))
  // Start sending chunks after a short delay (server will relay)
  setTimeout(() => sendTransferChunks(transferId, 0), 500)
}

/** Deny a transfer request from another device. */
export async function denyTransfer(transferId: number): Promise<void> {
  if (ws?.readyState !== WebSocket.OPEN) return
  ws.send(JSON.stringify({ type: 'deny-transfer', transferId }))
  updateState({ pendingTransfer: undefined })
}

/**
 * Ask a specific device in the sync chain for an initial notes transfer.
 * Used by the new-device onboarding picker.
 */
export async function requestTransferFromDevice(targetDeviceId: string): Promise<void> {
  if (ws?.readyState !== WebSocket.OPEN) {
    updateState({ error: 'Not connected to the sync server. Try again in a moment.' })
    return
  }
  const target = currentState.devices.find(d => d.deviceId === targetDeviceId)
  if (target && !target.online) {
    updateState({
      status: 'awaiting-source',
      awaitingDeviceId: targetDeviceId,
      awaitingDeviceName: target.deviceName,
      error: null,
    })
    return
  }
  updateState({
    status: 'transferring',
    awaitingDeviceId: null,
    awaitingDeviceName: null,
    error: null,
  })
  ws.send(JSON.stringify({ type: 'request-transfer-from', targetDeviceId }))
}

/** Cancel a pending "waiting for device to come online" state. */
export function cancelAwaitingSource(): void {
  updateState({
    status: currentState.needsTransfer ? 'awaiting-source' : 'idle',
    awaitingDeviceId: null,
    awaitingDeviceName: null,
  })
}

/**
 * Remove a device (any device in the sync chain, including this one) from
 * the sync chain. The removed device is force-disconnected on the server.
 */
export async function removeSyncDevice(deviceId: string): Promise<void> {
  if (ws?.readyState !== WebSocket.OPEN) {
    updateState({ error: 'Not connected to the sync server.' })
    return
  }
  ws.send(JSON.stringify({ type: 'remove-device', deviceId }))
}

// ── Gallery sync ──────────────────────────────────────────────────────────

/** Push a gallery-add op when the user adds a photo/video to the gallery. */
export async function syncPushGalleryAdd(item: GalleryItem): Promise<void> {
  if (!isSyncEnabled()) return
  const blob = await getMediaBlob(item.id)
  let mediaData: OpGalleryAdd['mediaData'] = null
  if (blob && blob.size <= MAX_SYNC_MEDIA_BYTES) {
    mediaData = { id: item.id, mime: item.mime, data: await blobToBase64(blob) }
  }
  const op: OpGalleryAdd = {
    type: 'gallery-add',
    id: item.id,
    item,
    mediaData,
    createdAt: item.createdAt,
  }
  await pushOp(op)
}

/** Push a gallery-remove op when a gallery item is used in a note or deleted. */
export async function syncPushGalleryRemove(id: string): Promise<void> {
  if (!isSyncEnabled()) return
  const op: OpGalleryRemove = {
    type: 'gallery-remove',
    id,
    removedAt: Date.now(),
  }
  await pushOp(op)
}
