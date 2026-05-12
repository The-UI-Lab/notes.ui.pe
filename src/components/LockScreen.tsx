import { useState, useRef, useEffect, useCallback } from 'react'
import { unlockWithPin } from '../utils/vault'

// ── Brute-force throttling ──────────────────────────────────────────────────

const LOCKOUT_KEY = 'notes-pin-lockout'
const MAX_ATTEMPTS = 5
const BASE_LOCKOUT_MS = 30_000 // 30 seconds, doubles each escalation

interface LockoutState {
  attempts: number
  lockedUntil: number // epoch ms, 0 = not locked
  escalation: number  // how many times we've hit the limit
}

function getLockout(): LockoutState {
  try {
    const raw = localStorage.getItem(LOCKOUT_KEY)
    if (!raw) return { attempts: 0, lockedUntil: 0, escalation: 0 }
    return JSON.parse(raw) as LockoutState
  } catch { return { attempts: 0, lockedUntil: 0, escalation: 0 } }
}

function setLockout(state: LockoutState): void {
  localStorage.setItem(LOCKOUT_KEY, JSON.stringify(state))
}

function clearLockout(): void {
  localStorage.removeItem(LOCKOUT_KEY)
}

function getRemainingLockMs(): number {
  const state = getLockout()
  if (!state.lockedUntil) return 0
  return Math.max(0, state.lockedUntil - Date.now())
}

function recordFailedAttempt(): LockoutState {
  const state = getLockout()
  state.attempts += 1
  if (state.attempts >= MAX_ATTEMPTS) {
    const lockMs = BASE_LOCKOUT_MS * Math.pow(2, state.escalation)
    state.lockedUntil = Date.now() + lockMs
    state.escalation += 1
    state.attempts = 0
  }
  setLockout(state)
  return state
}

// ── Component ───────────────────────────────────────────────────────────────

interface LockScreenProps {
  onUnlocked: () => void
}

export function LockScreen({ onUnlocked }: LockScreenProps) {
  const [pin, setPin] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [lockedMs, setLockedMs] = useState<number>(getRemainingLockMs)
  const inputRef = useRef<HTMLInputElement>(null)

  // Countdown timer for lockout display
  useEffect(() => {
    if (lockedMs <= 0) return
    const timer = setInterval(() => {
      const remaining = getRemainingLockMs()
      setLockedMs(remaining)
      if (remaining <= 0) { clearInterval(timer); setError(null) }
    }, 1000)
    return () => clearInterval(timer)
  }, [lockedMs])

  useEffect(() => {
    if (lockedMs <= 0) inputRef.current?.focus()
  }, [lockedMs])

  const handleSubmit = useCallback(async (e?: React.FormEvent) => {
    e?.preventDefault()
    if (!pin.trim() || busy) return

    // Check lockout before attempting
    const remaining = getRemainingLockMs()
    if (remaining > 0) {
      setLockedMs(remaining)
      return
    }

    setBusy(true)
    setError(null)

    const ok = await unlockWithPin(pin)
    if (ok) {
      clearLockout()
      onUnlocked()
    } else {
      const state = recordFailedAttempt()
      const lockRemaining = getRemainingLockMs()
      if (lockRemaining > 0) {
        setLockedMs(lockRemaining)
        setError(`Too many attempts. Try again in ${Math.ceil(lockRemaining / 1000)}s.`)
      } else {
        const left = MAX_ATTEMPTS - state.attempts
        setError(`Incorrect PIN. ${left} attempt${left === 1 ? '' : 's'} remaining.`)
      }
      setPin('')
      setBusy(false)
      inputRef.current?.focus()
    }
  }, [pin, busy, onUnlocked])

  return (
    <div className="lock-screen">
      <div className="lock-screen-card">
        <div className="lock-screen-icon">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
            <circle cx="12" cy="16" r="1" />
          </svg>
        </div>
        <h2 className="lock-screen-title">Notes Locked</h2>
        <p className="lock-screen-hint">Enter your PIN to unlock</p>
        <form onSubmit={handleSubmit} className="lock-screen-form">
          <input
            ref={inputRef}
            type="password"
            inputMode="numeric"
            className="lock-screen-input"
            placeholder="PIN"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            autoComplete="off"
            disabled={busy || lockedMs > 0}
            maxLength={32}
          />
          {error && <p className="lock-screen-error">{error}</p>}
          <button
            type="submit"
            className="lock-screen-btn"
            disabled={!pin.trim() || busy || lockedMs > 0}
          >
            {lockedMs > 0
              ? `Locked (${Math.ceil(lockedMs / 1000)}s)`
              : busy ? 'Unlocking…' : 'Unlock'}
          </button>
        </form>
      </div>
    </div>
  )
}
