/**
 * SQLite storage for encrypted sync data.
 *
 * Tables:
 *   notes  — one row per note per room (roomId, noteId, encryptedBlob, updatedAt)
 *   media  — one row per media blob per room (roomId, mediaId, encryptedBlob)
 *   deleted — tombstones (roomId, noteId, deletedAt)
 */

import Database from 'better-sqlite3'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { serverEncrypt, serverDecrypt } from './crypto.js'

const DATA_DIR = process.env.SYNC_DATA_DIR || '/data/sync'
mkdirSync(DATA_DIR, { recursive: true })

const db = new Database(join(DATA_DIR, 'sync.db'))

// WAL mode for concurrent reads during writes
db.pragma('journal_mode = WAL')
db.pragma('busy_timeout = 5000')

db.exec(`
  CREATE TABLE IF NOT EXISTS notes (
    room_id     TEXT NOT NULL,
    note_id     TEXT NOT NULL,
    data        BLOB NOT NULL,
    updated_at  INTEGER NOT NULL,
    PRIMARY KEY (room_id, note_id)
  );

  CREATE TABLE IF NOT EXISTS media (
    room_id     TEXT NOT NULL,
    media_id    TEXT NOT NULL,
    data        BLOB NOT NULL,
    created_at  INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    PRIMARY KEY (room_id, media_id)
  );

  CREATE TABLE IF NOT EXISTS deleted (
    room_id     TEXT NOT NULL,
    note_id     TEXT NOT NULL,
    deleted_at  INTEGER NOT NULL,
    PRIMARY KEY (room_id, note_id)
  );

  CREATE TABLE IF NOT EXISTS sync_codes (
    room_id     TEXT PRIMARY KEY,
    created_at  INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  );

  CREATE INDEX IF NOT EXISTS idx_notes_updated ON notes(room_id, updated_at);
  CREATE INDEX IF NOT EXISTS idx_deleted_at ON deleted(room_id, deleted_at);
`)

// ── Note operations ──────────────────────────────────────────────────────────

const stmtUpsertNote = db.prepare(`
  INSERT INTO notes (room_id, note_id, data, updated_at)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(room_id, note_id) DO UPDATE SET
    data = excluded.data,
    updated_at = excluded.updated_at
  WHERE excluded.updated_at > notes.updated_at
`)

const stmtGetNote = db.prepare(`
  SELECT data, updated_at FROM notes WHERE room_id = ? AND note_id = ?
`)

const stmtGetNotesSince = db.prepare(`
  SELECT note_id, data, updated_at FROM notes
  WHERE room_id = ? AND updated_at > ?
  ORDER BY updated_at ASC
`)

const stmtGetAllNotes = db.prepare(`
  SELECT note_id, data, updated_at FROM notes WHERE room_id = ?
`)

const stmtDeleteNote = db.prepare(`
  DELETE FROM notes WHERE room_id = ? AND note_id = ?
`)

export interface StoredNote {
  noteId: string
  data: Buffer
  updatedAt: number
}

export function upsertNote(roomId: string, noteId: string, clientEncrypted: Buffer, updatedAt: number): boolean {
  const doubleEncrypted = serverEncrypt(clientEncrypted)
  const result = stmtUpsertNote.run(roomId, noteId, doubleEncrypted, updatedAt)
  return result.changes > 0
}

export function getNote(roomId: string, noteId: string): StoredNote | null {
  const row = stmtGetNote.get(roomId, noteId) as { data: Buffer; updated_at: number } | undefined
  if (!row) return null
  return { noteId, data: serverDecrypt(row.data), updatedAt: row.updated_at }
}

export function getNotesSince(roomId: string, since: number): StoredNote[] {
  const rows = stmtGetNotesSince.all(roomId, since) as { note_id: string; data: Buffer; updated_at: number }[]
  return rows.map(r => ({ noteId: r.note_id, data: serverDecrypt(r.data), updatedAt: r.updated_at }))
}

export function getAllNotes(roomId: string): StoredNote[] {
  const rows = stmtGetAllNotes.all(roomId) as { note_id: string; data: Buffer; updated_at: number }[]
  return rows.map(r => ({ noteId: r.note_id, data: serverDecrypt(r.data), updatedAt: r.updated_at }))
}

export function deleteNote(roomId: string, noteId: string, deletedAt: number): void {
  stmtDeleteNote.run(roomId, noteId)
  stmtRecordDeletion.run(roomId, noteId, deletedAt)
}

// ── Deletion operations ──────────────────────────────────────────────────────

const stmtRecordDeletion = db.prepare(`
  INSERT OR REPLACE INTO deleted (room_id, note_id, deleted_at) VALUES (?, ?, ?)
`)

const stmtGetDeletionsSince = db.prepare(`
  SELECT note_id, deleted_at FROM deleted WHERE room_id = ? AND deleted_at > ?
`)

const stmtGetAllDeletions = db.prepare(`
  SELECT note_id, deleted_at FROM deleted WHERE room_id = ?
`)

export interface Deletion {
  noteId: string
  deletedAt: number
}

export function getDeletionsSince(roomId: string, since: number): Deletion[] {
  const rows = stmtGetDeletionsSince.all(roomId, since) as { note_id: string; deleted_at: number }[]
  return rows.map(r => ({ noteId: r.note_id, deletedAt: r.deleted_at }))
}

export function getAllDeletions(roomId: string): Deletion[] {
  const rows = stmtGetAllDeletions.all(roomId) as { note_id: string; deleted_at: number }[]
  return rows.map(r => ({ noteId: r.note_id, deletedAt: r.deleted_at }))
}

// ── Media operations ─────────────────────────────────────────────────────────

const stmtUpsertMedia = db.prepare(`
  INSERT OR REPLACE INTO media (room_id, media_id, data) VALUES (?, ?, ?)
`)

const stmtGetMedia = db.prepare(`
  SELECT data FROM media WHERE room_id = ? AND media_id = ?
`)

const stmtHasMedia = db.prepare(`
  SELECT 1 FROM media WHERE room_id = ? AND media_id = ?
`)

export function putMediaBlob(roomId: string, mediaId: string, clientEncrypted: Buffer): void {
  const doubleEncrypted = serverEncrypt(clientEncrypted)
  stmtUpsertMedia.run(roomId, mediaId, doubleEncrypted)
}

export function getMediaBlob(roomId: string, mediaId: string): Buffer | null {
  const row = stmtGetMedia.get(roomId, mediaId) as { data: Buffer } | undefined
  if (!row) return null
  return serverDecrypt(row.data)
}

export function hasMedia(roomId: string, mediaId: string): boolean {
  return !!stmtHasMedia.get(roomId, mediaId)
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
