/**
 * Facebook Graph API helpers — minimal browser-side client for posting to a
 * Page from the user's stored access token. CORS is supported for these
 * endpoints, so we can call them directly without a backend.
 *
 * Supported post shapes:
 *   - text-only         → POST /{page}/feed
 *   - 1 image           → POST /{page}/photos (with caption)
 *   - 2+ images         → POST /{page}/photos (published=false) for each,
 *                          then POST /{page}/feed with attached_media
 *   - 1 video           → POST /{page}/videos (with description)
 *
 * Mixing images + videos in a single Page post is not supported by the
 * Graph API and is rejected before upload.
 */

const GRAPH = 'https://graph.facebook.com/v19.0'

export interface FbSettings {
  accessToken: string
  pageId: string
}

export interface PublishMedia {
  blob: Blob
  type: 'image' | 'video'
}

const FB_KEY = 'notes-fb-v1'

export function loadFbSettings(): FbSettings | null {
  try {
    const raw = localStorage.getItem(FB_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<FbSettings>
    if (!parsed.accessToken || !parsed.pageId) return null
    return { accessToken: parsed.accessToken, pageId: parsed.pageId }
  } catch {
    return null
  }
}

interface GraphError {
  error?: { message?: string; code?: number; type?: string }
}

async function graphFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res  = await fetch(url, init)
  const json = (await res.json().catch(() => ({}))) as T & GraphError
  if (!res.ok || json.error) {
    throw new Error(json.error?.message ?? `Facebook API error (HTTP ${res.status})`)
  }
  return json
}

function extension(mime: string, fallback: string): string {
  const m = /\/([a-z0-9]+)/i.exec(mime)
  return m ? m[1].toLowerCase() : fallback
}

/**
 * Publishes a note to the connected Facebook Page.
 * Returns the canonical post id (e.g. `{pageId}_{postId}`).
 */
export async function publishNoteToPage(
  settings: FbSettings,
  message: string,
  media: PublishMedia[],
): Promise<{ id: string; url: string }> {
  const { accessToken, pageId } = settings
  const trimmed = message.trim()

  const images = media.filter(m => m.type === 'image')
  const videos = media.filter(m => m.type === 'video')

  if (images.length && videos.length) {
    throw new Error('Cannot post images and videos together. Keep one or the other.')
  }
  if (videos.length > 1) {
    throw new Error('Only one video per post is supported.')
  }

  // ── Single video ─────────────────────────────────────────────────────────
  if (videos.length === 1) {
    const v = videos[0]
    const form = new FormData()
    form.append('source', v.blob, `video.${extension(v.blob.type, 'mp4')}`)
    if (trimmed) form.append('description', trimmed)
    form.append('access_token', accessToken)
    const json = await graphFetch<{ id: string }>(
      `${GRAPH}/${encodeURIComponent(pageId)}/videos`,
      { method: 'POST', body: form },
    )
    // Graph returns just the video id; the wrapping post id surfaces shortly
    // after — we still link to the video directly.
    return { id: json.id, url: `https://www.facebook.com/${json.id}` }
  }

  // ── No media → text-only feed post ───────────────────────────────────────
  if (images.length === 0) {
    if (!trimmed) throw new Error('Cannot publish an empty note.')
    const form = new FormData()
    form.append('message', trimmed)
    form.append('access_token', accessToken)
    const json = await graphFetch<{ id: string }>(
      `${GRAPH}/${encodeURIComponent(pageId)}/feed`,
      { method: 'POST', body: form },
    )
    return { id: json.id, url: `https://www.facebook.com/${json.id}` }
  }

  // ── Single image → /photos with caption ──────────────────────────────────
  if (images.length === 1) {
    const img = images[0]
    const form = new FormData()
    form.append('source', img.blob, `image.${extension(img.blob.type, 'jpg')}`)
    if (trimmed) form.append('caption', trimmed)
    form.append('access_token', accessToken)
    const json = await graphFetch<{ id: string; post_id?: string }>(
      `${GRAPH}/${encodeURIComponent(pageId)}/photos`,
      { method: 'POST', body: form },
    )
    const id = json.post_id ?? json.id
    return { id, url: `https://www.facebook.com/${id}` }
  }

  // ── Multiple images → upload each unpublished, then attach to feed ───────
  const mediaIds: string[] = []
  for (const img of images) {
    const form = new FormData()
    form.append('source', img.blob, `image.${extension(img.blob.type, 'jpg')}`)
    form.append('published', 'false')
    form.append('access_token', accessToken)
    const json = await graphFetch<{ id: string }>(
      `${GRAPH}/${encodeURIComponent(pageId)}/photos`,
      { method: 'POST', body: form },
    )
    mediaIds.push(json.id)
  }

  const feedForm = new FormData()
  if (trimmed) feedForm.append('message', trimmed)
  mediaIds.forEach((mid, i) =>
    feedForm.append(`attached_media[${i}]`, JSON.stringify({ media_fbid: mid })),
  )
  feedForm.append('access_token', accessToken)
  const post = await graphFetch<{ id: string }>(
    `${GRAPH}/${encodeURIComponent(pageId)}/feed`,
    { method: 'POST', body: feedForm },
  )
  return { id: post.id, url: `https://www.facebook.com/${post.id}` }
}

