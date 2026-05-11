/**
 * Sync server — WebSocket + HTTP endpoints.
 *
 * Security model:
 *   - Each user gets a unique, server-generated sync code (48-char base62,
 *     ~143 bits of entropy). The code is used to:
 *       1. Derive the room ID (SHA-256 hash) for grouping devices.
 *       2. Derive the AES-256 encryption key (client-side, PBKDF2) for E2E encryption.
 *   - Sync codes are generated via POST /api/sync-code/generate.
 *   - Clients validate a sync code via POST /api/sync-code/validate before joining.
 *   - Rate limiting protects against brute-force and DDoS attacks.
 *
 * WebSocket protocol (JSON messages):
 *   Client → Server:
 *     { type: 'join',       roomId, token }
 *     { type: 'push-note',  noteId, data (base64), updatedAt }
 *     { type: 'delete-note', noteId, deletedAt }
 *     { type: 'push-media', mediaId, data (base64) }
 *     { type: 'pull',       since }
 *     { type: 'pull-media', mediaId }
 *
 *   Server → Client:
 *     { type: 'welcome',    deviceCount }
 *     { type: 'sync',       notes: [...], deletions: [...] }
 *     { type: 'note-update', noteId, data (base64), updatedAt }
 *     { type: 'note-deleted', noteId, deletedAt }
 *     { type: 'media-data', mediaId, data (base64) }
 *     { type: 'device-joined' }
 *     { type: 'device-left' }
 *     { type: 'error',      message }
 *
 * All `data` fields contain client-encrypted blobs (base64-encoded).
 * The server adds a second encryption layer before storing in SQLite.
 */

import { createServer, type IncomingMessage } from 'node:http'
import { randomBytes, createHash, createHmac } from 'node:crypto'
import { WebSocketServer, WebSocket } from 'ws'
import {
  upsertNote,
  getNotesSince,
  getAllNotes,
  deleteNote,
  getDeletionsSince,
  getAllDeletions,
  putMediaBlob,
  getMediaBlob,
  hasMedia,
  registerSyncCode,
  syncCodeExists,
} from './db.js'

const PORT = parseInt(process.env.SYNC_PORT || '3001', 10)

// ── Sync code generation ─────────────────────────────────────────────────────

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
const SYNC_CODE_LENGTH = 48  // ~143 bits of entropy

function generateSyncCode(): string {
  const bytes = randomBytes(SYNC_CODE_LENGTH)
  let code = ''
  for (let i = 0; i < SYNC_CODE_LENGTH; i++) {
    code += BASE62[bytes[i] % 62]
  }
  return code
}

function formatSyncCode(code: string): string {
  // Group into blocks of 6 for readability: XXXXXX-XXXXXX-XXXXXX-...
  return code.match(/.{1,6}/g)?.join('-') ?? code
}

function normalizeSyncCode(input: string): string {
  // Strip dashes, spaces, and other separators
  return input.replace(/[-\s]/g, '')
}

function deriveRoomId(syncCode: string): string {
  return createHash('sha256').update(syncCode).digest('hex')
}

/** Short-lived join tokens to authenticate WS connections after validation. */
const JOIN_TOKEN_SECRET = process.env.SYNC_SERVER_KEY || randomBytes(32).toString('hex')
const TOKEN_TTL_MS = 60_000 // 60 seconds

function issueJoinToken(roomId: string): string {
  const exp = Date.now() + TOKEN_TTL_MS
  const payload = `${roomId}:${exp}`
  const sig = createHmac('sha256', JOIN_TOKEN_SECRET).update(payload).digest('hex')
  // Base64-encode the full token
  return Buffer.from(`${payload}:${sig}`).toString('base64')
}

function verifyJoinToken(token: string, roomId: string): boolean {
  try {
    const decoded = Buffer.from(token, 'base64').toString()
    const parts = decoded.split(':')
    if (parts.length !== 3) return false
    const [tokenRoomId, expStr, sig] = parts
    const exp = parseInt(expStr, 10)
    if (tokenRoomId !== roomId) return false
    if (Date.now() > exp) return false
    const expectedSig = createHmac('sha256', JOIN_TOKEN_SECRET)
      .update(`${tokenRoomId}:${expStr}`).digest('hex')
    return sig === expectedSig
  } catch {
    return false
  }
}

