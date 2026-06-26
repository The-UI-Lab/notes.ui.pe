/**
 * SQLite storage for ephemeral relay sync.
 *
 * Architecture: The server stores NOTHING permanently. It is a mailbox, not a vault.
 *
 * Tables:
 *   sync_codes — registered room IDs
 *   devices    — registered devices per room with cursor + last_seen
 *   ops_log    — sequential operations log (ephemeral, auto-truncated)
 *   transfers  — pending peer-to-peer transfer requests
 */

import Database from 'better-sqlite3'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'

const DATA_DIR = process.env.SYNC_DATA_DIR || '/data/sync'
mkdirSync(DATA_DIR, { recursive: true })

const db = new Database(join(DATA_DIR, 'sync.db'))

// WAL mode for concurrent reads during writes
db.pragma('journal_mode = WAL')
db.pragma('busy_timeout = 5000')

// ── Schema migration: drop legacy tables, create new ones ───────────────────

// Drop legacy tables from the old permanent-storage architecture
db.exec(`
  DROP TABLE IF EXISTS notes;
  DROP TABLE IF EXISTS media;
  DROP TABLE IF EXISTS deleted;
`)

db.exec(`
  CREATE TABLE IF NOT EXISTS sync_codes (
    room_id     TEXT PRIMARY KEY,
    created_at  INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  );

  CREATE TABLE IF NOT EXISTS devices (
    room_id       TEXT NOT NULL,
    device_id     TEXT NOT NULL,
    device_name   TEXT NOT NULL DEFAULT 'Unknown Device',
    cursor        INTEGER NOT NULL DEFAULT 0,
    -- 1 once this device holds the chain's notes (it founded the chain or
    -- finished an initial transfer); 0 while it still needs to be bootstrapped.
    -- This is the AUTHORITATIVE answer to "does this device need a transfer?" —
    -- the client used to decide it from a localStorage flag / note count, which
    -- raced with note-loading and got wiped, causing already-synced devices to
    -- ask each other to re-sync.
    initialized   INTEGER NOT NULL DEFAULT 1,
    last_seen_at  INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    created_at    INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    PRIMARY KEY (room_id, device_id)
  );

  CREATE TABLE IF NOT EXISTS ops_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id     TEXT NOT NULL,
    device_id   TEXT NOT NULL,
    payload     BLOB NOT NULL,
    created_at  INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  );

  CREATE TABLE IF NOT EXISTS transfers (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id         TEXT NOT NULL,
    requester_id    TEXT NOT NULL,
    approver_id     TEXT,
    status          TEXT NOT NULL DEFAULT 'pending',
    resume_token    TEXT,
    created_at      INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at      INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  );

  CREATE INDEX IF NOT EXISTS idx_ops_room_id ON ops_log(room_id, id);
  CREATE INDEX IF NOT EXISTS idx_devices_room ON devices(room_id);
  CREATE INDEX IF NOT EXISTS idx_devices_last_seen ON devices(last_seen_at);
  CREATE INDEX IF NOT EXISTS idx_transfers_room ON transfers(room_id, status);
`)

// Migration for databases created before the `initialized` column existed.
// Existing rows are devices that were ALREADY paired and syncing, so they are
// established members — default them to initialized = 1 so they are never asked
// to re-bootstrap. (Idempotent: the duplicate-column error is ignored.)
try {
  db.exec(`ALTER TABLE devices ADD COLUMN initialized INTEGER NOT NULL DEFAULT 1`)
} catch {
  /* column already exists */
}

// ── Sync code operations ─────────────────────────────────────────────────────

const stmtRegisterSyncCode = db.prepare(`
  INSERT OR IGNORE INTO sync_codes (room_id) VALUES (?)
`)

const stmtSyncCodeExists = db.prepare(`
  SELECT 1 FROM sync_codes WHERE room_id = ?
`)

export function registerSyncCode(roomId: string): void {
  stmtRegisterSyncCode.run(roomId)
}

export function syncCodeExists(roomId: string): boolean {
  return !!stmtSyncCodeExists.get(roomId)
}

