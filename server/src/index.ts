/**
 * Sync server — WebSocket + HTTP endpoints.
 *
 * WebSocket protocol (JSON messages):
 *   Client → Server:
 *     { type: 'join',       roomId }
 *     { type: 'push-note',  noteId, data (base64), updatedAt }
 *     { type: 'delete-note', noteId, deletedAt }
 *     { type: 'push-media', mediaId, data (base64) }
 *     { type: 'pull',       since }           // request changes since timestamp
 *     { type: 'pull-media', mediaId }         // request a specific media blob
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

import { createServer } from 'node:http'
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
} from './db.js'

const PORT = parseInt(process.env.SYNC_PORT || '3001', 10)

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

// ── HTTP server (health check) ───────────────────────────────────────────────

const httpServer = createServer((req, res) => {
  if (req.url === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ status: 'ok', rooms: rooms.size }))
    return
  }
  res.writeHead(404)
  res.end()
})

// ── WebSocket server ─────────────────────────────────────────────────────────

const wss = new WebSocketServer({ server: httpServer, path: '/ws' })

wss.on('connection', (ws) => {
  const client: Client = { ws, roomId: null }

  ws.on('message', (raw) => {
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString())
    } catch {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }))
      return
    }

    try {
      handleMessage(client, msg)
    } catch (e) {
      console.error('[ws] Error handling message:', e)
      ws.send(JSON.stringify({ type: 'error', message: 'Internal error' }))
    }
  })

  ws.on('close', () => removeClient(client))
  ws.on('error', () => removeClient(client))
})

function handleMessage(client: Client, msg: Record<string, unknown>): void {
  const { type } = msg

  // ── Join a room ──────────────────────────────────────────────────────────
  if (type === 'join') {
    const roomId = msg.roomId as string
    if (!roomId || typeof roomId !== 'string' || roomId.length < 8) {
      client.ws.send(JSON.stringify({ type: 'error', message: 'Invalid roomId' }))
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
    client.ws.send(JSON.stringify({ type: 'error', message: 'Not in a room. Send { type: "join", roomId } first.' }))
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