// ── Rate limiting ────────────────────────────────────────────────────────────

interface RateLimitEntry {
  count: number
  firstRequest: number
  blockedUntil: number
}

const rateLimitMap = new Map<string, RateLimitEntry>()

// Clean up stale entries every 5 minutes
setInterval(() => {
  const now = Date.now()
  for (const [key, entry] of rateLimitMap) {
    if (now - entry.firstRequest > 600_000 && now > entry.blockedUntil) {
      rateLimitMap.delete(key)
    }
  }
}, 300_000)

interface RateLimitConfig {
  windowMs: number     // Time window in ms
  maxRequests: number  // Max requests per window
  blockMs: number      // Block duration after exceeding limit
}

const API_RATE_LIMIT: RateLimitConfig = {
  windowMs: 60_000,     // 1 minute window
  maxRequests: 10,       // 10 requests per minute
  blockMs: 300_000,      // 5 minute block
}

const WS_JOIN_RATE_LIMIT: RateLimitConfig = {
  windowMs: 60_000,
  maxRequests: 5,        // 5 join attempts per minute
  blockMs: 600_000,      // 10 minute block
}

function checkRateLimit(key: string, config: RateLimitConfig): { allowed: boolean; retryAfter?: number } {
  const now = Date.now()
  const entry = rateLimitMap.get(key)

  if (entry && now < entry.blockedUntil) {
    return { allowed: false, retryAfter: Math.ceil((entry.blockedUntil - now) / 1000) }
  }

  if (!entry || now - entry.firstRequest > config.windowMs) {
    rateLimitMap.set(key, { count: 1, firstRequest: now, blockedUntil: 0 })
    return { allowed: true }
  }

  entry.count++
  if (entry.count > config.maxRequests) {
    entry.blockedUntil = now + config.blockMs
    return { allowed: false, retryAfter: Math.ceil(config.blockMs / 1000) }
  }

  return { allowed: true }
}

function getClientIp(req: IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for']
  if (typeof forwarded === 'string') return forwarded.split(',')[0].trim()
  return req.socket.remoteAddress ?? 'unknown'
}

// ── Global request rate limit (DDoS protection) ─────────────────────────────

const GLOBAL_RATE_LIMIT: RateLimitConfig = {
  windowMs: 1_000,      // 1 second window
  maxRequests: 50,       // 50 requests per second per IP
  blockMs: 60_000,       // 1 minute block
}

// ── Room management ──────────────────────────────────────────────────────────

interface Client {
  ws: WebSocket
  roomId: string | null
}

const rooms = new Map<string, Set<Client>>()

function getRoom(roomId: string): Set<Client> {
  let room = rooms.get(roomId)
  if (!room) {
    room = new Set()
    rooms.set(roomId, room)
  }
  return room
}

function broadcast(roomId: string, sender: Client, msg: object): void {
  const payload = JSON.stringify(msg)
  const room = rooms.get(roomId)
  if (!room) return
  for (const client of room) {
    if (client !== sender && client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(payload)
    }
  }
}

function removeClient(client: Client): void {
  if (client.roomId) {
    const room = rooms.get(client.roomId)
    if (room) {
      room.delete(client)
      broadcast(client.roomId, client, { type: 'device-left' })
      if (room.size === 0) rooms.delete(client.roomId)
    }
  }
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk: Buffer) => {
      data += chunk.toString()
      if (data.length > 10_000) {
        req.destroy()
        reject(new Error('Body too large'))
      }
    })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

function jsonResponse(res: import('node:http').ServerResponse, status: number, body: object): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

// ── HTTP server ──────────────────────────────────────────────────────────────

