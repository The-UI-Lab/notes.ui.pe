import { useState, useRef, useEffect, useCallback } from 'react'
import { unlockWithPin } from '../utils/vault'

interface LockScreenProps {
  onUnlocked: () => void
}

export function LockScreen({ onUnlocked }: LockScreenProps) {
  const [pin, setPin] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const handleSubmit = useCallback(async (e?: React.FormEvent) => {
    e?.preventDefault()
    if (!pin.trim() || busy) return
    setBusy(true)
    setError(null)

    const ok = await unlockWithPin(pin)
    if (ok) {
      onUnlocked()
    } else {
      setError('Incorrect PIN')
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
            disabled={busy}
            maxLength={32}
          />
          {error && <p className="lock-screen-error">{error}</p>}
          <button
            type="submit"
            className="lock-screen-btn"
            disabled={!pin.trim() || busy}
          >
            {busy ? 'Unlocking…' : 'Unlock'}
          </button>
        </form>
      </div>
    </div>
  )
}
