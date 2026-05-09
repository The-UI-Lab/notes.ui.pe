import { useEffect, useRef, useState } from 'react'

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

const DISMISS_KEY = 'notes-install-dismissed-v1'
const SHOW_DELAY  = 8_000  // give the app a moment before nagging
const REMIND_AFTER_DAYS = 14

function recentlyDismissed(): boolean {
  const v = localStorage.getItem(DISMISS_KEY)
  if (!v) return false
  const ts = Number(v)
  if (!Number.isFinite(ts)) return true
  return Date.now() - ts < REMIND_AFTER_DAYS * 86_400_000
}

function isStandalone(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    // iOS Safari
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  )
}

function isIOS(): boolean {
  return /iphone|ipad|ipod/i.test(navigator.userAgent) && !/crios|fxios|edgios/i.test(navigator.userAgent)
}

export function InstallPrompt() {
  const promptEvent = useRef<BeforeInstallPromptEvent | null>(null)
  const [visible, setVisible] = useState(false)
  // 'native' => Android/Chromium beforeinstallprompt is available
  // 'ios'    => iOS Safari needs manual instructions
  const [mode, setMode] = useState<'native' | 'ios' | null>(null)

  useEffect(() => {
    if (isStandalone()) return
    if (recentlyDismissed()) return

    const onBeforeInstall = (e: Event) => {
      e.preventDefault()
      promptEvent.current = e as BeforeInstallPromptEvent
      setMode('native')
      setTimeout(() => setVisible(true), SHOW_DELAY)
    }
    window.addEventListener('beforeinstallprompt', onBeforeInstall)

    const onInstalled = () => {
      setVisible(false)
      promptEvent.current = null
    }
    window.addEventListener('appinstalled', onInstalled)

    // iOS doesn't fire `beforeinstallprompt`. Show manual hint after a delay.
    let iosTimer: ReturnType<typeof setTimeout> | null = null
    if (isIOS()) {
      iosTimer = setTimeout(() => {
        if (!isStandalone()) {
          setMode('ios')
          setVisible(true)
        }
      }, SHOW_DELAY)
    }

    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstall)
      window.removeEventListener('appinstalled', onInstalled)
      if (iosTimer) clearTimeout(iosTimer)
    }
  }, [])

  const dismiss = () => {
    localStorage.setItem(DISMISS_KEY, String(Date.now()))
    setVisible(false)
  }

  const install = async () => {
    const ev = promptEvent.current
    if (!ev) return
    try {
      await ev.prompt()
      const choice = await ev.userChoice
      if (choice.outcome !== 'accepted') {
        // Dismiss for a while either way; user can re-trigger from browser menu.
        localStorage.setItem(DISMISS_KEY, String(Date.now()))
      }
    } finally {
      promptEvent.current = null
      setVisible(false)
    }
  }

  if (!visible || !mode) return null

  return (
    <div className="install-banner" role="dialog" aria-label="Install Notes">
      <div className="install-banner-icon" aria-hidden="true">
        <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
          <rect x="4" y="2" width="14" height="18" rx="3" stroke="currentColor" strokeWidth="1.7"/>
          <path d="M11 7v6M8 10l3 3 3-3" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </div>
      <div className="install-banner-text">
        <strong>Install Notes</strong>
        <span>
          {mode === 'ios'
            ? <>Tap <em>Share</em> then <em>“Add to Home Screen”</em> for an offline app.</>
            : <>Get a faster, offline-first experience right on your home screen.</>}
        </span>
      </div>
      <div className="install-banner-actions">
        {mode === 'native' && (
          <button className="install-banner-cta" onClick={install}>Install</button>
        )}
        <button className="install-banner-dismiss" onClick={dismiss} aria-label="Dismiss">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
          </svg>
        </button>
      </div>
    </div>
  )
}
