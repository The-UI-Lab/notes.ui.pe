import { test } from 'node:test'
import assert from 'node:assert/strict'
import { base64ToBlob, blobToBase64 } from './media.ts'

test('base64 <-> blob round-trips binary data', async () => {
  const bytes = new Uint8Array([0, 1, 2, 250, 251, 255, 128, 64])
  const b64 = btoa(String.fromCharCode(...bytes))
  const blob = base64ToBlob(b64, 'application/octet-stream')
  assert.equal(blob.type, 'application/octet-stream')
  assert.equal(blob.size, bytes.length)
  const reencoded = await blobToBase64(blob)
  assert.equal(reencoded, b64)
})

test('blobToBase64 handles a large (>32KB chunk boundary) blob', async () => {
  const bytes = new Uint8Array(70_000)
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256
  const blob = new Blob([bytes], { type: 'image/webp' })
  const b64 = await blobToBase64(blob)
  const roundTripped = base64ToBlob(b64, 'image/webp')
  assert.equal(roundTripped.size, bytes.length)
  const out = new Uint8Array(await roundTripped.arrayBuffer())
  assert.deepEqual(Array.from(out.slice(0, 8)), [0, 1, 2, 3, 4, 5, 6, 7])
})
