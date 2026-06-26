/**
 * Ephemeral Relay Sync Server — WebSocket + HTTP endpoints.
 *
 * Architecture: The server stores NOTHING permanently. It is a mailbox, not a vault.
 * Data exists on the server only as long as the slowest device hasn't synced.
 *
 * Security model:
 *   - Each user gets a unique, server-generated sync code (48-char base62,
 *     ~143 bits of entropy). The code is used to:
 *       1. Derive the room ID (SHA-256 hash) for grouping devices.
 *       2. Derive the AES-256 encryption key (client-side, PBKDF2) for E2E encryption.
 *   - Sync codes are generated via POST /api/sync-code/generate.
 *   - Clients validate a sync code via POST /api/sync-code/validate before joining.
 *   - Rate limiting protects against brute-force and DDoS attacks.
 *   - New devices must receive notes from an existing device (peer transfer with approval).
 *
 * WebSocket protocol (JSON messages):
 *   Client → Server:
 *     { type: 'join',             roomId, token, deviceId, deviceName }
 *     { type: 'push-op',         payload (base64) }
 *     { type: 'ack',             cursor }
 *     { type: 'request-transfer' }
 *     { type: 'approve-transfer', transferId }
 *     { type: 'deny-transfer',   transferId }
 *     { type: 'transfer-chunk',  transferId, chunk (base64), chunkIndex, totalChunks, resumeToken }
 *     { type: 'transfer-resume', transferId, resumeToken }
 *     { type: 'transfer-complete', transferId }
 *
 *   Server → Client:
 *     { type: 'welcome',          deviceCount, cursor, devices, needsTransfer }
 *     { type: 'ops',              entries: [{ seq, payload (base64), deviceId, createdAt }] }
 *     { type: 'op-broadcast',     seq, payload (base64), deviceId }
 *     { type: 'transfer-requested', transferId, requesterId, requesterName }
 *     { type: 'transfer-approved', transferId, approverId }
 *     { type: 'transfer-denied',  transferId }
 *     { type: 'transfer-chunk',   transferId, chunk (base64), chunkIndex, totalChunks, resumeToken }
 *     { type: 'transfer-complete', transferId }
 *     { type: 'device-joined',    deviceId, deviceName }
 *     { type: 'device-left',      deviceId }
 *     { type: 'error',            message }
 *
 * All `payload` fields contain client-encrypted blobs (base64-encoded).
 * The server NEVER decrypts or inspects payloads — it just relays them.
 */

import { createServer, type IncomingMessage } from 'node:http'
import { randomBytes, createHash, createHmac } from 'node:crypto'
import { WebSocketServer, WebSocket } from 'ws'
import {
  registerSyncCode,
  syncCodeExists,
  registerDevice,
  markDeviceInitialized,
  getDevice,
  getDevices,
  updateDeviceCursor,
  touchDevice,
  appendOp,
  getOpsSince,
  getMaxSeq,
  truncateDeliveredOps,
  createTransfer,
  getTransfer,
  getPendingTransfers,
  approveTransfer,
  updateTransferStatus,
  updateTransferResumeToken,
  removeDevice,
  runMaintenance,
} from './db.js'

const PORT = parseInt(process.env.SYNC_PORT || '3001', 10)
const DEVICE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000 // 30 days

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
  return code.match(/.{1,6}/g)?.join('-') ?? code
}

function normalizeSyncCode(input: string): string {
  return input.replace(/[-\s]/g, '')
}

function deriveRoomId(syncCode: string): string {
  return createHash('sha256').update(syncCode).digest('hex')
}

/** Short-lived join tokens to authenticate WS connections after validation. */
const JOIN_TOKEN_SECRET = process.env.SYNC_SERVER_KEY || randomBytes(32).toString('hex')
const TOKEN_TTL_MS = 60_000 // 60 seconds

if (!process.env.SYNC_SERVER_KEY) {
  console.warn('[sync-server] WARNING: SYNC_SERVER_KEY is not set. Using a random in-memory secret.')
  console.warn('[sync-server] Join tokens will be invalidated on every server restart.')
  console.warn('[sync-server] Set SYNC_SERVER_KEY in your environment for production use.')
}