const httpServer = createServer(async (req, res) => {
  const ip = getClientIp(req)

  // Global rate limit check
  const globalCheck = checkRateLimit(`global:${ip}`, GLOBAL_RATE_LIMIT)
  if (!globalCheck.allowed) {
    res.writeHead(429, {
      'Content-Type': 'application/json',
      'Retry-After': String(globalCheck.retryAfter ?? 60),
    })
    res.end(JSON.stringify({ error: 'Too many requests', retryAfter: globalCheck.retryAfter }))
    return
  }

  // ── Health check ─────────────────────────────────────────────
  if (req.url === '/api/health' && req.method === 'GET') {
    jsonResponse(res, 200, { status: 'ok', rooms: rooms.size })
    return
  }

  // ── Generate a new sync code ─────────────────────────────────
  if (req.url === '/api/sync-code/generate' && req.method === 'POST') {
    const rl = checkRateLimit(`gen:${ip}`, API_RATE_LIMIT)
    if (!rl.allowed) {
      res.writeHead(429, { 'Retry-After': String(rl.retryAfter ?? 300) })
      jsonResponse(res, 429, { error: 'Rate limited. Try again later.', retryAfter: rl.retryAfter })
      return
    }

    const syncCode = generateSyncCode()
    const roomId = deriveRoomId(syncCode)

    // Register the room ID in the database
    registerSyncCode(roomId)

    const token = issueJoinToken(roomId)

    jsonResponse(res, 200, {
      syncCode: formatSyncCode(syncCode),
      roomId,
      token,
    })
    return
  }

  // ── Validate an existing sync code ───────────────────────────
  if (req.url === '/api/sync-code/validate' && req.method === 'POST') {
    const rl = checkRateLimit(`val:${ip}`, {
      windowMs: 60_000,
      maxRequests: 5,      // Stricter: only 5 validation attempts per minute
      blockMs: 600_000,    // 10 minute block on abuse
    })
    if (!rl.allowed) {
      res.writeHead(429, { 'Retry-After': String(rl.retryAfter ?? 600) })
      jsonResponse(res, 429, { error: 'Too many attempts. Try again later.', retryAfter: rl.retryAfter })
      return
    }

    try {
      const body = await readBody(req)
      const { syncCode: rawCode } = JSON.parse(body) as { syncCode?: string }
      if (!rawCode || typeof rawCode !== 'string') {
        jsonResponse(res, 400, { error: 'Missing syncCode' })
        return
      }

      const syncCode = normalizeSyncCode(rawCode)
      if (syncCode.length !== SYNC_CODE_LENGTH) {
        jsonResponse(res, 400, { error: 'Invalid sync code.' })
        return
      }

      const roomId = deriveRoomId(syncCode)
      const exists = syncCodeExists(roomId)

      if (!exists) {
        // Intentionally vague error to prevent enumeration
        jsonResponse(res, 401, { error: 'Invalid sync code' })
        return
      }

      const token = issueJoinToken(roomId)
      jsonResponse(res, 200, { valid: true, roomId, token })
    } catch {
      jsonResponse(res, 400, { error: 'Invalid request body' })
    }
    return
  }

  res.writeHead(404)
  res.end()
})

// ── WebSocket server ─────────────────────────────────────────────────────────

const wss = new WebSocketServer({ server: httpServer, path: '/ws' })

wss.on('connection', (ws, req) => {
  const client: Client = { ws, roomId: null }
  const ip = getClientIp(req)

  ws.on('message', (raw) => {
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString())
    } catch {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }))
      return
    }

    try {
      handleMessage(client, msg, ip)
    } catch (e) {
      console.error('[ws] Error handling message:', e)
      ws.send(JSON.stringify({ type: 'error', message: 'Internal error' }))
    }
  })

  ws.on('close', () => removeClient(client))
  ws.on('error', () => removeClient(client))
})

