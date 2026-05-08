/**
 * Minimal AWS Signature Version 4 + S3 REST API helpers for browser use.
 *
 * Requirements for the S3 bucket:
 *   1. CORS must allow the PWA origin (PUT, GET, HEAD, DELETE + preflight OPTIONS).
 *   2. The IAM credentials need s3:GetObject, s3:PutObject, s3:ListBucket.
 */

export interface S3Config {
  bucket: string
  region: string
  accessKeyId: string
  secretAccessKey: string
}

export interface BackupItem {
  key: string
  lastModified: string
  size: number
}

// ── Crypto helpers ─────────────────────────────────────────────────────────

async function sha256Hex(message: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(message))
  return toHex(buf)
}

async function sha256BufHex(data: ArrayBuffer): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', data)
  return toHex(buf)
}

async function hmacSha256(key: ArrayBuffer | Uint8Array, message: string): Promise<ArrayBuffer> {
  const rawKey = key instanceof Uint8Array ? key.buffer as ArrayBuffer : key
  const cryptoKey = await crypto.subtle.importKey(
    'raw', rawKey, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  )
  return crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(message))
}

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')
}

// ── Signature V4 ──────────────────────────────────────────────────────────

function nowStrings(): { date: string; dateTime: string } {
  const now      = new Date()
  const dateTime = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
  const date     = dateTime.slice(0, 8)
  return { date, dateTime }
}

async function signingKey(
  secretAccessKey: string,
  date: string,
  region: string,
): Promise<ArrayBuffer> {
  const kDate    = await hmacSha256(new TextEncoder().encode('AWS4' + secretAccessKey).buffer as ArrayBuffer, date)
  const kRegion  = await hmacSha256(kDate, region)
  const kService = await hmacSha256(kRegion, 's3')
  return hmacSha256(kService, 'aws4_request')
}

async function buildAuthHeaders(
  method: string,
  url: URL,
  extraHeaders: Record<string, string>,
  body: ArrayBuffer | null,
  config: S3Config,
): Promise<Record<string, string>> {
  const { date, dateTime } = nowStrings()
  const payloadHash = body ? await sha256BufHex(body) : await sha256Hex('')

  const headers: Record<string, string> = {
    ...extraHeaders,
    host:                    url.hostname,
    'x-amz-date':           dateTime,
    'x-amz-content-sha256': payloadHash,
  }

  const sortedKeys      = Object.keys(headers).sort()
  const canonicalHeaders = sortedKeys.map(k => `${k}:${headers[k].trim()}`).join('\n') + '\n'
  const signedHeaders    = sortedKeys.join(';')
  const canonicalRequest = [
    method,
    url.pathname,
    url.searchParams.toString(),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n')

  const credScope  = `${date}/${config.region}/s3/aws4_request`
  const strToSign  = ['AWS4-HMAC-SHA256', dateTime, credScope, await sha256Hex(canonicalRequest)].join('\n')
  const key        = await signingKey(config.secretAccessKey, date, config.region)
  const signature  = toHex(await hmacSha256(key, strToSign))

  return {
    ...headers,
    Authorization: `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${credScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  }
}

function s3Url(config: S3Config, path: string): URL {
  return new URL(`https://${config.bucket}.s3.${config.region}.amazonaws.com${path}`)
}

// ── Public API ─────────────────────────────────────────────────────────────

/** Lists all `.enc` objects under the `notes-backup-` prefix. */
export async function listBackups(config: S3Config): Promise<BackupItem[]> {
  const url = s3Url(config, '/')
  url.searchParams.set('list-type', '2')
  url.searchParams.set('prefix', 'notes-backup-')

  const headers = await buildAuthHeaders('GET', url, {}, null, config)
  const res = await fetch(url.toString(), { headers })
  if (!res.ok) throw new Error(`S3 list failed (${res.status}): ${await res.text()}`)

  const doc      = new DOMParser().parseFromString(await res.text(), 'application/xml')
  const contents = doc.querySelectorAll('Contents')
  return Array.from(contents)
    .map(c => ({
      key:          c.querySelector('Key')?.textContent ?? '',
      lastModified: c.querySelector('LastModified')?.textContent ?? '',
      size:         parseInt(c.querySelector('Size')?.textContent ?? '0', 10),
    }))
    .filter(b => b.key.endsWith('.enc'))
}

/** Uploads an encrypted backup blob. */
export async function uploadBackup(
  config: S3Config,
  key: string,
  data: ArrayBuffer,
): Promise<void> {
  const url     = s3Url(config, `/${key}`)
  const headers = await buildAuthHeaders(
    'PUT', url,
    { 'content-type': 'application/octet-stream', 'content-length': String(data.byteLength) },
    data,
    config,
  )
  const res = await fetch(url.toString(), { method: 'PUT', headers, body: data })
  if (!res.ok) throw new Error(`S3 upload failed (${res.status}): ${await res.text()}`)
}

/** Downloads an encrypted backup blob. */
export async function downloadBackup(config: S3Config, key: string): Promise<ArrayBuffer> {
  const url     = s3Url(config, `/${key}`)
  const headers = await buildAuthHeaders('GET', url, {}, null, config)
  const res = await fetch(url.toString(), { headers })
  if (!res.ok) throw new Error(`S3 download failed (${res.status}): ${await res.text()}`)
  return res.arrayBuffer()
}