function issueJoinToken(roomId: string): string {
  const exp = Date.now() + TOKEN_TTL_MS
  const payload = `${roomId}:${exp}`
  const sig = createHmac('sha256', JOIN_TOKEN_SECRET).update(payload).digest('hex')
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
  windowMs: number
  maxRequests: number
  blockMs: number
}

const API_RATE_LIMIT: RateLimitConfig = {
  windowMs: 60_000,
  maxRequests: 10,
  blockMs: 300_000,
}

const WS_JOIN_RATE_LIMIT: RateLimitConfig = {
  windowMs: 60_000,
  maxRequests: 5,
  blockMs: 600_000,
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

const GLOBAL_RATE_LIMIT: RateLimitConfig = {
  windowMs: 1_000,
  maxRequests: 50,
  blockMs: 60_000,
}

// ── Room management ──────────────────────────────────────────────────────────

interface Client {
  ws: WebSocket
  roomId: string | null
  deviceId: string | null
  deviceName: string | null
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

function sendToDevice(roomId: string, deviceId: string, msg: object): boolean {
  const room = rooms.get(roomId)
  if (!room) return false
  const payload = JSON.stringify(msg)
  for (const client of room) {
    if (client.deviceId === deviceId && client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(payload)
      return true
    }
  }
  return false
}

function removeClient(client: Client): void {
  if (client.roomId) {
    const room = rooms.get(client.roomId)
    if (room) {
      room.delete(client)
      broadcast(client.roomId, client, {
        type: 'device-left',
        deviceId: client.deviceId,
      })
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

  // ── Health check ─────────────────────────────────────────
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
      maxRequests: 5,
      blockMs: 600_000,
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

  // ── Facebook: exchange short-lived token for permanent page tokens ────────
  if (req.url === '/api/fb/exchange-token' && req.method === 'POST') {
    const rl = checkRateLimit(`fb:${ip}`, API_RATE_LIMIT)
    if (!rl.allowed) {
      res.writeHead(429, { 'Retry-After': String(rl.retryAfter ?? 300) })
      jsonResponse(res, 429, { error: 'Rate limited. Try again later.', retryAfter: rl.retryAfter })
      return
    }

    const FB_APP_ID     = process.env.FB_APP_ID || process.env.VITE_FB_APP_ID
    const FB_APP_SECRET = process.env.FB_APP_SECRET

    if (!FB_APP_ID || !FB_APP_SECRET) {
      jsonResponse(res, 500, { error: 'Facebook app credentials not configured on server.' })
      return
    }

    try {
      const body = await readBody(req)
      const { userAccessToken } = JSON.parse(body) as { userAccessToken?: string }
      if (!userAccessToken || typeof userAccessToken !== 'string') {
        jsonResponse(res, 400, { error: 'Missing userAccessToken' })
        return
      }

      // 1) Exchange short-lived user token → long-lived user token
      const exchangeUrl = `https://graph.facebook.com/v19.0/oauth/access_token?` +
        `grant_type=fb_exchange_token&client_id=${encodeURIComponent(FB_APP_ID)}` +
        `&client_secret=${encodeURIComponent(FB_APP_SECRET)}` +
        `&fb_exchange_token=${encodeURIComponent(userAccessToken)}`

      const exchangeRes = await fetch(exchangeUrl)
      const exchangeJson = await exchangeRes.json() as { access_token?: string; error?: { message?: string } }
      if (!exchangeRes.ok || !exchangeJson.access_token) {
        jsonResponse(res, 400, { error: exchangeJson.error?.message ?? 'Failed to exchange token.' })
        return
      }
      const longLivedUserToken = exchangeJson.access_token

      // 2) Get user's pages with the long-lived token → page tokens are permanent.
      //    /me/accounts is paginated; follow `paging.next` to gather them all so
      //    users with many Pages don't get silently truncated to the first page.
      type FbPageRow = {
        id: string
        name: string
        access_token: string
        category: string
        picture?: { data?: { url?: string } }
      }
      type FbPagesResponse = {
        data?: FbPageRow[]
        paging?: { next?: string }
        error?: { message?: string }
      }

      const collected: FbPageRow[] = []
      let pagesUrl: string | undefined =
        `https://graph.facebook.com/v19.0/me/accounts?` +
        `fields=id,name,access_token,category,picture.width(100)` +
        `&limit=100` +
        `&access_token=${encodeURIComponent(longLivedUserToken)}`

      // Hard cap to avoid runaway loops in case Facebook ever loops paging cursors.
      for (let i = 0; pagesUrl && i < 20; i++) {
        const pagesRes: Response = await fetch(pagesUrl)
        const pagesJson: FbPagesResponse = await pagesRes.json() as FbPagesResponse
        if (!pagesRes.ok || !pagesJson.data) {
          jsonResponse(res, 400, { error: pagesJson.error?.message ?? 'Failed to fetch pages.' })
          return
        }
        collected.push(...pagesJson.data)
        pagesUrl = pagesJson.paging?.next
      }

      // 3) Also enumerate pages accessible through Meta Business Manager.
      //
      //    Root cause of the "missing page" bug:
      //    /me/accounts ONLY returns pages where the user has a *direct*
      //    page-level role (admin, editor, etc. assigned at the Page itself).
      //    Pages whose ownership is managed by a Meta Business Manager account
      //    (task-based / business-scoped access) are NEVER returned by
      //    /me/accounts — they simply do not appear there, even when the user
      //    explicitly selects them in the Facebook Login dialog.
      //
      //    The correct path for those pages is:
      //      GET /me/businesses → get all Business Manager IDs
      //      GET /{business_id}/owned_pages  → pages the business owns
      //      GET /{business_id}/client_pages → pages the business manages for clients
      //
      //    Requires the `business_management` permission (needs App Review for
      //    live apps; works for test users in development). Wrapped in a
      //    try/catch so the flow degrades gracefully when the permission is
      //    unavailable — pages from /me/accounts are still returned normally.
      try {
        type FbBusiness = { id: string }
        type FbBusinessesResponse = {
          data?: FbBusiness[]
          paging?: { next?: string }
        }

        const businesses: FbBusiness[] = []
        let bizUrl: string | undefined =
          `https://graph.facebook.com/v19.0/me/businesses?` +
          `fields=id&limit=100` +
          `&access_token=${encodeURIComponent(longLivedUserToken)}`

        for (let i = 0; bizUrl && i < 10; i++) {
          const bizRes = await fetch(bizUrl)
          if (!bizRes.ok) break
          const bizJson = await bizRes.json() as FbBusinessesResponse
          if (!bizJson.data) break
          businesses.push(...bizJson.data)
          bizUrl = bizJson.paging?.next
        }

        for (const biz of businesses) {
          for (const edge of ['owned_pages', 'client_pages'] as const) {
            let bizPageUrl: string | undefined =
              `https://graph.facebook.com/v19.0/${encodeURIComponent(biz.id)}/${edge}?` +
              `fields=id,name,access_token,category,picture.width(100)&limit=100` +
              `&access_token=${encodeURIComponent(longLivedUserToken)}`

            for (let i = 0; bizPageUrl && i < 20; i++) {
              const bizPageRes = await fetch(bizPageUrl)
              if (!bizPageRes.ok) break
              const bizPageJson = await bizPageRes.json() as FbPagesResponse
              if (!bizPageJson.data) break
              collected.push(...bizPageJson.data)
              bizPageUrl = bizPageJson.paging?.next
            }
          }
        }
      } catch { /* best-effort — proceed with /me/accounts results only */ }

      // Some pages (particularly New Pages Experience pages managed through
      // Meta Business Manager) appear in /me/accounts but without an
      // access_token field. The user explicitly granted access in the Login
      // dialog, so the token IS obtainable — it just isn't bundled into the
      // /me/accounts response. Fetch it per-page for any such entry.
      const resolved: FbPageRow[] = await Promise.all(
        collected.map(async (p): Promise<FbPageRow> => {
          if (p.access_token) return p
          try {
            const r = await fetch(
              `https://graph.facebook.com/v19.0/${encodeURIComponent(p.id)}?` +
              `fields=access_token&access_token=${encodeURIComponent(longLivedUserToken)}`,
            )
            const j = await r.json() as { access_token?: string; error?: unknown }
            if (r.ok && j.access_token) return { ...p, access_token: j.access_token }
          } catch { /* best-effort */ }
          return p
        }),
      )

      // De-duplicate by id (pagination cursors can overlap) and drop any
      // rows that lack an access_token — those pages cannot be posted to
      // and would be silently unusable if forwarded to the client.
      const seen = new Set<string>()
      const pages = resolved
        .filter(p => {
          if (!p.access_token) return false   // no token → cannot post
          if (seen.has(p.id)) return false    // skip duplicate
          seen.add(p.id)
          return true
        })
        .map(p => ({
          id: p.id,
          name: p.name,
          accessToken: p.access_token,
          category: p.category,
          picture: p.picture?.data?.url ?? null,
        }))

      jsonResponse(res, 200, { pages })
    } catch (e) {
      jsonResponse(res, 500, { error: (e as Error).message || 'Internal error' })
    }
    return
  }

  res.writeHead(404)
  res.end()
})

// ── WebSocket server ─────────────────────────────────────────────────────────

const wss = new WebSocketServer({ server: httpServer, path: '/ws', maxPayload: 16 * 1024 * 1024 })

wss.on('connection', (ws, req) => {
  const client: Client = { ws, roomId: null, deviceId: null, deviceName: null }
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
    const deviceId = msg.deviceId as string
    const deviceName = (msg.deviceName as string) || 'Unknown Device'

    if (!roomId || typeof roomId !== 'string' || roomId.length < 8) {
      client.ws.send(JSON.stringify({ type: 'error', message: 'Invalid roomId' }))
      return
    }
    if (!deviceId || typeof deviceId !== 'string') {
      client.ws.send(JSON.stringify({ type: 'error', message: 'Missing deviceId' }))
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

    // Determine the device's role from AUTHORITATIVE server state, not a client
    // hint. A brand-new registration is a "founder" (initialized) only when no
    // other device exists yet; a device joining an existing chain starts
    // un-initialized and must receive a transfer before it's a full member.
    // An existing row keeps whatever initialized state it already earned.
    const othersBefore = getDevices(roomId).filter(d => d.deviceId !== deviceId)
    const initializedIfNew = othersBefore.length === 0

    // Register/update device in DB
    const device = registerDevice(roomId, deviceId, deviceName, initializedIfNew)

    client.roomId = roomId
    client.deviceId = deviceId
    client.deviceName = deviceName
    const room = getRoom(roomId)
    room.add(client)

    const allDevices = getDevices(roomId)
    const otherDevices = allDevices.filter(d => d.deviceId !== deviceId)
    // A device "needs a transfer" iff the server has it as un-initialized AND
    // there is another device to copy from.
    const isNewDevice = !device.initialized && otherDevices.length > 0
    const maxSeq = getMaxSeq(roomId)
    const hasPendingOps = device.cursor < maxSeq

    // Build set of online device IDs for this room
    const onlineIds = new Set<string>()
    for (const c of room) {
      if (c.deviceId) onlineIds.add(c.deviceId)
    }

    // Send welcome
    client.ws.send(JSON.stringify({
      type: 'welcome',
      deviceCount: room.size,
      cursor: device.cursor,
      maxSeq,
      needsTransfer: isNewDevice,
      selfDeviceId: deviceId,
      devices: allDevices.map(d => ({
        deviceId: d.deviceId,
        deviceName: d.deviceName,
        online: onlineIds.has(d.deviceId),
        lastSeenAt: d.lastSeenAt,
      })),
    }))

    // Notify other devices
    broadcast(roomId, client, { type: 'device-joined', deviceId, deviceName })

    // If device has pending ops, send them
    if (hasPendingOps && !isNewDevice) {
      const ops = getOpsSince(roomId, device.cursor, 500)
      if (ops.length > 0) {
        client.ws.send(JSON.stringify({
          type: 'ops',
          entries: ops.map(op => ({
            seq: op.id,
            payload: op.payload.toString('base64'),
            deviceId: op.deviceId,
            createdAt: op.createdAt,
          })),
        }))
      }
    }

    // Replay any still-pending transfer requests so an approver that was
    // offline (or backgrounded — mobile PWAs drop their socket whenever the
    // app loses focus) sees the approval prompt as soon as it (re)connects.
    // Previously `transfer-requested` was a fire-and-forget `sendToDevice`
    // that was silently lost if the approver had no live socket at that
    // instant, and nothing ever re-delivered it — so the prompt never showed,
    // "not even when they returned". An established device that joins is a
    // candidate source/approver; a brand-new device (needsTransfer) has no
    // notes to send, so it is never asked to approve.
    if (!isNewDevice) {
      const pending = getPendingTransfers(roomId)
      for (const t of pending) {
        if (t.status !== 'pending') continue        // already approved/in-flight
        if (t.requesterId === deviceId) continue     // don't ask the requester to approve itself
        // Only prompt when the requester is still connected to receive the data.
        const requesterOnline = Array.from(room).some(
          c => c.deviceId === t.requesterId && c.ws.readyState === WebSocket.OPEN,
        )
        if (!requesterOnline) continue
        const requester = getDevice(roomId, t.requesterId)
        client.ws.send(JSON.stringify({
          type: 'transfer-requested',
          transferId: t.id,
          requesterId: t.requesterId,
          requesterName: requester?.deviceName || 'A device',
        }))
      }
    }
    return
  }

  // All other messages require a room
  if (!client.roomId || !client.deviceId) {
    client.ws.send(JSON.stringify({ type: 'error', message: 'Not in a room. Send { type: "join" } first.' }))
    return
  }

  const roomId = client.roomId
  const deviceId = client.deviceId

  // ── Push an operation ──────────────────────────────────────────────────────
  if (type === 'push-op') {
    const payloadB64 = msg.payload as string
    if (!payloadB64) {
      client.ws.send(JSON.stringify({ type: 'error', message: 'Missing payload for push-op' }))
      return
    }

    const buf = Buffer.from(payloadB64, 'base64')
    const seq = appendOp(roomId, deviceId, buf)

    // Update sender's cursor to their own op
    updateDeviceCursor(roomId, deviceId, seq)

    // Broadcast to other devices in real-time
    broadcast(roomId, client, {
      type: 'op-broadcast',
      seq,
      payload: payloadB64,
      deviceId,
    })

    // Confirm to sender
    client.ws.send(JSON.stringify({ type: 'ack', cursor: seq }))

    // Try to truncate delivered ops
    truncateDeliveredOps(roomId)
    return
  }

  // ── Acknowledge receipt (advance cursor) ───────────────────────────────────
  if (type === 'ack') {
    const cursor = msg.cursor as number
    if (typeof cursor !== 'number' || cursor < 0) {
      client.ws.send(JSON.stringify({ type: 'error', message: 'Invalid cursor' }))
      return
    }

    updateDeviceCursor(roomId, deviceId, cursor)
    touchDevice(roomId, deviceId)

    // Try to truncate delivered ops
    truncateDeliveredOps(roomId)
    return
  }

  // ── Request transfer FROM a specific device (targeted) ──────────────────
  if (type === 'request-transfer-from') {
    const targetDeviceId = msg.targetDeviceId as string
    if (!targetDeviceId || typeof targetDeviceId !== 'string') {
      client.ws.send(JSON.stringify({ type: 'error', message: 'Missing targetDeviceId' }))
      return
    }

    // A device can never transfer from itself.
    if (targetDeviceId === deviceId) {
      client.ws.send(JSON.stringify({ type: 'error', message: 'Cannot request a transfer from this same device' }))
      return
    }

    // Verify target device exists in this room
    const targetDevice = getDevice(roomId, targetDeviceId)
    if (!targetDevice) {
      client.ws.send(JSON.stringify({ type: 'error', message: 'Target device not found in this sync chain' }))
      return
    }

    // Check if target is currently online
    const room = rooms.get(roomId)
    const isOnline = room ? Array.from(room).some(c => c.deviceId === targetDeviceId && c.ws.readyState === WebSocket.OPEN) : false
    if (!isOnline) {
      client.ws.send(JSON.stringify({
        type: 'transfer-target-offline',
        targetDeviceId,
        targetDeviceName: targetDevice.deviceName,
      }))
      return
    }

    // Create transfer and send targeted request to that one device
    const transferId = createTransfer(roomId, deviceId)
    sendToDevice(roomId, targetDeviceId, {
      type: 'transfer-requested',
      transferId,
      requesterId: deviceId,
      requesterName: client.deviceName || 'Unknown Device',
    })
    client.ws.send(JSON.stringify({ type: 'transfer-pending', transferId }))
    return
  }

  // ── Remove a device from the sync chain ─────────────────────────────────
  if (type === 'remove-device') {
    const targetDeviceId = msg.deviceId as string
    if (!targetDeviceId || typeof targetDeviceId !== 'string') {
      client.ws.send(JSON.stringify({ type: 'error', message: 'Missing deviceId' }))
      return
    }

    // A device can remove any device in its sync chain (including itself).
    // Sync codes are the only auth — anyone with the code is trusted.
    removeDevice(roomId, targetDeviceId)

    // Force-close the removed device's socket if it's currently connected,
    // and remove it from the room so it doesn't keep receiving ops.
    const room = rooms.get(roomId)
    if (room) {
      for (const c of Array.from(room)) {
        if (c.deviceId === targetDeviceId) {
          try {
            c.ws.send(JSON.stringify({ type: 'device-removed', deviceId: targetDeviceId, byDeviceId: deviceId }))
          } catch { /* ignore */ }
          try { c.ws.close() } catch { /* ignore */ }
          room.delete(c)
        }
      }
    }

    // Tell remaining devices in the room
    broadcast(roomId, client, { type: 'device-removed', deviceId: targetDeviceId, byDeviceId: deviceId })
    // Also acknowledge to the requester
    client.ws.send(JSON.stringify({ type: 'device-removed', deviceId: targetDeviceId, byDeviceId: deviceId }))
    return
  }

  // ── Request transfer (legacy broadcast — new device wants notes) ─────────
  if (type === 'request-transfer') {
    // Check if there are other devices in this room
    const allDevices = getDevices(roomId)
    const otherDevices = allDevices.filter(d => d.deviceId !== deviceId)
    if (otherDevices.length === 0) {
      client.ws.send(JSON.stringify({ type: 'error', message: 'No other devices available for transfer' }))
      return
    }

    // Create transfer request
    const transferId = createTransfer(roomId, deviceId)

    // Notify all other online devices about the transfer request
    broadcast(roomId, client, {
      type: 'transfer-requested',
      transferId,
      requesterId: deviceId,
      requesterName: client.deviceName || 'Unknown Device',
    })

    client.ws.send(JSON.stringify({ type: 'transfer-pending', transferId }))
    return
  }

  // ── Approve transfer ───────────────────────────────────────────────────────
  if (type === 'approve-transfer') {
    const transferId = msg.transferId as number
    if (!transferId) {
      client.ws.send(JSON.stringify({ type: 'error', message: 'Missing transferId' }))
      return
    }

    const transfer = getTransfer(transferId)
    if (!transfer || transfer.roomId !== roomId || transfer.status !== 'pending') {
      client.ws.send(JSON.stringify({ type: 'error', message: 'Transfer not found or already processed' }))
      return
    }

    approveTransfer(transferId, deviceId)

    // Notify the requester that transfer was approved
    sendToDevice(roomId, transfer.requesterId, {
      type: 'transfer-approved',
      transferId,
      approverId: deviceId,
      approverName: client.deviceName || 'Unknown Device',
    })
    return
  }

  // ── Deny transfer ──────────────────────────────────────────────────────────
  if (type === 'deny-transfer') {
    const transferId = msg.transferId as number
    if (!transferId) {
      client.ws.send(JSON.stringify({ type: 'error', message: 'Missing transferId' }))
      return
    }

    const transfer = getTransfer(transferId)
    if (!transfer || transfer.roomId !== roomId || transfer.status !== 'pending') {
      client.ws.send(JSON.stringify({ type: 'error', message: 'Transfer not found or already processed' }))
      return
    }

    updateTransferStatus(transferId, 'cancelled')

    // Notify the requester
    sendToDevice(roomId, transfer.requesterId, {
      type: 'transfer-denied',
      transferId,
    })
    return
  }

  // ── Send transfer chunk (approver sends data to requester) ─────────────────
  if (type === 'transfer-chunk') {
    const transferId = msg.transferId as number
    const chunk = msg.chunk as string
    const chunkIndex = msg.chunkIndex as number
    const totalChunks = msg.totalChunks as number
    const resumeToken = msg.resumeToken as string

    if (!transferId || !chunk || typeof chunkIndex !== 'number' || typeof totalChunks !== 'number') {
      client.ws.send(JSON.stringify({ type: 'error', message: 'Missing fields for transfer-chunk' }))
      return
    }

    const transfer = getTransfer(transferId)
    if (!transfer || transfer.roomId !== roomId) {
      client.ws.send(JSON.stringify({ type: 'error', message: 'Transfer not found' }))
      return
    }
    if (transfer.approverId !== deviceId) {
      client.ws.send(JSON.stringify({ type: 'error', message: 'Not authorized to send chunks for this transfer' }))
      return
    }

    // Update status to in_progress on first chunk
    if (transfer.status === 'approved') {
      updateTransferStatus(transferId, 'in_progress')
    }

    // Save resume token
    if (resumeToken) {
      updateTransferResumeToken(transferId, resumeToken)
    }

    // Relay chunk to the requester
    sendToDevice(roomId, transfer.requesterId, {
      type: 'transfer-chunk',
      transferId,
      chunk,
      chunkIndex,
      totalChunks,
      resumeToken,
    })
    return
  }

  // ── Resume transfer (requester asks to continue from where it left off) ────
  if (type === 'transfer-resume') {
    const transferId = msg.transferId as number
    const resumeToken = msg.resumeToken as string

    if (!transferId) {
      client.ws.send(JSON.stringify({ type: 'error', message: 'Missing transferId' }))
      return
    }

    const transfer = getTransfer(transferId)
    if (!transfer || transfer.roomId !== roomId || transfer.requesterId !== deviceId) {
      client.ws.send(JSON.stringify({ type: 'error', message: 'Transfer not found or not yours' }))
      return
    }

    if (!transfer.approverId) {
      client.ws.send(JSON.stringify({ type: 'error', message: 'Transfer not yet approved' }))
      return
    }

    // Notify the approver to resume sending
    sendToDevice(roomId, transfer.approverId, {
      type: 'transfer-resume',
      transferId,
      resumeToken: resumeToken || transfer.resumeToken,
    })
    return
  }

  // ── Transfer complete ──────────────────────────────────────────────────────
  if (type === 'transfer-complete') {
    const transferId = msg.transferId as number
    if (!transferId) {
      client.ws.send(JSON.stringify({ type: 'error', message: 'Missing transferId' }))
      return
    }

    const transfer = getTransfer(transferId)
    if (!transfer || transfer.roomId !== roomId) {
      client.ws.send(JSON.stringify({ type: 'error', message: 'Transfer not found' }))
      return
    }

    updateTransferStatus(transferId, 'completed')

    // Update the new device's cursor to current max so it doesn't replay ops
    // that were part of the transfer, and mark it initialized so it is never
    // asked to bootstrap again (and rejoins as a full member).
    const maxSeq = getMaxSeq(roomId)
    updateDeviceCursor(roomId, transfer.requesterId, maxSeq)
    markDeviceInitialized(roomId, transfer.requesterId)

    // Notify both parties
    sendToDevice(roomId, transfer.requesterId, { type: 'transfer-complete', transferId })
    if (transfer.approverId) {
      sendToDevice(roomId, transfer.approverId, { type: 'transfer-complete', transferId })
    }
    return
  }

  // ── Pull ops (request missed ops since cursor) ─────────────────────────────
  if (type === 'pull') {
    const since = (msg.since as number) ?? getDevice(roomId, deviceId)?.cursor ?? 0
    const limit = (msg.limit as number) || 500

    const ops = getOpsSince(roomId, since, limit)
    client.ws.send(JSON.stringify({
      type: 'ops',
      entries: ops.map(op => ({
        seq: op.id,
        payload: op.payload.toString('base64'),
        deviceId: op.deviceId,
        createdAt: op.createdAt,
      })),
    }))
    return
  }

  client.ws.send(JSON.stringify({ type: 'error', message: `Unknown message type: ${type}` }))
}

// ── Maintenance: run every hour ──────────────────────────────────────────────

setInterval(() => {
  try {
    const result = runMaintenance(DEVICE_MAX_AGE_MS)
    if (result.devicesRemoved > 0 || result.opsRemoved > 0) {
      console.log(`[maintenance] Removed ${result.devicesRemoved} stale device(s), truncated ${result.opsRemoved} op(s)`)
    }
  } catch (e) {
    console.error('[maintenance] Error:', e)
  }
}, 60 * 60 * 1000) // every hour

// ── Start ────────────────────────────────────────────────────────────────────

httpServer.listen(PORT, () => {
  console.log(`[sync-server] Ephemeral relay listening on :${PORT} (ws + http)`)
  console.log(`[sync-server] Device TTL: 30 days | Maintenance: hourly`)
})

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[sync-server] shutting down…')
  wss.close()
  httpServer.close()
})
