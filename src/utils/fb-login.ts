/**
 * Facebook Login SDK integration.
 *
 * Flow:
 *   1. Load the FB JS SDK (lazily, once)
 *   2. Call FB.login() to get a short-lived user access token
 *   3. Send that token to our server (POST /api/fb/exchange-token)
 *   4. Server exchanges it for a long-lived user token → fetches pages
 *      with permanent page access tokens
 *   5. User picks a page → we store the page token + page ID locally
 */

const FB_APP_ID = import.meta.env.VITE_FB_APP_ID as string | undefined
const GRAPH_VERSION = 'v19.0'

// Permissions needed for publishing + insights
const SCOPES = [
  'pages_manage_posts',
  'pages_read_engagement',
  'pages_show_list',
].join(',')

// ── SDK Loader ────────────────────────────────────────────────────────────────

let sdkReady: Promise<void> | null = null

declare global {
  interface Window {
    fbAsyncInit?: () => void
    FB?: {
      init: (params: { appId: string; version: string; cookie?: boolean; xfbml?: boolean }) => void
      login: (
        cb: (response: { authResponse?: { accessToken: string }; status: string }) => void,
        opts?: {
          scope: string
          return_scopes?: boolean
          auth_type?: 'rerequest' | 'reauthorize' | 'reauthenticate'
          /** Forces the granular permission / page selector dialog to re-appear. */
          enable_profile_selector?: boolean
        },
      ) => void
      getLoginStatus: (
        cb: (response: { authResponse?: { accessToken: string }; status: string }) => void,
      ) => void
      logout: (cb?: () => void) => void
    }
  }
}

function loadSdk(): Promise<void> {
  if (sdkReady) return sdkReady

  sdkReady = new Promise<void>((resolve, reject) => {
    if (window.FB) { resolve(); return }

    window.fbAsyncInit = () => {
      if (!FB_APP_ID) { reject(new Error('VITE_FB_APP_ID is not configured.')); return }
      window.FB!.init({
        appId: FB_APP_ID,
        version: GRAPH_VERSION,
        cookie: false,
        xfbml: false,
      })
      resolve()
    }

    // Inject the SDK script
    const script = document.createElement('script')
    script.id = 'facebook-jssdk'
    script.src = `https://connect.facebook.net/en_US/sdk.js`
    script.async = true
    script.defer = true
    script.onerror = () => {
      sdkReady = null
      reject(new Error('Failed to load Facebook SDK. Check your network or ad blocker.'))
    }
    document.head.appendChild(script)
  })

  return sdkReady
}

// ── Login Flow ────────────────────────────────────────────────────────────────

export interface FbPage {
  id: string
  name: string
  accessToken: string
  category: string
  picture: string | null
}

/**
 * Triggers the Facebook Login popup and returns the list of pages
 * the user manages (with permanent access tokens).
 *
 * Throws if the user cancels or something goes wrong.
 */
export async function connectFacebookPages(): Promise<FbPage[]> {
  if (!FB_APP_ID) {
    throw new Error('Facebook App ID is not configured. Set VITE_FB_APP_ID in your environment.')
  }

  await loadSdk()

  // Revoke page-related permissions from any existing session before
  // opening the login popup. This is the critical step that makes the
  // page selector re-appear fresh every time.
  //
  // Root cause of the missing-page bug: `auth_type: 'rerequest'` only
  // re-asks for *declined* permissions. Because `pages_show_list` was
  // already granted (for the original set of pages), Facebook silently
  // returns the *same cached token* — it never issues a new one that
  // includes pages the user tries to add later. Revoking the permissions
  // first forces Facebook to treat the next login as a first-time grant,
  // so the full page-selector dialog is shown and a genuinely new token
  // (covering exactly the pages selected this time) is returned.
  await new Promise<void>((resolve) => {
    window.FB!.getLoginStatus(async (status) => {
      if (status.authResponse?.accessToken) {
        try {
          // Revoke all previously granted page permissions so the next
          // FB.login() call re-presents the full page-selector dialog.
          await fetch(
            `https://graph.facebook.com/v19.0/me/permissions?` +
            `access_token=${encodeURIComponent(status.authResponse.accessToken)}`,
            { method: 'DELETE' },
          )
        } catch {
          // Best-effort — if the revocation fails we still proceed with
          // the login; the user may see stale page data in the worst case.
        }
      }
      resolve()
    })
  })

  // Fresh login — because permissions were just revoked (or there was no
  // prior session), Facebook will show the full consent screen including
  // the page selector, and will issue a brand-new user access token.
  const userToken = await new Promise<string>((resolve, reject) => {
    window.FB!.login((response) => {
      if (response.authResponse?.accessToken) {
        resolve(response.authResponse.accessToken)
      } else {
        reject(new Error('Facebook login was cancelled or failed.'))
      }
    }, { scope: SCOPES, return_scopes: true })
  })

  // Exchange for permanent page tokens via our server
  const res = await fetch('/api/fb/exchange-token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userAccessToken: userToken }),
  })

  const json = await res.json() as { pages?: FbPage[]; error?: string }

  if (!res.ok || !json.pages) {
    throw new Error(json.error ?? 'Failed to exchange token.')
  }

  if (json.pages.length === 0) {
    throw new Error('No Facebook Pages found. Make sure you manage at least one Page and granted all permissions.')
  }

  return json.pages
}

/**
 * Returns true if the FB App ID is configured (feature is available).
 */
export function isFbLoginAvailable(): boolean {
  return Boolean(FB_APP_ID)
}
