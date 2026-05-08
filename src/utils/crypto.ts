/**
 * Backup encryption utilities — PBKDF2 key derivation + AES-GCM encryption.
 *
 * Binary layout of an encrypted backup blob:
 *   [ salt (16 bytes) | iv (12 bytes) | ciphertext (variable) ]
 */

const PBKDF2_ITERATIONS = 150_000

async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveKey'],
  )
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt.buffer as ArrayBuffer, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

/** Encrypts a UTF-8 string and returns an ArrayBuffer. */
export async function encryptBackup(password: string, plaintext: string): Promise<ArrayBuffer> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv   = crypto.getRandomValues(new Uint8Array(12))
  const key  = await deriveKey(password, salt)

  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(plaintext),
  )

  const result = new Uint8Array(16 + 12 + ciphertext.byteLength)
  result.set(salt, 0)
  result.set(iv, 16)
  result.set(new Uint8Array(ciphertext), 28)
  return result.buffer
}

/** Decrypts an ArrayBuffer produced by `encryptBackup` and returns the original string. */
export async function decryptBackup(password: string, data: ArrayBuffer): Promise<string> {
  const bytes     = new Uint8Array(data)
  const salt      = bytes.slice(0, 16)
  const iv        = bytes.slice(16, 28)
  const ciphertext = bytes.slice(28)

  const key = await deriveKey(password, salt)
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    ciphertext,
  )
  return new TextDecoder().decode(plaintext)
}
