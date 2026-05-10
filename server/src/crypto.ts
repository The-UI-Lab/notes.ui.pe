/**
 * Server-side encryption layer — defense in depth.
 *
 * Notes arrive already client-encrypted (AES-256-GCM with user password).
 * This module adds a second layer using a server key from SYNC_SERVER_KEY env.
 * Even if the SQLite database is stolen, data remains opaque without both keys.
 *
 * Format: [iv (12 bytes)][ciphertext]
 */

import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto'

const ALGO = 'aes-256-gcm'
const IV_LEN = 12
const TAG_LEN = 16

function getServerKey(): Buffer {
  const raw = process.env.SYNC_SERVER_KEY
  if (!raw) {
    console.warn('[sync-server] SYNC_SERVER_KEY not set — using deterministic fallback (NOT SECURE for production)')
    return createHash('sha256').update('notes-sync-default-key-change-me').digest()
  }
  return createHash('sha256').update(raw).digest()
}

let cachedKey: Buffer | null = null
function key(): Buffer {
  if (!cachedKey) cachedKey = getServerKey()
  return cachedKey
}

export function serverEncrypt(plaintext: Buffer): Buffer {
  const iv = randomBytes(IV_LEN)
  const cipher = createCipheriv(ALGO, key(), iv)
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag = cipher.getAuthTag()
  // Layout: [iv (12)][tag (16)][ciphertext]
  return Buffer.concat([iv, tag, encrypted])
}

export function serverDecrypt(blob: Buffer): Buffer {
  const iv = blob.subarray(0, IV_LEN)
  const tag = blob.subarray(IV_LEN, IV_LEN + TAG_LEN)
  const ciphertext = blob.subarray(IV_LEN + TAG_LEN)
  const decipher = createDecipheriv(ALGO, key(), iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()])
}