// ── Device operations ────────────────────────────────────────────────────────

export interface DeviceRecord {
  deviceId: string
  deviceName: string
  cursor: number
  initialized: boolean
  lastSeenAt: number
  createdAt: number
}

// On first registration the `initialized` flag is set from the caller-supplied
// value. On reconnect (ON CONFLICT) it is intentionally NOT touched — a device's
// initialized state, once earned, is permanent for the life of its row.
const stmtRegisterDevice = db.prepare(`
  INSERT INTO devices (room_id, device_id, device_name, cursor, initialized, last_seen_at)
  VALUES (?, ?, ?, 0, ?, ?)
  ON CONFLICT(room_id, device_id) DO UPDATE SET
    device_name = excluded.device_name,
    last_seen_at = excluded.last_seen_at
`)

const stmtSetInitialized = db.prepare(`
  UPDATE devices SET initialized = 1 WHERE room_id = ? AND device_id = ?
`)

const stmtGetDevice = db.prepare(`
  SELECT device_id, device_name, cursor, initialized, last_seen_at, created_at
  FROM devices WHERE room_id = ? AND device_id = ?
`)

const stmtGetDevices = db.prepare(`
  SELECT device_id, device_name, cursor, initialized, last_seen_at, created_at
  FROM devices WHERE room_id = ?
`)

const stmtUpdateCursor = db.prepare(`
  UPDATE devices SET cursor = ?, last_seen_at = ? WHERE room_id = ? AND device_id = ?
`)

const stmtUpdateLastSeen = db.prepare(`
  UPDATE devices SET last_seen_at = ? WHERE room_id = ? AND device_id = ?
`)

const stmtRemoveDevice = db.prepare(`
  DELETE FROM devices WHERE room_id = ? AND device_id = ?
`)

const stmtGetStaleDevices = db.prepare(`
  SELECT room_id, device_id FROM devices WHERE last_seen_at < ?
`)

const stmtGetMinCursor = db.prepare(`
  SELECT MIN(cursor) as min_cursor FROM devices WHERE room_id = ?
`)

type DeviceRow = {
  device_id: string; device_name: string; cursor: number
  initialized: number; last_seen_at: number; created_at: number
}

function toDeviceRecord(row: DeviceRow): DeviceRecord {
  return {
    deviceId: row.device_id,
    deviceName: row.device_name,
    cursor: row.cursor,
    initialized: !!row.initialized,
    lastSeenAt: row.last_seen_at,
    createdAt: row.created_at,
  }
}

/**
 * Register (or touch) a device. `initializedIfNew` sets the initialized flag
 * ONLY when the row is first created — the founder of a chain (no other devices
 * yet) is initialized; a device that joins an existing chain is not, until it
 * finishes a transfer. Reconnects never change an existing row's flag.
 */
export function registerDevice(
  roomId: string,
  deviceId: string,
  deviceName: string,
  initializedIfNew: boolean,
): DeviceRecord {
  const now = Date.now()
  stmtRegisterDevice.run(roomId, deviceId, deviceName, initializedIfNew ? 1 : 0, now)
  return toDeviceRecord(stmtGetDevice.get(roomId, deviceId) as DeviceRow)
}

/** Mark a device as having completed its initial bootstrap (received a transfer). */
export function markDeviceInitialized(roomId: string, deviceId: string): void {
  stmtSetInitialized.run(roomId, deviceId)
}

export function getDevice(roomId: string, deviceId: string): DeviceRecord | null {
  const row = stmtGetDevice.get(roomId, deviceId) as DeviceRow | undefined
  return row ? toDeviceRecord(row) : null
}

export function getDevices(roomId: string): DeviceRecord[] {
  const rows = stmtGetDevices.all(roomId) as DeviceRow[]
  return rows.map(toDeviceRecord)
}

export function updateDeviceCursor(roomId: string, deviceId: string, cursor: number): void {
  stmtUpdateCursor.run(cursor, Date.now(), roomId, deviceId)
}

