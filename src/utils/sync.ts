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
  type MediaRecord,
} from './media'
import type { Note } from '../types'
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

// Legacy keys — used for migration
const SYNC_PASSWORD_KEY  = 'notes-sync-password'
const SYNC_PUSHED_KEY    = 'notes-sync-pushed'

// ── Constants ─────────────────────────────────────────────────────────────

const CONFLICT_WINDOW_MS = 5 * 60 * 1000 // 5 minutes — conflicts within this window create copies
const TRANSFER_CHUNK_SIZE = 50 // notes per chunk

// ── Public types ───────────────────────────────────────────────────────────

export type SyncStatus = 'idle' | 'syncing' | 'connecting' | 'error' | 'disabled' | 'offline' | 'transferring'

export interface SyncState {
  enabled: boolean
  status: SyncStatus
  lastSync: number | null
  error: string | null
  deviceCount: number
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

type SyncOp = OpNoteUpdate | OpNoteDelete

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
    if (blob.size <= 512 * 1024) {
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

// ── Restore media from operation ─────────────────────────────────────────

async function restoreOpMedia(op: OpNoteUpdate): Promise<void> {
  for (const m of op.media) {
    const existing = await getMedia(m.id)
    if (existing) continue
    const blob = base64ToBlob(m.data, m.mime)
    const ref = op.note.media.find(r => r.id === m.id)
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

// ── Conflict resolution ──────────────────────────────────────────────────

function createConflictCopy(_existingNote: Note, incomingNote: Note): Note {
  // Keep incoming as a separate "conflict copy" note
  const conflictBody = `[Conflict Copy]\n\n${incomingNote.body}`
  return {
    ...incomingNote,
    id: crypto.randomUUID(),
    body: conflictBody,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

function shouldCreateConflictCopy(local: Note, remote: Note): boolean {
  // If timestamps are within the conflict window AND content differs
  if (local.body === remote.body) return false
  const timeDiff = Math.abs(local.updatedAt - remote.updatedAt)
  return timeDiff < CONFLICT_WINDOW_MS
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
    ws!.send(JSON.stringify({
      type: 'join',
      roomId,
      token,
      deviceId: getDeviceId(),
      deviceName: getDeviceName(),
    }))
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

      updateState({
        status: needsTransfer ? 'transferring' : 'idle',
        deviceCount: msg.deviceCount as number,
        error: null,
      })

      // Update local cursor from server
      if (cursor > getCursor()) {
        setCursor(cursor)
      }

      if (needsTransfer) {
        // New device — request transfer from an existing device
        ws?.send(JSON.stringify({ type: 'request-transfer' }))
      } else {
        // Existing device — flush queue and push changes
        await flushQueue()
        await pushAllNotes()
      }
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
        const notes = JSON.parse(decrypted) as Note[]
        const localNotes = callbacks?.getNotes() ?? []
        const localMap = new Map(localNotes.map(n => [n.id, n]))

        for (const note of notes) {
          // Restore media refs
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
        // Now push any local changes we made during transfer
        await pushAllNotes()
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
      const delta = 1
      updateState({ deviceCount: Math.max(1, currentState.deviceCount + delta) })
      break
    }

    case 'device-left': {
      const delta = -1
      updateState({ deviceCount: Math.max(1, currentState.deviceCount + delta) })
      break
    }

    case 'error': {
      const errMsg = msg.message as string
      console.warn('[sync] Server error:', errMsg)

      if (errMsg?.includes('expired') || errMsg?.includes('Invalid or expired token')) {
        console.log('[sync] Token expired, refreshing…')
        const newJoin = await refreshJoinToken()
        if (newJoin && ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: 'join',
            roomId: newJoin.roomId,
            token: newJoin.token,
            deviceId: getDeviceId(),
            deviceName: getDeviceName(),
          }))
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
        await restoreOpMedia(op)
        const localNotes = callbacks?.getNotes() ?? []
        const existing = localNotes.find(n => n.id === op.noteId)

        if (existing) {
          if (shouldCreateConflictCopy(existing, op.note)) {
            // Create conflict copy — keep local as primary, save remote as copy
            const conflictNote = createConflictCopy(existing, op.note)
            callbacks?.onNoteUpdated(conflictNote)
            // Also update the original with the newer version
            if (op.updatedAt > existing.updatedAt) {
              callbacks?.onNoteUpdated(op.note)
            }
          } else if (op.updatedAt > existing.updatedAt) {
            callbacks?.onNoteUpdated(op.note)
          }
          // If local is newer, ignore remote (LWW)
        } else {
          // New note from remote
          callbacks?.onNoteUpdated(op.note)
        }
        break
      }
      case 'note-delete': {
        callbacks?.onNoteDeleted(op.noteId)
        break
      }
    }
  } catch (e) {
    console.warn('[sync] Failed to apply remote op:', e)
  }
}

// ── Transfer: send chunks to a new device ────────────────────────────────

async function sendTransferChunks(transferId: number, startIndex: number = 0): Promise<void> {
  const syncCode = getSyncCode()
  if (!syncCode || !callbacks) return

  const notes = callbacks.getNotes()
  const totalChunks = Math.max(1, Math.ceil(notes.length / TRANSFER_CHUNK_SIZE))

  for (let i = startIndex; i < totalChunks; i++) {
    const chunkNotes = notes.slice(i * TRANSFER_CHUNK_SIZE, (i + 1) * TRANSFER_CHUNK_SIZE)
    const chunkJson = JSON.stringify(chunkNotes)
    const encrypted = await encryptBackup(syncCode, chunkJson)
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

async function pushAllNotes(): Promise<void> {
  if (!callbacks) return
  const notes = callbacks.getNotes()
  for (const note of notes) {
    await pushNoteUpdate(note)
  }
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
  updateState({ enabled: false, status: 'disabled', deviceCount: 0, error: null })
}

export async function syncPushSingle(note: Note): Promise<void> {
  if (!isSyncEnabled()) return
  await pushNoteUpdate(note)
}

export async function syncDeleteNote(noteId: string): Promise<void> {
  if (!isSyncEnabled()) return

  const op: OpNoteDelete = {
    type: 'note-delete',
    noteId,
    deletedAt: Date.now(),
  }
  await pushOp(op)
}

export async function triggerSync(): Promise<void> {
  if (!isSyncEnabled()) return

  if (ws?.readyState === WebSocket.OPEN) {
    // Request ops since our cursor
    ws.send(JSON.stringify({ type: 'pull', since: getCursor() }))
    await pushAllNotes()
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
