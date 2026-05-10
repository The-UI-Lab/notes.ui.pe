/**
 * Vault — transparent at-rest encryption for all sensitive data.
 *
 * Security model:
 *   1. A random 256-bit "vault key" is generated on first launch.
 *   2. All sensitive data (notes, credentials) is encrypted with AES-256-GCM
 *      using this key before writing to localStorage.
 *   3. The vault key is stored in IndexedDB as opaque bytes.
 *   4. (Optional) If the user sets a PIN, the vault key is wrapped (encrypted)
 *      with a PBKDF2-derived key from the PIN. The plaintext vault key is
 *      removed from IndexedDB — the user must enter the PIN to unlock.
 *   5. Without a PIN, the vault auto-unlocks on load (zero inconvenience).
 *
 * This protects against:
 *   - Browser extensions reading localStorage (they see ciphertext)
 *   - Physical access forensics (encrypted blobs, not plaintext JSON)
 *   - XSS reading localStorage (ciphertext without the IDB key is useless)
 *   - DevTools casual snooping (Application → Local Storage shows gibberish)
 *
 * The vault key is NEVER stored in localStorage — only in IndexedDB which is:
 *   - Origin-bound (same-origin policy)
 *   - Not accessible via simple document.cookie/localStorage XSS payloads
 *   - Requires async IDB access (harder to exfiltrate in a drive-by)
 */

const DB_NAME = 'notes-vault'
const DB_VERSION = 1
const STORE_NAME = 'vault'
const KEY_ID = 'vault-key'
const WRAPPED_KEY_ID = 'vault-key-wrapped'
const PIN_SALT_ID = 'vault-pin-salt'
const PIN_VERIFY_ID = 'vault-pin-verify'
const VAULT_MIGRATED_KEY = 'notes-vault-migrated-v1'

// ── State ─────────────────────────────────────────────────────────────────────

let vaultKey: CryptoKey | null = null
let vaultKeyRaw: Uint8Array | null = null  // raw bytes kept in memory for PIN wrapping
let isUnlocked = false

// ── IndexedDB helpers ─────────────────────────────────────────────────────────

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME)
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function idbGet(key: string): Promise<unknown> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly')
    const req = tx.objectStore(STORE_NAME).get(key)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function idbPut(key: string, value: unknown): Promise<void> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    tx.objectStore(STORE_NAME).put(value, key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

async function idbDelete(key: string): Promise<void> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    tx.objectStore(STORE_NAME).delete(key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

// ── Crypto primitives ─────────────────────────────────────────────────────────

const ALGO = 'AES-GCM'
const IV_LEN = 12

function generateVaultKeyBytes(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32))
}

async function importKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw.buffer as ArrayBuffer, ALGO, false, ['encrypt', 'decrypt'])
}

async function deriveKeyFromPin(pin: string, salt: Uint8Array): Promise<CryptoKey> {
  const enc = new TextEncoder()
  const baseKey = await crypto.subtle.importKey(
    'raw', enc.encode(pin).buffer as ArrayBuffer, 'PBKDF2', false, ['deriveKey']
  )
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt.buffer as ArrayBuffer, iterations: 600_000, hash: 'SHA-256' },
    baseKey,
    { name: ALGO, length: 256 },
    false,
    ['encrypt', 'decrypt']
  )
}

async function encryptRaw(key: CryptoKey, data: Uint8Array): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LEN))
  const ct = await crypto.subtle.encrypt({ name: ALGO, iv: iv.buffer as ArrayBuffer }, key, data.buffer as ArrayBuffer)
  // [iv (12)][ciphertext+tag]
  const out = new Uint8Array(IV_LEN + ct.byteLength)
  out.set(iv, 0)
  out.set(new Uint8Array(ct), IV_LEN)
  return out
}

async function decryptRaw(key: CryptoKey, blob: Uint8Array): Promise<Uint8Array> {
  const iv = blob.slice(0, IV_LEN)
  const ct = blob.slice(IV_LEN)
  const pt = await crypto.subtle.decrypt(
    { name: ALGO, iv: iv.buffer as ArrayBuffer }, key, ct.buffer as ArrayBuffer
  )
  return new Uint8Array(pt)
}