export function touchDevice(roomId: string, deviceId: string): void {
  stmtUpdateLastSeen.run(Date.now(), roomId, deviceId)
}

export function removeDevice(roomId: string, deviceId: string): void {
  stmtRemoveDevice.run(roomId, deviceId)
}

export function getStaleDevices(maxAge: number): { roomId: string; deviceId: string }[] {
  const cutoff = Date.now() - maxAge
  const rows = stmtGetStaleDevices.all(cutoff) as { room_id: string; device_id: string }[]
  return rows.map(r => ({ roomId: r.room_id, deviceId: r.device_id }))
}

export function getMinCursorForRoom(roomId: string): number {
  const row = stmtGetMinCursor.get(roomId) as { min_cursor: number | null } | undefined
  return row?.min_cursor ?? 0
}

// ── Operations log ───────────────────────────────────────────────────────────

export interface OpsLogEntry {
  id: number
  roomId: string
  deviceId: string
  payload: Buffer
  createdAt: number
}

const stmtAppendOp = db.prepare(`
  INSERT INTO ops_log (room_id, device_id, payload, created_at) VALUES (?, ?, ?, ?)
`)

const stmtGetOpsSince = db.prepare(`
  SELECT id, room_id, device_id, payload, created_at
  FROM ops_log WHERE room_id = ? AND id > ?
  ORDER BY id ASC
`)

const stmtGetOpsSinceLimited = db.prepare(`
  SELECT id, room_id, device_id, payload, created_at
  FROM ops_log WHERE room_id = ? AND id > ?
  ORDER BY id ASC LIMIT ?
`)

const stmtTruncateOps = db.prepare(`
  DELETE FROM ops_log WHERE room_id = ? AND id <= ?
`)

const stmtGetMaxSeq = db.prepare(`
  SELECT MAX(id) as max_seq FROM ops_log WHERE room_id = ?
`)

export function appendOp(roomId: string, deviceId: string, payload: Buffer): number {
  const result = stmtAppendOp.run(roomId, deviceId, payload, Date.now())
  return Number(result.lastInsertRowid)
}

export function getOpsSince(roomId: string, cursor: number, limit?: number): OpsLogEntry[] {
  const rows = limit
    ? stmtGetOpsSinceLimited.all(roomId, cursor, limit) as { id: number; room_id: string; device_id: string; payload: Buffer; created_at: number }[]
    : stmtGetOpsSince.all(roomId, cursor) as { id: number; room_id: string; device_id: string; payload: Buffer; created_at: number }[]
  return rows.map(r => ({
    id: r.id,
    roomId: r.room_id,
    deviceId: r.device_id,
    payload: r.payload,
    createdAt: r.created_at,
  }))
}

export function truncateOps(roomId: string, upToSeq: number): number {
  const result = stmtTruncateOps.run(roomId, upToSeq)
  return result.changes
}

export function getMaxSeq(roomId: string): number {
  const row = stmtGetMaxSeq.get(roomId) as { max_seq: number | null } | undefined
  return row?.max_seq ?? 0
}

/**
 * Truncate ops for a room up to the minimum cursor of all active devices.
 * Returns number of entries removed.
 */
export function truncateDeliveredOps(roomId: string): number {
  const minCursor = getMinCursorForRoom(roomId)
  if (minCursor <= 0) return 0
  return truncateOps(roomId, minCursor)
}

// ── Transfer operations ──────────────────────────────────────────────────────

export interface TransferRecord {
  id: number
  roomId: string
  requesterId: string
  approverId: string | null
  status: 'pending' | 'approved' | 'in_progress' | 'completed' | 'cancelled'
  resumeToken: string | null
  createdAt: number
  updatedAt: number
}

const stmtCreateTransfer = db.prepare(`
  INSERT INTO transfers (room_id, requester_id, status, created_at, updated_at)
  VALUES (?, ?, 'pending', ?, ?)
`)

const stmtGetPendingTransfers = db.prepare(`
  SELECT id, room_id, requester_id, approver_id, status, resume_token, created_at, updated_at
  FROM transfers WHERE room_id = ? AND status IN ('pending', 'approved', 'in_progress')
`)

