import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseFbConnections } from './facebook.ts'

test('returns null for empty / nullish input', () => {
  assert.equal(parseFbConnections(null), null)
  assert.equal(parseFbConnections(undefined), null)
  assert.equal(parseFbConnections(''), null)
})

test('returns null for an encrypted vault payload (needs async load)', () => {
  assert.equal(parseFbConnections('v1:abc123=='), null)
})

test('returns null for malformed JSON', () => {
  assert.equal(parseFbConnections('{not json'), null)
})

test('parses a v2 connections object and keeps the stored default', () => {
  const raw = JSON.stringify({
    v: 2,
    pages: [
      { id: '1', name: 'Page One', accessToken: 'tok1', category: 'x', picture: null },
      { id: '2', name: 'Page Two', accessToken: 'tok2', category: 'y', picture: null },
    ],
    defaultPageId: '2',
  })
  const conn = parseFbConnections(raw)
  assert.ok(conn)
  assert.equal(conn!.v, 2)
  assert.equal(conn!.pages.length, 2)
  assert.equal(conn!.defaultPageId, '2')
})

test('falls back to the first page when defaultPageId is unknown', () => {
  const raw = JSON.stringify({
    v: 2,
    pages: [{ id: '1', name: 'Only', accessToken: 'tok', category: '', picture: null }],
    defaultPageId: 'does-not-exist',
  })
  const conn = parseFbConnections(raw)
  assert.equal(conn!.defaultPageId, '1')
})

test('drops pages missing an id or access token', () => {
  const raw = JSON.stringify({
    v: 2,
    pages: [
      { id: '1', name: 'Good', accessToken: 'tok', category: '', picture: null },
      { id: '2', name: 'No token', accessToken: '', category: '', picture: null },
      { name: 'No id', accessToken: 'tok3' },
    ],
    defaultPageId: '1',
  })
  const conn = parseFbConnections(raw)
  assert.equal(conn!.pages.length, 1)
  assert.equal(conn!.pages[0].id, '1')
})

test('migrates a legacy v1 single-page shape to v2', () => {
  const raw = JSON.stringify({ accessToken: 'legacy-tok', pageId: '99' })
  const conn = parseFbConnections(raw)
  assert.ok(conn)
  assert.equal(conn!.v, 2)
  assert.equal(conn!.pages.length, 1)
  assert.equal(conn!.pages[0].id, '99')
  assert.equal(conn!.pages[0].accessToken, 'legacy-tok')
  assert.equal(conn!.defaultPageId, '99')
})