// ── PIN verification hash ─────────────────────────────────────────────────────

async function computePinVerify(pin: string, salt: Uint8Array): Promise<string> {
  const enc = new TextEncoder()
  const data = new Uint8Array([...salt, ...enc.encode(pin)])
  const hash = await crypto.subtle.digest('SHA-256', data.buffer as ArrayBuffer)
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('')
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Initialize the vault. Returns:
 *   - 'unlocked' if vault is ready (no PIN or first-time setup)
 *   - 'locked' if a PIN is required to unlock
 */
export async function initVault(): Promise<'unlocked' | 'locked'> {
  // Check if PIN is set (wrapped key exists)
  const wrapped = await idbGet(WRAPPED_KEY_ID) as Uint8Array | undefined
  if (wrapped) {
    // PIN is set — vault is locked until PIN is entered
    isUnlocked = false
    return 'locked'
  }

  // No PIN — load or create the vault key directly
  let rawKey = await idbGet(KEY_ID) as Uint8Array | undefined
  if (!rawKey) {
    // First launch — generate a new vault key
    rawKey = generateVaultKeyBytes()
    await idbPut(KEY_ID, rawKey)
  }

  vaultKey = await importKey(rawKey)
  vaultKeyRaw = rawKey
  isUnlocked = true

  // Run one-time migration if needed
  await migrateToEncrypted()

  return 'unlocked'
}

/**
 * Unlock the vault with a PIN. Returns true on success.
 */
export async function unlockWithPin(pin: string): Promise<boolean> {
  const salt = await idbGet(PIN_SALT_ID) as Uint8Array | undefined
  const wrapped = await idbGet(WRAPPED_KEY_ID) as Uint8Array | undefined
  const storedVerify = await idbGet(PIN_VERIFY_ID) as string | undefined

  if (!salt || !wrapped || !storedVerify) return false

  // Verify PIN first
  const verify = await computePinVerify(pin, salt)
  if (verify !== storedVerify) return false

  // Unwrap the vault key
  try {
    const pinKey = await deriveKeyFromPin(pin, salt)
    const rawKey = await decryptRaw(pinKey, wrapped)
    vaultKey = await importKey(rawKey)
    vaultKeyRaw = rawKey
    isUnlocked = true
    return true
  } catch {
    return false
  }
}

/**
 * Lock the vault (clear key from memory). Only useful if PIN is set.
 */
export function lockVault(): void {
  vaultKey = null
  vaultKeyRaw = null
  isUnlocked = false
}

/**
 * Set a PIN to protect the vault. The vault key is wrapped and the
 * plaintext key is removed from IndexedDB.
 */
export async function setPin(pin: string): Promise<void> {
  if (!vaultKey || !vaultKeyRaw || !isUnlocked) throw new Error('Vault must be unlocked to set PIN')

  const salt = crypto.getRandomValues(new Uint8Array(16))
  const pinKey = await deriveKeyFromPin(pin, salt)

  // Wrap the vault key with PIN-derived key
  const wrapped = await encryptRaw(pinKey, vaultKeyRaw)
  const verify = await computePinVerify(pin, salt)

  // Store wrapped key and remove plaintext from IDB
  await idbPut(WRAPPED_KEY_ID, wrapped)
  await idbPut(PIN_SALT_ID, salt)
  await idbPut(PIN_VERIFY_ID, verify)
  await idbDelete(KEY_ID)
}

/**
 * Remove the PIN. The vault key is stored directly in IndexedDB again.
 */
export async function removePin(): Promise<void> {
  if (!vaultKey || !vaultKeyRaw || !isUnlocked) throw new Error('Vault must be unlocked to remove PIN')

  // Store raw key back to IDB
  await idbPut(KEY_ID, vaultKeyRaw)

  // Remove wrapped key artifacts
  await idbDelete(WRAPPED_KEY_ID)
  await idbDelete(PIN_SALT_ID)
  await idbDelete(PIN_VERIFY_ID)
}

/**
 * Check if a PIN is configured.
 */
export async function hasPin(): Promise<boolean> {
  const wrapped = await idbGet(WRAPPED_KEY_ID)
  return !!wrapped
}

/**
 * Check if the vault is currently unlocked.
 */
export function vaultIsUnlocked(): boolean {
  return isUnlocked
}

// ── Encrypt / Decrypt for localStorage ────────────────────────────────────────

const CIPHER_PREFIX = 'v1:'  // prefix to distinguish encrypted from plaintext

/**
 * Encrypt a string value for storage.
 */
export async function vaultEncrypt(plaintext: string): Promise<string> {
  if (!vaultKey) throw new Error('Vault is locked')
  const enc = new TextEncoder()
  const encrypted = await encryptRaw(vaultKey, enc.encode(plaintext))
  // Store as base64 with prefix
  return CIPHER_PREFIX + uint8ToBase64(encrypted)
}

/**
 * Decrypt a stored value. If the value is not encrypted (no prefix),
 * returns it as-is (for backward compatibility during migration).
 */
export async function vaultDecrypt(stored: string): Promise<string> {
  if (!stored.startsWith(CIPHER_PREFIX)) {
    // Not encrypted — plaintext from before migration
    return stored
  }
  if (!vaultKey) throw new Error('Vault is locked')
  const blob = base64ToUint8(stored.slice(CIPHER_PREFIX.length))
  const dec = new TextDecoder()
  const decrypted = await decryptRaw(vaultKey, blob)
  return dec.decode(decrypted)
}

/**
 * Check if a value is already encrypted.
 */
export function isEncrypted(value: string | null): boolean {
  return !!value && value.startsWith(CIPHER_PREFIX)
}

// ── Secure localStorage wrapper ───────────────────────────────────────────────

// Keys that contain sensitive data and MUST be encrypted
const SENSITIVE_KEYS = new Set([
  'notes-app-v1',         // all notes
  'notes-s3-v1',          // S3 credentials
  'notes-fb-v1',          // Facebook token
  'notes-sync-password',  // sync encryption password
])

/**
 * Write to localStorage with automatic encryption for sensitive keys.
 */
export async function secureSet(key: string, value: string): Promise<void> {
  if (SENSITIVE_KEYS.has(key)) {
    const encrypted = await vaultEncrypt(value)
    localStorage.setItem(key, encrypted)
  } else {
    localStorage.setItem(key, value)
  }
}

/**
 * Read from localStorage with automatic decryption for sensitive keys.
 */
export async function secureGet(key: string): Promise<string | null> {
  const raw = localStorage.getItem(key)
  if (raw === null) return null
  if (SENSITIVE_KEYS.has(key) || raw.startsWith(CIPHER_PREFIX)) {
    return vaultDecrypt(raw)
  }
  return raw
}

// ── Migration: encrypt existing plaintext data ────────────────────────────────

async function migrateToEncrypted(): Promise<void> {
  if (localStorage.getItem(VAULT_MIGRATED_KEY) === '1') return
  if (!vaultKey) return

  for (const key of SENSITIVE_KEYS) {
    const raw = localStorage.getItem(key)
    if (raw && !raw.startsWith(CIPHER_PREFIX)) {
      const encrypted = await vaultEncrypt(raw)
      localStorage.setItem(key, encrypted)
    }
  }

  localStorage.setItem(VAULT_MIGRATED_KEY, '1')
}

// ── Base64 helpers ────────────────────────────────────────────────────────────

function uint8ToBase64(arr: Uint8Array): string {
  let bin = ''
  const chunk = 0x8000
  for (let i = 0; i < arr.length; i += chunk) {
    bin += String.fromCharCode(...arr.subarray(i, i + chunk))
  }
  return btoa(bin)
}

function base64ToUint8(b64: string): Uint8Array {
  const bin = atob(b64)
  const arr = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
  return arr
}