const stmtGetTransfer = db.prepare(`
  SELECT id, room_id, requester_id, approver_id, status, resume_token, created_at, updated_at
  FROM transfers WHERE id = ?
`)

const stmtUpdateTransferStatus = db.prepare(`
  UPDATE transfers SET status = ?, approver_id = COALESCE(?, approver_id), updated_at = ? WHERE id = ?
`)

const stmtUpdateTransferResume = db.prepare(`
  UPDATE transfers SET resume_token = ?, updated_at = ? WHERE id = ?
`)

const stmtCleanupOldTransfers = db.prepare(`
  DELETE FROM transfers WHERE created_at < ? OR status IN ('completed', 'cancelled')
`)

export function createTransfer(roomId: string, requesterId: string): number {
  const now = Date.now()
  const result = stmtCreateTransfer.run(roomId, requesterId, now, now)
  return Number(result.lastInsertRowid)
}

export function getPendingTransfers(roomId: string): TransferRecord[] {
  const rows = stmtGetPendingTransfers.all(roomId) as {
    id: number; room_id: string; requester_id: string; approver_id: string | null;
    status: string; resume_token: string | null; created_at: number; updated_at: number
  }[]
  return rows.map(r => ({
    id: r.id,
    roomId: r.room_id,
    requesterId: r.requester_id,
    approverId: r.approver_id,
    status: r.status as TransferRecord['status'],
    resumeToken: r.resume_token,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }))
}

export function getTransfer(transferId: number): TransferRecord | null {
  const row = stmtGetTransfer.get(transferId) as {
    id: number; room_id: string; requester_id: string; approver_id: string | null;
    status: string; resume_token: string | null; created_at: number; updated_at: number
  } | undefined
  if (!row) return null
  return {
    id: row.id,
    roomId: row.room_id,
    requesterId: row.requester_id,
    approverId: row.approver_id,
    status: row.status as TransferRecord['status'],
    resumeToken: row.resume_token,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function approveTransfer(transferId: number, approverId: string): void {
  stmtUpdateTransferStatus.run('approved', approverId, Date.now(), transferId)
}

export function updateTransferStatus(transferId: number, status: TransferRecord['status']): void {
  stmtUpdateTransferStatus.run(status, null, Date.now(), transferId)
}

export function updateTransferResumeToken(transferId: number, resumeToken: string): void {
  stmtUpdateTransferResume.run(resumeToken, Date.now(), transferId)
}

export function cleanupTransfers(maxAgeMs: number): number {
  const cutoff = Date.now() - maxAgeMs
  const result = stmtCleanupOldTransfers.run(cutoff)
  return result.changes
}

// ── Maintenance ──────────────────────────────────────────────────────────────

/**
 * Remove stale devices (inactive > maxAgeMs) and truncate delivered ops.
 * Called periodically by the server.
 */
export function runMaintenance(maxDeviceAgeMs: number): { devicesRemoved: number; opsRemoved: number } {
  let devicesRemoved = 0
  let opsRemoved = 0

  // Remove stale devices
  const stale = getStaleDevices(maxDeviceAgeMs)
  for (const { roomId, deviceId } of stale) {
    removeDevice(roomId, deviceId)
    devicesRemoved++
  }

  // Truncate delivered ops for all rooms that had stale devices removed
  const affectedRooms = new Set(stale.map(s => s.roomId))
  // Also truncate all rooms with active devices
  const allRoomsStmt = db.prepare(`SELECT DISTINCT room_id FROM devices`)
  const allRooms = allRoomsStmt.all() as { room_id: string }[]
  for (const { room_id } of allRooms) {
    affectedRooms.add(room_id)
  }

  for (const roomId of affectedRooms) {
    opsRemoved += truncateDeliveredOps(roomId)
  }

  // Cleanup old/completed transfers
  cleanupTransfers(maxDeviceAgeMs)

  return { devicesRemoved, opsRemoved }
}
