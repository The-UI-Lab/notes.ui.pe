/**
 * Facebook Graph API helpers — minimal browser-side client for posting to a
 * Page from the user's stored access token. CORS is supported by graph.facebook.com
 * for these endpoints, so we can call them directly without a backend.
 *
 * Important limitation we surface to callers:
 *   - Updating an existing post can change the *message* only. Photos attached
 *     to a post cannot be added/removed/replaced via Graph API after publish.
 */

const GRAPH = 'https://graph.facebook.com/v19.0'

export interface FbSettings {
  accessToken: string
  pageId: string
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

/** Convert a data URL to a Blob (for multipart uploads). */
async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  const res = await fetch(dataUrl)
  return res.blob()
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

/**
 * Publishes a note to the connected Facebook Page.
 *
 * Returns the canonical post id (e.g. `{pageId}_{postId}`) and a URL.
 */
export async function publishNoteToPage(
  settings: FbSettings,
  message: string,
  images: string[],
): Promise<{ id: string; url: string }> {
  const { accessToken, pageId } = settings
  const trimmed = message.trim()

  // ── No images → simple feed post ────────────────────────────────────────
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

  // ── Single image → /photos with caption ─────────────────────────────────
  if (images.length === 1) {
    const blob = await dataUrlToBlob(images[0])
    const form = new FormData()
    form.append('source', blob, 'image.jpg')
    if (trimmed) form.append('caption', trimmed)
    form.append('access_token', accessToken)
    const json = await graphFetch<{ id: string; post_id?: string }>(
      `${GRAPH}/${encodeURIComponent(pageId)}/photos`,
      { method: 'POST', body: form },
    )
    const id = json.post_id ?? json.id
    return { id, url: `https://www.facebook.com/${id}` }
  }

  // ── Multiple images → upload each unpublished, then attach to feed ──────
  const mediaIds: string[] = []
  for (const dataUrl of images) {
    const blob = await dataUrlToBlob(dataUrl)
    const form = new FormData()
    form.append('source', blob, 'image.jpg')
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

/** Updates the message of an existing post. Photos cannot be changed. */
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

/** Deletes a post from the connected page. */
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