function handleMessage(client: Client, msg: Record<string, unknown>, ip: string): void {
  const { type } = msg

  // ── Join a room ──────────────────────────────────────────────────────────
  if (type === 'join') {
    const roomId = msg.roomId as string
    const token = msg.token as string

    if (!roomId || typeof roomId !== 'string' || roomId.length < 8) {
      client.ws.send(JSON.stringify({ type: 'error', message: 'Invalid roomId' }))
      return
    }

    // Rate limit WebSocket join attempts
    const rl = checkRateLimit(`ws-join:${ip}`, WS_JOIN_RATE_LIMIT)
    if (!rl.allowed) {
      client.ws.send(JSON.stringify({
        type: 'error',
        message: `Too many join attempts. Try again in ${rl.retryAfter}s.`,
      }))
      return
    }

    // Verify the join token
    if (!token || !verifyJoinToken(token, roomId)) {
      client.ws.send(JSON.stringify({ type: 'error', message: 'Invalid or expired token. Re-validate your sync code.' }))
      return
    }

    // Verify room exists in database
    if (!syncCodeExists(roomId)) {
      client.ws.send(JSON.stringify({ type: 'error', message: 'Room not found' }))
      return
    }

    // Leave previous room if any
    removeClient(client)

    client.roomId = roomId
    const room = getRoom(roomId)
    room.add(client)

    // Send welcome with device count
    client.ws.send(JSON.stringify({
      type: 'welcome',
      deviceCount: room.size,
    }))

    // Notify other devices
    broadcast(roomId, client, { type: 'device-joined' })

    // Send full sync (all notes + deletions)
    const notes = getAllNotes(roomId).map(n => ({
      noteId: n.noteId,
      data: n.data.toString('base64'),
      updatedAt: n.updatedAt,
    }))
    const deletions = getAllDeletions(roomId)

    client.ws.send(JSON.stringify({ type: 'sync', notes, deletions }))
    return
  }

  // All other messages require a room
  if (!client.roomId) {
    client.ws.send(JSON.stringify({ type: 'error', message: 'Not in a room. Send { type: "join", roomId, token } first.' }))
    return
  }

  const roomId = client.roomId

  // ── Push a note ──────────────────────────────────────────────────────────
  if (type === 'push-note') {
    const noteId = msg.noteId as string
    const dataB64 = msg.data as string
    const updatedAt = msg.updatedAt as number
    if (!noteId || !dataB64 || !updatedAt) {
      client.ws.send(JSON.stringify({ type: 'error', message: 'Missing fields for push-note' }))
      return
    }

    const buf = Buffer.from(dataB64, 'base64')
    const stored = upsertNote(roomId, noteId, buf, updatedAt)

    if (stored) {
      // Broadcast to other devices in real-time
      broadcast(roomId, client, {
        type: 'note-update',
        noteId,
        data: dataB64,
        updatedAt,
      })
    }
    return
  }

  // ── Delete a note ────────────────────────────────────────────────────────
  if (type === 'delete-note') {
    const noteId = msg.noteId as string
    const deletedAt = (msg.deletedAt as number) || Date.now()
    if (!noteId) {
      client.ws.send(JSON.stringify({ type: 'error', message: 'Missing noteId' }))
      return
    }

    deleteNote(roomId, noteId, deletedAt)
    broadcast(roomId, client, { type: 'note-deleted', noteId, deletedAt })
    return
  }

  // ── Push media ───────────────────────────────────────────────────────────
  if (type === 'push-media') {
    const mediaId = msg.mediaId as string
    const dataB64 = msg.data as string
    if (!mediaId || !dataB64) {
      client.ws.send(JSON.stringify({ type: 'error', message: 'Missing fields for push-media' }))
      return
    }

    // Skip if we already have it
    if (!hasMedia(roomId, mediaId)) {
      putMediaBlob(roomId, mediaId, Buffer.from(dataB64, 'base64'))
    }
    return
  }

  // ── Pull changes since timestamp ─────────────────────────────────────────
  if (type === 'pull') {
    const since = (msg.since as number) || 0

    const notes = getNotesSince(roomId, since).map(n => ({
      noteId: n.noteId,
      data: n.data.toString('base64'),
      updatedAt: n.updatedAt,
    }))
    const deletions = getDeletionsSince(roomId, since)

    client.ws.send(JSON.stringify({ type: 'sync', notes, deletions }))
    return
  }

  // ── Pull a specific media blob ───────────────────────────────────────────
  if (type === 'pull-media') {
    const mediaId = msg.mediaId as string
    if (!mediaId) {
      client.ws.send(JSON.stringify({ type: 'error', message: 'Missing mediaId' }))
      return
    }

    const blob = getMediaBlob(roomId, mediaId)
    if (blob) {
      client.ws.send(JSON.stringify({
        type: 'media-data',
        mediaId,
        data: blob.toString('base64'),
      }))
    } else {
      client.ws.send(JSON.stringify({ type: 'error', message: `Media ${mediaId} not found` }))
    }
    return
  }

  client.ws.send(JSON.stringify({ type: 'error', message: `Unknown message type: ${type}` }))
}

// ── Start ────────────────────────────────────────────────────────────────────

httpServer.listen(PORT, () => {
  console.log(`[sync-server] listening on :${PORT} (ws + http)`)
})

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[sync-server] shutting down…')
  wss.close()
  httpServer.close()
})
