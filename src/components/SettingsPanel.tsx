import { useState, useCallback, useEffect } from 'react'
import type { Note } from '../types'
import { encryptBackup, decryptBackup } from '../utils/crypto'
import {
  listBackups,
  uploadBackup,
  downloadBackup,
  type BackupItem,
  type S3Config,
} from '../utils/s3'
import {
  getAllMedia,
  putMedia,
  blobToBase64,
  base64ToBlob,
  getStorageInfo,
  requestPersistentStorage,
  pruneOrphans,
  type MediaRecord,
  type StorageInfo,
} from '../utils/media'
import {
  isSyncEnabled,
  enableSync,
  disableSync,
  getSyncPassword,
  type SyncState,
} from '../utils/sync'
import {
  hasPin as checkHasPin,
  setPin as vaultSetPin,
  removePin as vaultRemovePin,
  secureGet,
  secureSet,
} from '../utils/vault'

// ── Export helper ──────────────────────────────────────────────────────────

function exportNotes(notes: Note[]): void {
  if (!notes.length) return
  const lines = (body: string) => body.split('\n')
  const text = [...notes]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((n) => {
      const title = lines(n.body)[0].trim().slice(0, 80) || 'Untitled'
      const date  = new Date(n.createdAt).toLocaleDateString('en', { year: 'numeric', month: 'long', day: 'numeric' })
      return `# ${title}\n${date}\n\n${n.body}`
    })
    .join('\n\n---\n\n')
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
  const url  = URL.createObjectURL(blob)
  const a    = document.createElement('a')
  a.href     = url
  a.download = `notes-${new Date().toISOString().slice(0, 10)}.txt`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

// ── Types ──────────────────────────────────────────────────────────────────

export type Theme = 'system' | 'light' | 'dark'

interface FbSettings {
  accessToken: string
  pageId: string
}

interface BackupMedia {
  id: string
  type: 'image' | 'video'
  mime: string
  size: number
  width?: number
  height?: number
  durationMs?: number
  createdAt: number
  data: string  // base64-encoded blob bytes
}

interface BackupPayload {
  v: 2
  notes: Note[]
  media: BackupMedia[]
}

// ── Persistence keys ───────────────────────────────────────────────────────

const FB_KEY = 'notes-fb-v1'
const S3_KEY = 'notes-s3-v1'

function loadJsonSync<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    // If encrypted (vault prefix), return fallback — will be loaded async
    if (raw && raw.startsWith('v1:')) return fallback
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

async function loadJsonAsync<T>(key: string, fallback: T): Promise<T> {
  try {
    const raw = await secureGet(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

async function saveJsonAsync(key: string, value: unknown): Promise<void> {
  await secureSet(key, JSON.stringify(value))
}

const FB_FALLBACK: FbSettings  = { accessToken: '', pageId: '' }
const S3_FALLBACK: S3Config    = { bucket: '', region: '', accessKeyId: '', secretAccessKey: '' }

// ── Icons (inline SVGs as components for reuse) ────────────────────────────

function ChevronRight() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path d="M4.5 2.5l3.5 3.5-3.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  )
}

// ── Props ──────────────────────────────────────────────────────────────────

interface Props {
  theme: Theme
  setTheme: (t: Theme) => void
  notes: Note[]
  onRestoreNotes: (notes: Note[]) => void
  settingsPage: 'home' | 'facebook' | 's3' | 'sync' | 'security'
  setSettingsPage: (p: 'home' | 'facebook' | 's3' | 'sync' | 'security') => void
  syncState: SyncState
  onTriggerSync: () => void
  onSyncEnabled: () => void
  onSyncDisabled: () => void
  onLockApp: () => void
}

// ── Main component ─────────────────────────────────────────────────────────

export function SettingsPanel({
  theme,
  setTheme,
  notes,
  onRestoreNotes,
  settingsPage,
  setSettingsPage,
  syncState,
  onTriggerSync,
  onSyncEnabled,
  onSyncDisabled,
  onLockApp,
}: Props) {
  // ── Facebook state ───────────────────────────────────────────
  const [fb,      setFb]      = useState<FbSettings>(() => loadJsonSync(FB_KEY, FB_FALLBACK))
  const [fbDraft, setFbDraft] = useState<FbSettings>(fb)

  // ── S3 state ───────────────────────────────────────────────
  const [s3,      setS3]      = useState<S3Config>(() => loadJsonSync(S3_KEY, S3_FALLBACK))
  const [s3Draft, setS3Draft] = useState<S3Config>(s3)
  const [s3Saved, setS3Saved] = useState(false)

  // Load encrypted credentials from vault on mount
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const [fbLoaded, s3Loaded] = await Promise.all([
        loadJsonAsync<FbSettings>(FB_KEY, FB_FALLBACK),
        loadJsonAsync<S3Config>(S3_KEY, S3_FALLBACK),
      ])
      if (cancelled) return
      setFb(fbLoaded); setFbDraft(fbLoaded)
      setS3(s3Loaded); setS3Draft(s3Loaded)
    })()
    return () => { cancelled = true }
  }, [])

  // ── Backup list state ──────────────────────────────────────────────────
  const [backups,       setBackups]       = useState<BackupItem[]>([])
  const [backupsLoaded, setBackupsLoaded] = useState(false)
  const [backupsLoading, setBackupsLoading] = useState(false)
  const [backupsError,  setBackupsError]  = useState<string | null>(null)

  // ── Operation feedback ─────────────────────────────────────────────────
  const [s3Status, setS3Status] = useState<{ ok: boolean; msg: string } | null>(null)

  // ── Password modal state ───────────────────────────────────────────────
  const [modal,       setModal]       = useState<{ mode: 'backup' | 'restore'; key?: string } | null>(null)
  const [password,    setPassword]    = useState('')
  const [pwdError,    setPwdError]    = useState('')
  const [opRunning,   setOpRunning]   = useState(false)

  // ── Storage info ───────────────────────────────────────────────────────
  const [storage, setStorage] = useState<StorageInfo>({ usage: null, quota: null, persisted: false })
  const refreshStorage = useCallback(() => {
    getStorageInfo().then(setStorage).catch(() => {})
  }, [])
  useEffect(() => {
    if (settingsPage === 'home') refreshStorage()
  }, [settingsPage, notes.length, refreshStorage])

  const s3Complete = Boolean(s3.bucket && s3.region && s3.accessKeyId && s3.secretAccessKey)

  // ── Load backups whenever we enter the S3 page with valid creds ────────
  const fetchBackups = useCallback(async (config: S3Config) => {
    setBackupsLoading(true)
    setBackupsError(null)
    try {
      const list = await listBackups(config)
      setBackups(list.sort((a, b) => b.lastModified.localeCompare(a.lastModified)))
      setBackupsLoaded(true)
    } catch (e) {
      setBackupsError((e as Error).message)
    } finally {
      setBackupsLoading(false)
    }
  }, [])

  useEffect(() => {
    if (settingsPage === 's3' && s3Complete && !backupsLoaded && !backupsLoading) {
      fetchBackups(s3)
    }
  }, [settingsPage, s3Complete, s3, backupsLoaded, backupsLoading, fetchBackups])

  // ── Handlers ───────────────────────────────────────────────────────────

  const saveFb = useCallback(() => {
    saveJsonAsync(FB_KEY, fbDraft).catch(() => {})
    setFb(fbDraft)
  }, [fbDraft])

  const saveS3 = useCallback(() => {
    saveJsonAsync(S3_KEY, s3Draft).catch(() => {})
    setS3(s3Draft)
    setS3Saved(true)
    setBackupsLoaded(false)
    setBackups([])
    setS3Status(null)
    fetchBackups(s3Draft)
    setTimeout(() => setS3Saved(false), 2000)
  }, [s3Draft, fetchBackups])

  const openBackupModal = useCallback(() => {
    setPassword('')
    setPwdError('')
    setModal({ mode: 'backup' })
  }, [])

  const openRestoreModal = useCallback((key: string) => {
    setPassword('')
    setPwdError('')
    setModal({ mode: 'restore', key })
  }, [])

  const submitPassword = useCallback(async () => {
    if (!password.trim()) { setPwdError('Password is required.'); return }
    if (!modal) return
    setOpRunning(true)
    setPwdError('')
    try {
      if (modal.mode === 'backup') {
        // Bundle notes + every media blob referenced by them.
        const referencedIds = new Set(notes.flatMap(n => n.media.map(m => m.id)))
        const all = await getAllMedia()
        const mediaBundle: BackupMedia[] = []
        for (const rec of all) {
          if (!referencedIds.has(rec.id)) continue
          mediaBundle.push({
            id: rec.id,
            mime: rec.mime,
            type: rec.type,
            size: rec.size,
            width: rec.width,
            height: rec.height,
            durationMs: rec.durationMs,
            createdAt: rec.createdAt,
            data: await blobToBase64(rec.blob),
          })
        }
        const payload = JSON.stringify({ v: 2, notes, media: mediaBundle } satisfies BackupPayload)
        const blob    = await encryptBackup(password, payload)
        const key     = `notes-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.enc`
        await uploadBackup(s3, key, blob)
        setS3Status({ ok: true, msg: `Backup uploaded (${notes.length} notes, ${mediaBundle.length} media).` })
        setModal(null)
        setPassword('')
        setBackupsLoaded(false)
        fetchBackups(s3)
      } else if (modal.mode === 'restore' && modal.key) {
        const blob = await downloadBackup(s3, modal.key)
        const json = await decryptBackup(password, blob)
        const parsed = JSON.parse(json) as BackupPayload | Note[]
        const restoredNotes = Array.isArray(parsed) ? parsed : parsed.notes
        const restoredMedia = Array.isArray(parsed) ? [] : (parsed.media ?? [])
        // Write blobs back into IDB before swapping notes.
        for (const m of restoredMedia) {
          const rec: MediaRecord = {
            id: m.id,
            type: m.type,
            mime: m.mime,
            blob: base64ToBlob(m.data, m.mime),
            size: m.size,
            width: m.width,
            height: m.height,
            durationMs: m.durationMs,
            createdAt: m.createdAt,
          }
          await putMedia(rec)
        }
        onRestoreNotes(restoredNotes)
        // Drop any orphan media that's not referenced by the restored notes.
        const restoredRefs = new Set(restoredNotes.flatMap(n => (n.media ?? []).map(m => m.id)))
        await pruneOrphans(restoredRefs).catch(() => {})
        setS3Status({ ok: true, msg: `Restored ${restoredNotes.length} note(s) and ${restoredMedia.length} media file(s).` })
        setModal(null)
        setPassword('')
      }
    } catch {
      setPwdError(
        modal.mode === 'restore'
          ? 'Wrong password or corrupt backup.'
          : 'Upload failed. Check your S3 credentials and bucket CORS settings.',
      )
    } finally {
      setOpRunning(false)
    }
  }, [password, modal, notes, s3, onRestoreNotes, fetchBackups])

  // ── Page: Settings home ────────────────────────────────────────────────
  if (settingsPage === 'home') {
    return (
      <div className="settings-panel">

        <div className="settings-section">
          <p className="settings-label">Appearance</p>
          <div className="settings-theme-toggle">
            {(['system', 'light', 'dark'] as const).map((t) => (
              <button
                key={t}
                className={`theme-option${theme === t ? ' theme-option--active' : ''}`}
                onClick={() => setTheme(t)}
              >
                {t.charAt(0).toUpperCase() + t.slice(1)}
              </button>
            ))}
          </div>
        </div>

        <div className="settings-nav-list">
          <button
            className="settings-nav-item"
            onClick={() => { setFbDraft(fb); setSettingsPage('facebook') }}
          >            <span className="settings-nav-icon" aria-hidden="true">
              <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
                <path d="M14 8a6 6 0 1 0-6.94 5.93V9.84H5.31V8h1.75V6.66c0-1.73 1.03-2.68 2.6-2.68.75 0 1.54.14 1.54.14v1.69h-.87c-.85 0-1.12.53-1.12 1.07V8h1.9l-.3 1.84H9.21v4.09A6.003 6.003 0 0 0 14 8z" fill="currentColor"/>
              </svg>
            </span>
            <span className="settings-nav-label">
              Facebook Page Connector
              {fb.pageId && <span className="settings-nav-badge">Connected</span>}
            </span>
            <span className="settings-nav-arrow"><ChevronRight /></span>
          </button>

          <button
            className="settings-nav-item"
            onClick={() => { setS3Draft(s3); setSettingsPage('s3') }}
          >
            <span className="settings-nav-icon" aria-hidden="true">
              <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
                <path d="M12.7 9.8a2.7 2.7 0 0 0-2.3-2.6A4.2 4.2 0 0 0 2.3 9.8H2a2 2 0 0 0 0 4h10.8a2 2 0 0 0-.1-4z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/>
              </svg>
            </span>
            <span className="settings-nav-label">
              S3 / Backup
              {s3Complete && <span className="settings-nav-badge">Configured</span>}
            </span>
            <span className="settings-nav-arrow"><ChevronRight /></span>
          </button>

          <button
            className="settings-nav-item"
            onClick={() => setSettingsPage('sync')}
          >
            <span className="settings-nav-icon" aria-hidden="true">
              <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
                <path d="M1.5 8a6.5 6.5 0 0 1 11.48-4.16" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
                <path d="M14.5 8a6.5 6.5 0 0 1-11.48 4.16" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
                <path d="M13 1v3h-3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
                <path d="M3 15v-3h3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </span>
            <span className="settings-nav-label">
              Multi-device Sync
              {syncState.enabled && <span className="settings-nav-badge">On</span>}
            </span>
            <span className="settings-nav-arrow"><ChevronRight /></span>
          </button>

          <button
            className="settings-nav-item"
            onClick={() => setSettingsPage('security')}
          >
            <span className="settings-nav-icon" aria-hidden="true">
              <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
                <rect x="3" y="7" width="10" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.3"/>
                <path d="M5 7V5a3 3 0 0 1 6 0v2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
              </svg>
            </span>
            <span className="settings-nav-label">Screen Lock</span>
            <span className="settings-nav-arrow"><ChevronRight /></span>
          </button>
        </div>

        <div className="settings-stats">
          <span>{notes.length} {notes.length === 1 ? 'note' : 'notes'}</span>
        </div>

        <div className="settings-section">
          <p className="settings-label">Storage</p>
          <StorageMeter storage={storage} />
          {!storage.persisted && (
            <button
              className="settings-action-btn"
              onClick={async () => {
                await requestPersistentStorage()
                refreshStorage()
              }}
              style={{ marginTop: 8 }}
            >
              Request persistent storage
            </button>
          )}
        </div>

        <div className="settings-section">
          <p className="settings-label">Data</p>
          <button
            className="settings-action-btn"
            onClick={() => exportNotes(notes)}
            disabled={notes.length === 0}
          >
            Export all notes (.txt)
          </button>
        </div>
      </div>
    )
  }

  // ── Page: Facebook Page Connector ──────────────────────────────────────
  if (settingsPage === 'facebook') {
    return (
      <div className="settings-panel">
        <div className="settings-section">
          <p className="settings-label">Access Token</p>
          <input
            type="password"
            className="settings-form-input"
            placeholder="EAABwzLixnjYBO…"
            value={fbDraft.accessToken}
            onChange={e => setFbDraft(d => ({ ...d, accessToken: e.target.value }))}
            autoComplete="off"
            spellCheck={false}
          />
        </div>

        <div className="settings-section">
          <p className="settings-label">Page ID</p>
          <input
            type="text"
            className="settings-form-input"
            placeholder="123456789012345"
            value={fbDraft.pageId}
            onChange={e => setFbDraft(d => ({ ...d, pageId: e.target.value }))}
            autoComplete="off"
            spellCheck={false}
          />
        </div>

        <div className="settings-section settings-section--actions">
          <button
            className="settings-save-btn"
            onClick={saveFb}
            disabled={!fbDraft.accessToken.trim() || !fbDraft.pageId.trim()}
          >
            Save
          </button>
          {fb.accessToken && fb.pageId && (
            <button
              className="settings-danger-btn"
              onClick={() => {
                const cleared = { accessToken: '', pageId: '' }
                localStorage.removeItem(FB_KEY)
                setFb(cleared)
                setFbDraft(cleared)
              }}
            >
              Disconnect
            </button>
          )}
        </div>

        <p className="settings-hint">
          The access token and page ID are stored in your browser's local storage. They never leave your device.
        </p>
      </div>
    )
  }

  // ── Page: Sync ────────────────────────────────────────────────────────
  if (settingsPage === 'sync') {
    return (
      <SyncPage
        syncState={syncState}
        onTriggerSync={onTriggerSync}
        onSyncEnabled={onSyncEnabled}
        onSyncDisabled={onSyncDisabled}
      />
    )
  }

  // ── Page: Security / Screen Lock ────────────────────────────────────
  if (settingsPage === 'security') {
    return <SecurityPage onLockApp={onLockApp} />
  }

  // ── Page: S3 / Backup ──────────────────────────────────────────────────
  return (
    <div className="settings-panel">

      {/* Credentials */}
      <div className="settings-section">
        <p className="settings-label">S3 Credentials</p>
        <div className="settings-form-fields">
          <div className="settings-form-row">
            <label className="settings-form-label" htmlFor="s3-bucket">Bucket</label>
            <input
              id="s3-bucket"
              type="text"
              className="settings-form-input"
              placeholder="my-notes-backup"
              value={s3Draft.bucket}
              onChange={e => setS3Draft(d => ({ ...d, bucket: e.target.value }))}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <div className="settings-form-row">
            <label className="settings-form-label" htmlFor="s3-region">Region</label>
            <input
              id="s3-region"
              type="text"
              className="settings-form-input"
              placeholder="us-east-1"
              value={s3Draft.region}
              onChange={e => setS3Draft(d => ({ ...d, region: e.target.value }))}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <div className="settings-form-row">
            <label className="settings-form-label" htmlFor="s3-key-id">Key ID</label>
            <input
              id="s3-key-id"
              type="text"
              className="settings-form-input"
              placeholder="AKIAIOSFODNN7EXAMPLE"
              value={s3Draft.accessKeyId}
              onChange={e => setS3Draft(d => ({ ...d, accessKeyId: e.target.value }))}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <div className="settings-form-row">
            <label className="settings-form-label" htmlFor="s3-secret">Secret</label>
            <input
              id="s3-secret"
              type="password"
              className="settings-form-input"
              placeholder="••••••••••••"
              value={s3Draft.secretAccessKey}
              onChange={e => setS3Draft(d => ({ ...d, secretAccessKey: e.target.value }))}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
        </div>
        <div className="settings-section--actions" style={{ marginTop: '10px' }}>
          <button
            className="settings-save-btn"
            onClick={saveS3}
            disabled={!s3Draft.bucket || !s3Draft.region || !s3Draft.accessKeyId || !s3Draft.secretAccessKey}
          >
            {s3Saved ? 'Saved ✓' : 'Save Credentials'}
          </button>
        </div>
      </div>

      {/* Backup actions — only shown once credentials are saved */}
      {s3Complete && (
        <div className="settings-section">
          <div className="s3-backup-header">
            <p className="settings-label" style={{ marginBottom: 0 }}>Backups</p>
            <button
              className="s3-backup-now-btn"
              onClick={openBackupModal}
              disabled={notes.length === 0}
            >
              <svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                <path d="M7 1v7M4.5 5.5L7 8l2.5-2.5M2 10v1.5a.5.5 0 0 0 .5.5h9a.5.5 0 0 0 .5-.5V10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
              Backup Now
            </button>
          </div>

          {s3Status && (
            <p className={`s3-status${s3Status.ok ? '' : ' s3-status--error'}`}>
              {s3Status.msg}
            </p>
          )}

          {backupsLoading && <p className="s3-loading">Loading backups…</p>}
          {backupsError   && <p className="s3-status s3-status--error">Could not load backups: {backupsError}</p>}

          {!backupsLoading && backupsLoaded && backups.length === 0 && (
            <p className="s3-empty">No backups found in this bucket.</p>
          )}

          {backups.length > 0 && (
            <div className="s3-backup-list">
              {backups.map(b => (
                <div key={b.key} className="s3-backup-item">
                  <div className="s3-backup-item-info">
                    <span className="s3-backup-item-date">
                      {new Date(b.lastModified).toLocaleString(undefined, {
                        month: 'short', day: 'numeric', year: 'numeric',
                        hour: '2-digit', minute: '2-digit',
                      })}
                    </span>
                    <span className="s3-backup-item-size">{(b.size / 1024).toFixed(1)} KB</span>
                  </div>
                  <button
                    className="s3-restore-btn"
                    onClick={() => openRestoreModal(b.key)}
                  >
                    Restore
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <p className="settings-hint">
        Backups are encrypted end-to-end with AES-256-GCM on your device before upload. S3 credentials are stored locally in your browser.
      </p>

      {/* Password modal */}
      {modal && (
        <div
          className="modal-overlay"
          role="dialog"
          aria-modal="true"
          aria-label={modal.mode === 'backup' ? 'Encrypt and upload backup' : 'Decrypt and restore backup'}
          onClick={e => { if (e.target === e.currentTarget && !opRunning) { setModal(null); setPassword('') } }}
        >
          <div className="modal-box">
            <h3 className="modal-title">
              {modal.mode === 'backup' ? 'Encrypt & Upload' : 'Decrypt & Restore'}
            </h3>
            <p className="modal-desc">
              {modal.mode === 'backup'
                ? 'Your notes will be encrypted with AES-256 before uploading. Keep this password safe — it cannot be recovered.'
                : 'Enter the password used when this backup was created.'}
            </p>
            <input
              type="password"
              className="settings-form-input"
              placeholder="Encryption password"
              value={password}
              onChange={e => { setPassword(e.target.value); setPwdError('') }}
              onKeyDown={e => e.key === 'Enter' && !opRunning && submitPassword()}
              // eslint-disable-next-line jsx-a11y/no-autofocus
              autoFocus
              autoComplete="new-password"
            />
            {pwdError && <p className="modal-error">{pwdError}</p>}
            <div className="modal-actions">
              <button
                className="modal-cancel-btn"
                onClick={() => { setModal(null); setPassword('') }}
                disabled={opRunning}
              >
                Cancel
              </button>
              <button
                className="modal-confirm-btn"
                onClick={submitPassword}
                disabled={opRunning || !password.trim()}
              >
                {opRunning
                  ? (modal.mode === 'backup' ? 'Uploading…' : 'Restoring…')
                  : (modal.mode === 'backup' ? 'Backup' : 'Restore')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── SyncPage ──────────────────────────────────────────────────────────────────

interface SyncPageProps {
  syncState: SyncState
  onTriggerSync: () => void
  onSyncEnabled: () => void
  onSyncDisabled: () => void
}

function SyncPage({ syncState, onTriggerSync, onSyncEnabled, onSyncDisabled }: SyncPageProps) {
  const [enabled, setEnabled] = useState(isSyncEnabled())
  const [pwd, setPwd] = useState(getSyncPassword())
  const [saved, setSaved] = useState(false)

  const handleToggle = useCallback(() => {
    if (enabled) {
      disableSync()
      setEnabled(false)
      onSyncDisabled()
    } else {
      if (!pwd.trim()) return
      enableSync(pwd)
      setEnabled(true)
      onSyncEnabled()
    }
  }, [enabled, pwd, onSyncEnabled, onSyncDisabled])

  const handleSavePassword = useCallback(() => {
    if (!pwd.trim()) return
    enableSync(pwd)
    setEnabled(true)
    setSaved(true)
    onSyncEnabled()
    setTimeout(() => setSaved(false), 2000)
  }, [pwd, onSyncEnabled])

  const statusLabel =
    syncState.status === 'syncing' ? 'Syncing…' :
    syncState.status === 'connecting' ? 'Connecting…' :
    syncState.status === 'offline' ? 'Offline' :
    syncState.status === 'error' ? 'Error' :
    syncState.status === 'idle' ? 'Connected' : 'Off'

  const statusClass =
    syncState.status === 'syncing' || syncState.status === 'connecting' ? 'sync-status--syncing' :
    syncState.status === 'error' ? 'sync-status--error' :
    syncState.status === 'offline' ? 'sync-status--error' :
    syncState.status === 'idle' ? 'sync-status--ok' : ''

  const lastSyncStr = syncState.lastSync
    ? new Date(syncState.lastSync).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : null

  return (
    <div className="settings-panel">

      <div className="settings-section">
        <p className="settings-label">Sync</p>
        <div className="settings-toggle-row">
          <span>Multi-device sync</span>
          <button
            className={`settings-toggle${enabled ? ' settings-toggle--on' : ''}`}
            onClick={handleToggle}
            disabled={!enabled && !pwd.trim()}
            aria-label={enabled ? 'Disable sync' : 'Enable sync'}
            role="switch"
            aria-checked={enabled}
          >
            <span className="settings-toggle-knob" />
          </button>
        </div>
        {enabled && (
          <div className="sync-status-row">
            <span className={`sync-status-dot ${statusClass}`} />
            <span>{statusLabel}</span>
            {syncState.deviceCount > 1 && (
              <span className="sync-device-count">{syncState.deviceCount} devices</span>
            )}
            {lastSyncStr && <span className="sync-last-time">Last: {lastSyncStr}</span>}
          </div>
        )}
        {syncState.error && (
          <p className="s3-status s3-status--error">{syncState.error}</p>
        )}
      </div>

      <div className="settings-section">
        <p className="settings-label">Encryption Password</p>
        <p className="settings-hint" style={{ marginBottom: 8, marginTop: 0 }}>
          All notes are encrypted before syncing. Use the same password on every device to link them together.
        </p>
        <input
          type="password"
          className="settings-form-input"
          placeholder="Sync encryption password"
          value={pwd}
          onChange={e => setPwd(e.target.value)}
          autoComplete="new-password"
          spellCheck={false}
        />
        <div className="settings-section--actions" style={{ marginTop: 10 }}>
          <button
            className="settings-save-btn"
            onClick={handleSavePassword}
            disabled={!pwd.trim()}
          >
            {saved ? 'Saved ✓' : 'Save & Enable'}
          </button>
        </div>
      </div>

      {enabled && (
        <div className="settings-section">
          <button
            className="s3-backup-now-btn"
            onClick={onTriggerSync}
            disabled={syncState.status === 'syncing' || syncState.status === 'connecting'}
            style={{ width: '100%' }}
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M1.5 8a6.5 6.5 0 0 1 11.48-4.16" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
              <path d="M14.5 8a6.5 6.5 0 0 1-11.48 4.16" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
              <path d="M13 1v3h-3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
              <path d="M3 15v-3h3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            {syncState.status === 'syncing' ? 'Syncing…' : 'Sync Now'}
          </button>
        </div>
      )}

      {enabled && (
        <div className="settings-section">
          <button
            className="settings-danger-btn"
            onClick={() => {
              disableSync()
              setEnabled(false)
              onSyncDisabled()
            }}
          >
            Disable Sync
          </button>
        </div>
      )}

      <p className="settings-hint">
        Sync connects your devices via a secure WebSocket channel. Notes are end-to-end encrypted
        — the server only stores opaque blobs it cannot read. Credentials (FB, S3, etc.) never leave your device.
      </p>
    </div>
  )
}

// ── SecurityPage ─────────────────────────────────────────────────────────────

interface SecurityPageProps {
  onLockApp: () => void
}

function SecurityPage({ onLockApp }: SecurityPageProps) {
  const [hasPinState, setHasPinState] = useState(false)
  const [pin, setPin] = useState('')
  const [confirmPin, setConfirmPin] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    checkHasPin().then(setHasPinState)
  }, [])

  const handleSetPin = useCallback(async () => {
    setError(null)
    if (!pin.trim()) { setError('PIN cannot be empty'); return }
    if (pin.length < 4) { setError('PIN must be at least 4 characters'); return }
    if (pin !== confirmPin) { setError('PINs do not match'); return }
    setBusy(true)
    try {
      await vaultSetPin(pin)
      setHasPinState(true)
      setPin('')
      setConfirmPin('')
      setSuccess('Screen lock enabled')
      setTimeout(() => setSuccess(null), 2000)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }, [pin, confirmPin])

  const handleRemovePin = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      await vaultRemovePin()
      setHasPinState(false)
      setSuccess('Screen lock removed')
      setTimeout(() => setSuccess(null), 2000)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }, [])

  return (
    <div className="settings-panel">

      <div className="settings-section">
        <p className="settings-label">Screen Lock</p>
        <p className="settings-hint" style={{ marginTop: 0, marginBottom: 12 }}>
          {hasPinState
            ? 'Your notes are protected with a PIN. You\'ll need to enter it when opening the app.'
            : 'Set a PIN to protect your notes when someone else uses your device. This is optional — your data is always encrypted at rest regardless.'}
        </p>

        {hasPinState ? (
          <>
            <div className="sync-status-row" style={{ marginBottom: 12 }}>
              <span className="sync-status-dot sync-status--ok" />
              <span>Screen lock active</span>
            </div>
            <button className="s3-backup-now-btn" onClick={onLockApp} style={{ width: '100%', marginBottom: 8 }}>
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <rect x="3" y="7" width="10" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.3"/>
                <path d="M5 7V5a3 3 0 0 1 6 0v2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
              </svg>
              Lock Now
            </button>
            <button
              className="settings-danger-btn"
              onClick={handleRemovePin}
              disabled={busy}
            >
              {busy ? 'Removing…' : 'Remove Screen Lock'}
            </button>
          </>
        ) : (
          <>
            <input
              type="password"
              inputMode="numeric"
              className="settings-form-input"
              placeholder="New PIN (min 4 characters)"
              value={pin}
              onChange={e => setPin(e.target.value)}
              autoComplete="new-password"
              maxLength={32}
              style={{ marginBottom: 8 }}
            />
            <input
              type="password"
              inputMode="numeric"
              className="settings-form-input"
              placeholder="Confirm PIN"
              value={confirmPin}
              onChange={e => setConfirmPin(e.target.value)}
              autoComplete="new-password"
              maxLength={32}
            />
            <div className="settings-section--actions" style={{ marginTop: 10 }}>
              <button
                className="settings-save-btn"
                onClick={handleSetPin}
                disabled={busy || !pin.trim()}
              >
                {busy ? 'Setting…' : 'Enable Screen Lock'}
              </button>
            </div>
          </>
        )}

        {error && <p className="s3-status s3-status--error" style={{ marginTop: 8 }}>{error}</p>}
        {success && <p className="s3-status s3-status--ok" style={{ marginTop: 8 }}>{success}</p>}
      </div>

      <div className="settings-section">
        <p className="settings-label">About Security</p>
        <p className="settings-hint" style={{ marginTop: 0 }}>
          All your data is encrypted at rest using a device-bound key stored in your browser's
          secure storage. Even without a PIN, your notes are never stored as plain text.
        </p>
        <p className="settings-hint" style={{ marginTop: 4 }}>
          The optional PIN adds a second layer — it protects against someone opening this app
          on your device. If you lose your PIN, you can clear browser data and re-sync from
          another device.
        </p>
      </div>
    </div>
  )
}

// ── StorageMeter ─────────────────────────────────────────────────────────────

function formatBytes(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${units[i]}`
}

function StorageMeter({ storage }: { storage: StorageInfo }) {
  const { usage, quota, persisted } = storage
  const pct = usage != null && quota && quota > 0 ? Math.min(100, (usage / quota) * 100) : 0
  return (
    <div className="storage-meter">
      <div className="storage-meter-bar" aria-hidden="true">
        <div
          className={`storage-meter-fill${pct > 85 ? ' storage-meter-fill--warn' : ''}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="storage-meter-row">
        <span>{formatBytes(usage)} of {formatBytes(quota)}</span>
        <span className={persisted ? 'storage-meter-tag storage-meter-tag--ok' : 'storage-meter-tag'}>
          {persisted ? 'Persistent' : 'Best-effort'}
        </span>
      </div>
    </div>
  )
}
