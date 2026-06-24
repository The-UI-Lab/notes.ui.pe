import { test } from 'node:test'
import assert from 'node:assert/strict'
import { encryptBackup, decryptBackup } from './crypto.ts'

test('round-trips a UTF-8 string', async () => {
  const plaintext = 'hello, 世界 🌍 — notes backup'
  const blob = await encryptBackup('correct horse battery staple', plaintext)
  const out = await decryptBackup('correct horse battery staple', blob)
  assert.equal(out, plaintext)
})

test('produces a salt+iv prefixed blob larger than the plaintext', async () => {
  const blob = await encryptBackup('pw', 'short')
  // 16-byte salt + 12-byte iv + ciphertext + 16-byte GCM tag
  assert.ok(blob.byteLength >= 16 + 12 + 16)
})

test('uses a random salt+iv so two encryptions differ', async () => {
  const a = new Uint8Array(await encryptBackup('pw', 'same input'))
  const b = new Uint8Array(await encryptBackup('pw', 'same input'))
  assert.notDeepEqual(Array.from(a), Array.from(b))
})

test('rejects decryption with the wrong password', async () => {
  const blob = await encryptBackup('right', 'secret data')
  await assert.rejects(() => decryptBackup('wrong', blob))
})

test('rejects a truncated / tampered blob', async () => {
  const blob = await encryptBackup('pw', 'secret data')
  const bytes = new Uint8Array(blob)
  bytes[bytes.length - 1] ^= 0xff // flip a ciphertext/tag bit
  await assert.rejects(() => decryptBackup('pw', bytes.buffer))
})