/** Updates the message of an existing post. Photos/videos cannot be changed. */
export async function updatePostMessage(
  settings: FbSettings,
  postId: string,
  message: string,
): Promise<void> {
  const form = new FormData()
  form.append('message', message.trim())
  form.append('access_token', settings.accessToken)
  await graphFetch(`${GRAPH}/${encodeURIComponent(postId)}`, {
    method: 'POST',
    body: form,
  })
}

export async function deletePost(
  settings: FbSettings,
  postId: string,
): Promise<void> {
  const url = `${GRAPH}/${encodeURIComponent(postId)}?access_token=${encodeURIComponent(settings.accessToken)}`
  await graphFetch(url, { method: 'DELETE' })
}

export function postUrl(postId: string): string {
  return `https://www.facebook.com/${postId}`
}

export function pageUrl(pageId: string): string {
  return `https://www.facebook.com/${encodeURIComponent(pageId)}`
}

// ── Insights ─────────────────────────────────────────────────────────────────

import type { FbPostInsight, FbPageInsightsSummary } from '../types'

/** Metrics we ask the Graph API for on each post. */
const POST_INSIGHT_METRICS = [
  'post_impressions',
  'post_impressions_unique',
  'post_engaged_users',
  'post_clicks',
  'post_reactions_by_type_total',
].join(',')

interface InsightValue {
  name: string
  values: { value: number | Record<string, number> }[]
}

interface PostFieldsResponse {
  shares?: { count: number }
  comments?: { summary?: { total_count: number } }
}

/**
 * Fetch insight metrics for a single post.
 * Note: Insights are only available for posts on Pages (not personal profiles)
 * and may be empty for very recent or very low-reach posts.
 */
export async function fetchPostInsights(
  settings: FbSettings,
  postId: string,
): Promise<FbPostInsight> {
  const esc = encodeURIComponent
  const base = `${GRAPH}/${esc(postId)}`
  const token = esc(settings.accessToken)

  // Fetch insights + basic engagement fields in parallel
  const [insightsJson, fieldsJson] = await Promise.all([
    graphFetch<{ data: InsightValue[] }>(
      `${base}/insights?metric=${POST_INSIGHT_METRICS}&access_token=${token}`,
    ).catch(() => ({ data: [] as InsightValue[] })),
    graphFetch<PostFieldsResponse>(
      `${base}?fields=shares,comments.summary(true).limit(0)&access_token=${token}`,
    ).catch(() => ({} as PostFieldsResponse)),
  ])

  const m = new Map(insightsJson.data.map(d => [d.name, d.values[0]?.value ?? 0]))

  const raw = (name: string): number => {
    const v = m.get(name)
    if (typeof v === 'number') return v
    if (typeof v === 'object') return Object.values(v).reduce((a, b) => a + b, 0)
    return 0
  }

  return {
    postId,
    fetchedAt: Date.now(),
    impressions: raw('post_impressions'),
    reach: raw('post_impressions_unique'),
    engagedUsers: raw('post_engaged_users'),
    clicks: raw('post_clicks'),
    reactions: raw('post_reactions_by_type_total'),
    comments: fieldsJson.comments?.summary?.total_count ?? 0,
    shares: fieldsJson.shares?.count ?? 0,
  }
}

interface PageInsightValue {
  name: string
  values: { value: number; end_time: string }[]
}

/**
 * Fetch page-level daily reach & impressions for the last 28 days.
 * Useful for the trend sparkline in the insights panel.
 */
export async function fetchPageDailyMetrics(
  settings: FbSettings,
): Promise<{ dailyReach: { date: string; value: number }[]; dailyImpressions: { date: string; value: number }[] }> {
  const esc = encodeURIComponent
  const token = esc(settings.accessToken)
  const pageId = esc(settings.pageId)

  const json = await graphFetch<{ data: PageInsightValue[] }>(
    `${GRAPH}/${pageId}/insights?metric=page_impressions,page_impressions_unique&period=day&access_token=${token}`,
  ).catch(() => ({ data: [] as PageInsightValue[] }))

  const extract = (name: string) =>
    (json.data.find(d => d.name === name)?.values ?? []).map(v => ({
      date: v.end_time.slice(0, 10),
      value: v.value,
    }))

  return {
    dailyImpressions: extract('page_impressions'),
    dailyReach: extract('page_impressions_unique'),
  }
}
