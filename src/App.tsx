import { useState, useRef, useEffect, useCallback } from 'react'
import { useNotes } from './hooks/useNotes'
import type { Note, FbPostInfo, MediaRef } from './types'
import { SettingsPanel } from './components/SettingsPanel'
import { FacebookFeed } from './components/FacebookFeed'
import { FacebookInsights } from './components/FacebookInsights'
import { MediaThumb } from './components/MediaThumb'
import { useMediaUrl } from './hooks/useMediaUrl'
import { InstallPrompt } from './components/InstallPrompt'
import { LockScreen } from './components/LockScreen'
import { PhotoGallery } from './components/PhotoGallery'
import {
  loadFbConnections,
  parseFbConnections,
  getActiveSettings,
  publishNoteToPage,
  updatePostMessage,
  postUrl,
  type FbSettings,
  type FbConnections,
  type PublishMedia,
} from './utils/facebook'
import {
  ingestImageFile,
  ingestVideoFile,
  toRef,
  putMedia,
  getMediaBlob,
  requestPersistentStorage,
} from './utils/media'
import { initVault, lockVault, hasPin as checkHasPin, secureGet } from './utils/vault'
import { approveTransfer, denyTransfer } from './utils/sync'
import './App.css'

// ── Utilities ────────────────────────────────────────────────────────────────

function formatDate(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  const d = new Date(ts)
  const isThisYear = d.getFullYear() === new Date().getFullYear()
  return d.toLocaleDateString('en', {
    month: 'short',
    day: 'numeric',
    ...(isThisYear ? {} : { year: 'numeric' }),
  })
}

function extractTitle(body: string): string {
  return body.split('\n')[0].trim().slice(0, 80) || 'Untitled'
}

function extractPreview(body: string): string {
  return body.split('\n').slice(1).join(' ').trim().slice(0, 80)
}

function countWords(text: string): number {
  return text.trim() ? text.trim().split(/\s+/).length : 0
}

const STREAK_KEY = 'notes-streak-v1'
const THEME_KEY  = 'notes-theme-v1'
type Theme = 'system' | 'light' | 'dark'

function getStreak(): number {
  try {
    const raw = localStorage.getItem(STREAK_KEY)
    return raw ? (JSON.parse(raw).count as number) : 0
  } catch { return 0 }
}

function bumpStreak(): number {
  const today     = new Date().toISOString().slice(0, 10)
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
  try {
    const raw  = localStorage.getItem(STREAK_KEY)
    const data = raw ? JSON.parse(raw) : { lastDate: '', count: 0 }
    if (data.lastDate === today) return data.count as number
    const newCount: number = data.lastDate === yesterday ? data.count + 1 : 1
    localStorage.setItem(STREAK_KEY, JSON.stringify({ lastDate: today, count: newCount }))
    return newCount
  } catch { return 1 }
}

function loadTheme(): Theme {
  return (localStorage.getItem(THEME_KEY) as Theme) ?? 'system'
}

function applyTheme(theme: Theme): void {
  const root = document.documentElement
  if (theme === 'system') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', theme)
}

const DAILY_PROMPTS = [
  'What are you thinking about?',
  'A good day to write something.',
  'What happened today?',
  'Something to capture before it fades.',
  'Write it down, then let it go.',
  'What do you want to remember?',
  'The page is ready when you are.',
]

function getDailyPrompt(): string {
  return DAILY_PROMPTS[new Date().getDay()] ?? DAILY_PROMPTS[0]
}

function groupNotesByDate(notes: Note[]): Array<{ label: string; notes: Note[] }> {
  const today     = new Date().toISOString().slice(0, 10)
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
  const todayNotes:     Note[] = []
  const yesterdayNotes: Note[] = []
  const earlierNotes:   Note[] = []
  for (const note of notes) {
    const d = new Date(note.updatedAt).toISOString().slice(0, 10)
    if (d === today) todayNotes.push(note)
    else if (d === yesterday) yesterdayNotes.push(note)
    else earlierNotes.push(note)
  }
  const groups: Array<{ label: string; notes: Note[] }> = []
  if (todayNotes.length > 0)     groups.push({ label: 'Today',     notes: todayNotes })
  if (yesterdayNotes.length > 0) groups.push({ label: 'Yesterday', notes: yesterdayNotes })
  if (earlierNotes.length > 0)   groups.push({ label: 'Earlier',   notes: earlierNotes })
  return groups
}

// ── Component ────────────────────────────────────────────────────────────────

export default function App() {
  const {
    notes, createNote, updateNote, deleteNote,
    addMedia, removeMedia, restoreNotes,
    setFbPost, clearFbPost,
    galleryItems, addToGalleryItems, removeGalleryItem, attachGalleryItem,
    syncState, initSync, stopSyncEngine, triggerSync, schedulePush,
    loadFromVault, loadGallery,
  } = useNotes()
  const sortedNotes = [...notes].sort((a, b) => b.updatedAt - a.updatedAt)

  // ── Vault state ───────────────────────────────────────────────────────────
  const [vaultReady, setVaultReady] = useState(false)
  const [vaultLocked, setVaultLocked] = useState(false)

  const [selectedId,    setSelectedId]    = useState<string | null>(() => sortedNotes[0]?.id ?? null)
  const [mobileView,    setMobileView]    = useState<'list' | 'editor'>('list')
  const [sidebarView,   setSidebarView]   = useState<'notes' | 'settings' | 'facebook' | 'fb-insights' | 'gallery'>('notes')
  const [settingsPage,  setSettingsPage]  = useState<'home' | 'facebook' | 's3' | 'sync' | 'security'>('home')
  const [fbConn,        setFbConn]        = useState<FbConnections | null>(loadFbConnections)
  const fbSettings: FbSettings | null = getActiveSettings(fbConn)
  const [fbBusy,        setFbBusy]        = useState(false)
  const [fbError,       setFbError]       = useState<string | null>(null)
  const [showSaved,     setShowSaved]     = useState(false)
  const [streak,        setStreak]        = useState<number>(getStreak)
  const [theme,         setTheme]         = useState<Theme>(loadTheme)
  const [searchQuery,   setSearchQuery]   = useState('')
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null)

  const filteredNotes = searchQuery.trim()
    ? sortedNotes.filter(n => n.body.toLowerCase().includes(searchQuery.toLowerCase()))
    : sortedNotes

  const saveTimer    = useRef<ReturnType<typeof setTimeout> | null>(null)
  const titleLineRef = useRef<HTMLInputElement>(null)
  const restRef      = useRef<HTMLTextAreaElement>(null)
  const notesListRef = useRef<HTMLDivElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const mediaInputRef  = useRef<HTMLInputElement>(null)

  const [searchOpen, setSearchOpen] = useState(false)

  const selectedNote: Note | undefined = notes.find((n) => n.id === selectedId)

  // ── Theme ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    applyTheme(theme)
    localStorage.setItem(THEME_KEY, theme)
  }, [theme])

  // ── Load FB settings from vault (async) ──────────────────────────────────
  const reloadFbSettings = useCallback(async () => {
    try {
      const raw = await secureGet('notes-fb-v1')
      const conn = parseFbConnections(raw) ?? loadFbConnections()
      setFbConn(conn)
    } catch {
      setFbConn(loadFbConnections())
    }
  }, [])

  // ── Re-read FB settings whenever we leave the settings panel ─────────────
  useEffect(() => {
    if (sidebarView !== 'settings') {
      reloadFbSettings()
    }
  }, [sidebarView, settingsPage, reloadFbSettings])

  // ── Vault + note loading on mount ────────────────────────────────────────
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const result = await initVault()
      if (cancelled) return
      if (result === 'locked') {
        setVaultLocked(true)
        setVaultReady(true)
      } else {
        await loadFromVault()
        if (cancelled) return
        await reloadFbSettings()
        if (cancelled) return
        setVaultReady(true)
        initSync()
        // Load gallery after vault is ready — never blocks the loading screen.
        loadGallery()
      }
    })()
    requestPersistentStorage().catch(() => {})
    return () => { cancelled = true; stopSyncEngine() }
  }, [loadFromVault, reloadFbSettings, initSync, stopSyncEngine, loadGallery])

  const handleVaultUnlocked = useCallback(async () => {
    setVaultLocked(false)
    await loadFromVault()
    await reloadFbSettings()
    initSync()
    loadGallery()
  }, [loadFromVault, reloadFbSettings, initSync, loadGallery])

  const handleLockApp = useCallback(async () => {
    const pinSet = await checkHasPin()
    if (pinSet) {
      lockVault()
      setVaultLocked(true)
    }
  }, [])

  // ── Sync on tab focus (pull changes from other devices) ─────────────────
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') triggerSync()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [triggerSync])

  // ── Scroll to top on note switch ──────────────────────────────────────────
  useEffect(() => {
    const scroll = restRef.current?.closest('.editor-scroll')
    if (scroll instanceof HTMLElement) scroll.scrollTop = 0
    setFbError(null)
  }, [selectedId])

  // ── Reveal search on notes-list scroll (iOS iMessage style) ───────────────
  useEffect(() => {
    const el = notesListRef.current
    if (!el) return
    let lastY = 0
    const onScroll = () => {
      const y = el.scrollTop
      // Scrolling up (pulling toward top) reveals the search bar
      if (y < lastY && y < 60) setSearchOpen(true)
      lastY = y
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  // ── Focus search input when opened ────────────────────────────────────────
  useEffect(() => {
    if (searchOpen) setTimeout(() => searchInputRef.current?.focus(), 180)
  }, [searchOpen])

  // ── Handlers ──────────────────────────────────────────────────────────────

  const handleNewNote = useCallback(() => {
    // Auto-delete current empty note (iOS Notes behaviour)
    if (selectedId) {
      const current = notes.find(n => n.id === selectedId)
      if (current && !current.body.trim()) deleteNote(current.id)
    }
    const note = createNote()
    setSelectedId(note.id)
    setMobileView('editor')
    setSidebarView('notes')
    setSettingsPage('home')
    setSearchQuery('')
    setSearchOpen(false)
    setTimeout(() => titleLineRef.current?.focus(), 50)
  }, [createNote, selectedId, notes, deleteNote])

  const handleSelectNote = useCallback((id: string) => {
    // Auto-delete previous empty note (iOS Notes behaviour)
    if (selectedId && selectedId !== id) {
      const current = notes.find(n => n.id === selectedId)
      if (current && !current.body.trim()) deleteNote(current.id)
    }
    setSelectedId(id)
    setMobileView('editor')
  }, [selectedId, notes, deleteNote])

  const handleBackToList = useCallback(() => {
    // Auto-delete current empty note when going back (iOS Notes behaviour)
    if (selectedId) {
      const current = notes.find(n => n.id === selectedId)
      if (current && !current.body.trim()) {
        deleteNote(current.id)
        const remaining = notes.filter(n => n.id !== current.id)
        setSelectedId(remaining[0]?.id ?? null)
      }
    }
    setMobileView('list')
  }, [selectedId, notes, deleteNote])

  const handleUpdate = useCallback(
    (id: string, body: string) => {
      updateNote(id, { body })
      setShowSaved(false)
      if (saveTimer.current) clearTimeout(saveTimer.current)
      saveTimer.current = setTimeout(() => {
        setShowSaved(true)
        setStreak(bumpStreak())
        setTimeout(() => setShowSaved(false), 2200)
        // Schedule sync push after save
        const note = notes.find(n => n.id === id)
        if (note) schedulePush({ ...note, body, updatedAt: Date.now() })
      }, 700)
    },
    [updateNote, notes, schedulePush]
  )

  const handleDelete = useCallback(
    (id: string) => {
      deleteNote(id)
      const remaining = notes.filter((n) => n.id !== id)
      const next = remaining[0] ?? null
      setSelectedId(next?.id ?? null)
      if (!next) setMobileView('list')
    },
    [deleteNote, notes]
  )

  // ── Facebook publish / update ─────────────────────────────────────────────
  const handleFbPublish = useCallback(async (targetPageId?: string) => {
    if (!selectedNote) return
    const target = getActiveSettings(fbConn, targetPageId)
    if (!target) return
    setFbBusy(true)
    setFbError(null)
    try {
      const ts = Date.now()
      // Update path applies only when we're posting to the same page as before
      // (you can't "update" a post that's on a different page).
      if (selectedNote.fbPost && selectedNote.fbPost.pageId === target.pageId) {
        // Update existing post (message only — photos can't be changed via API)
        await updatePostMessage(target, selectedNote.fbPost.id, selectedNote.body)
        const updated: FbPostInfo = {
          ...selectedNote.fbPost,
          lastSyncedAt: ts,
          syncedBody: selectedNote.body,
          history: [
            ...selectedNote.fbPost.history,
            { ts, body: selectedNote.body, action: 'update' },
          ],
        }
        setFbPost(selectedNote.id, updated)
      } else {
        // Pull blobs out of IDB for upload.
        const publishMedia: PublishMedia[] = []
        for (const m of selectedNote.media) {
          const blob = await getMediaBlob(m.id)
          if (blob) publishMedia.push({ blob, type: m.type })
        }
        const { id } = await publishNoteToPage(target, selectedNote.body, publishMedia)
        const fbPost: FbPostInfo = {
          id,
          pageId: target.pageId,
          postedAt: ts,
          lastSyncedAt: ts,
          syncedBody: selectedNote.body,
          mediaCount: selectedNote.media.length,
          history: [{ ts, body: selectedNote.body, action: 'publish' }],
        }
        setFbPost(selectedNote.id, fbPost)
      }
    } catch (e) {
      setFbError((e as Error).message)
    } finally {
      setFbBusy(false)
    }
  }, [fbConn, selectedNote, setFbPost])

  // ── Auto-resize rest textarea ─────────────────────────────────────────────
  const autoResize = useCallback(() => {
    const ta = restRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = `${ta.scrollHeight}px`
  }, [])

  // ── Media handlers ────────────────────────────────────────────────────────

  const ingestFiles = useCallback(async (files: File[], noteId: string) => {
    const refs: MediaRef[] = []
    for (const file of files) {
      try {
        const rec = file.type.startsWith('video/')
          ? await ingestVideoFile(file)
          : file.type.startsWith('image/')
            ? await ingestImageFile(file)
            : null
        if (!rec) continue
        await putMedia(rec)
        refs.push(toRef(rec))
      } catch (err) {
        console.error('Failed to ingest media file', err)
      }
    }
    if (refs.length) addMedia(noteId, refs)
  }, [addMedia])

  const handleMediaUpload = useCallback(
    (files: FileList | null) => {
      if (!files || !selectedNote) return
      void ingestFiles(Array.from(files), selectedNote.id)
      if (mediaInputRef.current) mediaInputRef.current.value = ''
    },
    [selectedNote, ingestFiles]
  )

  const handleMediaRemove = useCallback(
    (index: number) => {
      if (!selectedNote) return
      removeMedia(selectedNote.id, index)
    },
    [selectedNote, removeMedia]
  )

  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      if (!selectedNote) return
      const files = Array.from(e.clipboardData.items)
        .filter(item => item.type.startsWith('image/') || item.type.startsWith('video/'))
        .map(item => item.getAsFile())
        .filter((f): f is File => !!f)
      if (!files.length) return
      void ingestFiles(files, selectedNote.id)
    },
    [selectedNote, ingestFiles]
  )

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      if (!selectedNote) return
      const files = Array.from(e.dataTransfer.files).filter(
        f => f.type.startsWith('image/') || f.type.startsWith('video/'),
      )
      if (!files.length) return
      e.preventDefault()
      void ingestFiles(files, selectedNote.id)
    },
    [selectedNote, ingestFiles]
  )

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (Array.from(e.dataTransfer.items).some(
      i => i.type.startsWith('image/') || i.type.startsWith('video/'),
    )) {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
    }
  }, [])

  useEffect(() => {
    autoResize()
  }, [selectedNote?.body, autoResize])

  // ── Keyboard shortcuts ────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (lightboxIndex !== null) {
        const media = selectedNote?.media ?? []
        if (e.key === 'Escape') { setLightboxIndex(null); return }
        if (e.key === 'ArrowRight') { setLightboxIndex((lightboxIndex + 1) % media.length); return }
        if (e.key === 'ArrowLeft') { setLightboxIndex((lightboxIndex - 1 + media.length) % media.length); return }
        return
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'n') {
        e.preventDefault()
        handleNewNote()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [handleNewNote, lightboxIndex, selectedNote])

  // ── Derived ───────────────────────────────────────────────────────────────
  const words = selectedNote ? countWords(selectedNote.body) : 0

  // ── Split body into title-line and rest ───────────────────────────────────
  const lines     = (selectedNote?.body ?? '').split('\n')
  const firstLine = lines[0]
  const restLines = lines.slice(1).join('\n')

  const handleTitleChange = (value: string) => {
    if (!selectedNote) return
    const newBody = restLines.length > 0 ? value + '\n' + restLines : value
    handleUpdate(selectedNote.id, newBody)
  }

  const handleRestChange = (value: string) => {
    if (!selectedNote) return
    const newBody = value.length > 0 ? firstLine + '\n' + value : firstLine
    handleUpdate(selectedNote.id, newBody)
    autoResize()
  }

  const handleTitleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      restRef.current?.focus()
      restRef.current?.setSelectionRange(0, 0)
    }
  }

  const handleRestKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const ta = restRef.current
    if (!ta) return
    if (e.key === 'Backspace' && ta.selectionStart === 0 && ta.selectionEnd === 0) {
      e.preventDefault()
      titleLineRef.current?.focus()
      const len = firstLine.length
      titleLineRef.current?.setSelectionRange(len, len)
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  // Precompute to avoid TypeScript narrowing the state in nested ternary branches
  const isGalleryView = sidebarView === 'gallery'

  // Vault loading
  if (!vaultReady) {
    return (
      <div className="lock-screen">
        <div className="lock-screen-card">
          <div className="lock-screen-icon lock-screen-icon--loading" />
        </div>
      </div>
    )
  }

  // PIN lock screen
  if (vaultLocked) {
    return <LockScreen onUnlocked={handleVaultUnlocked} />
  }

  return (
    <>
    <div className={`app${mobileView === 'editor' ? ' app--editor-view' : ''}`}>

      {/* ── Sidebar ──────────────────────────────────────────────────────── */}
      <aside className="sidebar" aria-label="Notes list">

        <div className="sidebar-brand">
          {sidebarView === 'settings' ? (
            <>
              <button
                className="icon-btn"
                onClick={() => {
                  if (settingsPage !== 'home') {
                    setSettingsPage('home')
                  } else {
                    setSidebarView('notes')
                  }
                }}
                aria-label={settingsPage !== 'home' ? 'Back to Settings' : 'Back to notes'}
              >
                <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
                  <path d="M11 4l-5 5 5 5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </button>
              <span className="sidebar-brand-name">
                {settingsPage === 'facebook' ? 'FB Page Connector'
                  : settingsPage === 's3' ? 'S3 / Backup'
                  : settingsPage === 'sync' ? 'Multi-device Sync'
                  : settingsPage === 'security' ? 'Screen Lock'
                  : 'Settings'}
              </span>
            </>
          ) : sidebarView === 'facebook' ? (
            <>
              <button
                className="icon-btn"
                onClick={() => setSidebarView('notes')}
                aria-label="Back to notes"
              >
                <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
                  <path d="M11 4l-5 5 5 5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </button>
              <span className="sidebar-brand-name">Page Feed</span>
            </>
          ) : sidebarView === 'fb-insights' ? (
            <>
              <button
                className="icon-btn"
                onClick={() => setSidebarView('facebook')}
                aria-label="Back to feed"
              >
                <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
                  <path d="M11 4l-5 5 5 5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </button>
              <span className="sidebar-brand-name">Insights</span>
            </>
          ) : sidebarView === 'gallery' ? (
            <>
              <button
                className="icon-btn"
                onClick={() => setSidebarView('notes')}
                aria-label="Back to notes"
              >
                <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
                  <path d="M11 4l-5 5 5 5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </button>
              <span className="sidebar-brand-name">Gallery</span>
              {galleryItems.length > 0 && (
                <span className="gallery-count-badge">{galleryItems.length}</span>
              )}
            </>
          ) : (
            <>
              <svg className="sidebar-brand-icon" width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                <rect x="3" y="2" width="12" height="16" rx="2" stroke="currentColor" strokeWidth="1.5" fill="none"/>
                <path d="M6.5 7.5h7M6.5 10.5h5.5M6.5 13.5h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
              </svg>
              <span className="sidebar-brand-name">Notes</span>
              {streak >= 1 && (
                <span
                  className={`streak-badge${streak === 1 ? ' streak-badge--day1' : ''}`}
                  title={`${streak}-day writing streak`}
                >
                  {streak > 1 && (
                    <svg width="10" height="10" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                      <path d="M6 1C6 1 9.5 4 9.5 7A3.5 3.5 0 0 1 2.5 7C2.5 5.2 4 3 6 1Z" fill="currentColor"/>
                    </svg>
                  )}
                  {streak === 1 ? '1 day' : streak}
                </span>
              )}
              <button className="icon-btn" style={{ marginLeft: 'auto' }} onClick={handleNewNote} aria-label="New note" title="New note (⌘N)">
                <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="M11.5 2.5a1.5 1.5 0 0 1 2.12 2.12l-8.5 8.5L2 14l.88-3.12 8.62-8.38z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" fill="none"/>
                </svg>
              </button>
            </>
          )}
        </div>

        {sidebarView === 'settings' ? (
          <SettingsPanel
            theme={theme}
            setTheme={setTheme}
            notes={notes}
            onRestoreNotes={restoreNotes}
            settingsPage={settingsPage}
            setSettingsPage={setSettingsPage}
            syncState={syncState}
            onTriggerSync={triggerSync}
            onSyncEnabled={initSync}
            onSyncDisabled={stopSyncEngine}
            onLockApp={handleLockApp}
          />
        ) : sidebarView === 'facebook' && fbSettings ? (
          <FacebookFeed
            notes={notes}
            fb={fbSettings}
            onOpenNote={(id) => {
              setSelectedId(id)
              setSidebarView('notes')
              setMobileView('editor')
            }}
            onClearFbPost={clearFbPost}
            onOpenInsights={() => setSidebarView('fb-insights')}
          />
        ) : sidebarView === 'fb-insights' && fbSettings ? (
          <FacebookInsights
            notes={notes}
            fb={fbSettings}
            onBack={() => setSidebarView('facebook')}
          />
        ) : sidebarView === 'gallery' ? (
          <PhotoGallery
            items={galleryItems}
            onAdd={(records) => addToGalleryItems(records).then(() => {})}
            onRemove={removeGalleryItem}
            onUse={(item) => {
              if (selectedNote) {
                attachGalleryItem(item, selectedNote.id)
              }
            }}
            hasActiveNote={!!selectedNote}
            syncEnabled={syncState.enabled}
          />
        ) : (
          <>
            <div className={`search-bar${searchOpen ? ' search-bar--open' : ''}`}>
              <svg className="search-bar-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.5"/>
                <path d="M11 11l3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
              </svg>
              <input
                ref={searchInputRef}
                className="search-input"
                type="search"
                placeholder="Search"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                aria-label="Search notes"
              />
              {searchQuery && (
                <button className="search-clear" onClick={() => setSearchQuery('')} aria-label="Clear search">✕</button>
              )}
            </div>

            <div
              ref={notesListRef}
              className="notes-list"
              role="list"
            >
              {sortedNotes.length === 0 ? (
                <div className="notes-empty">
                  <p>Every great idea starts somewhere.</p>
                  <button className="notes-empty-cta" onClick={handleNewNote}>Write your first note</button>
                </div>
              ) : filteredNotes.length === 0 ? (
                <p className="notes-no-results">No notes match "{searchQuery}"</p>
              ) : searchQuery.trim() ? (
                filteredNotes.map((note) => (
                  <button
                    key={note.id}
                    role="listitem"
                    className={`note-item${selectedId === note.id ? ' note-item--active' : ''}`}
                    onClick={() => handleSelectNote(note.id)}
                  >
                    <span className="note-item-title">{extractTitle(note.body)}</span>
                    <span className="note-item-preview">
                      {extractPreview(note.body) || <em>No content yet</em>}
                    </span>
                    <span className="note-item-meta">{formatDate(note.updatedAt)}</span>
                  </button>
                ))
              ) : (
                groupNotesByDate(sortedNotes).map(({ label, notes: groupNotes }) => (
                  <div key={label}>
                    <p className="notes-group-label">{label}</p>
                    {groupNotes.map((note) => (
                      <button
                        key={note.id}
                        role="listitem"
                        className={`note-item${selectedId === note.id ? ' note-item--active' : ''}`}
                        onClick={() => handleSelectNote(note.id)}
                      >
                        <span className="note-item-title">{extractTitle(note.body)}</span>
                        <span className="note-item-preview">
                          {extractPreview(note.body) || <em>No content yet</em>}
                        </span>
                        <span className="note-item-meta">{formatDate(note.updatedAt)}</span>
                      </button>
                    ))}
                  </div>
                ))
              )}
            </div>
            <div className="sidebar-footer">
              <span>{notes.length} {notes.length === 1 ? 'note' : 'notes'}</span>
              <button
                className={`icon-btn${searchOpen ? ' icon-btn--active' : ''}`}
                onClick={() => {
                  const next = !searchOpen
                  setSearchOpen(next)
                  if (!next) { setSearchQuery(''); notesListRef.current?.scrollTo({ top: 0, behavior: 'smooth' }) }
                }}
                aria-label="Search notes"
                title="Search"
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.5"/>
                  <path d="M11 11l3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                </svg>
              </button>
              <button
                className={`icon-btn${isGalleryView ? ' icon-btn--active' : ''}`}
                onClick={() => setSidebarView(isGalleryView ? 'notes' : 'gallery')}
                aria-label="Photo gallery"
                title="Gallery"
              >
                {galleryItems.length > 0 ? (
                  <span className="gallery-footer-badge" aria-label={`${galleryItems.length} items in gallery`}>
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                      <rect x="1.5" y="3" width="13" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.4"/>
                      <circle cx="5.5" cy="7" r="1.3" fill="currentColor"/>
                      <path d="M1.5 12l4-4 3 3 2-2 4 4" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/>
                    </svg>
                    <span className="gallery-footer-count">{galleryItems.length}</span>
                  </span>
                ) : (
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <rect x="1.5" y="3" width="13" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.4"/>
                    <circle cx="5.5" cy="7" r="1.3" fill="currentColor"/>
                    <path d="M1.5 12l4-4 3 3 2-2 4 4" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/>
                  </svg>
                )}
              </button>
              {fbSettings && (
                <button
                  className="icon-btn"
                  onClick={() => setSidebarView('facebook')}
                  aria-label="Page feed"
                  title="Page feed"
                >
                  <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <path d="M14 8a6 6 0 1 0-6.94 5.93V9.84H5.31V8h1.75V6.66c0-1.73 1.03-2.68 2.6-2.68.75 0 1.54.14 1.54.14v1.69h-.87c-.85 0-1.12.53-1.12 1.07V8h1.9l-.3 1.84H9.21v4.09A6.003 6.003 0 0 0 14 8z" fill="currentColor"/>
                  </svg>
                </button>
              )}
              <button className="icon-btn" onClick={() => setSidebarView('settings')} aria-label="Settings" title="Settings">
                <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="M6.8 2h2.4l.45 1.55c.4.17.77.4 1.1.68l1.55-.45 1.2 2.08-.98.98c.05.28.08.56.08.86s-.03.58-.08.86l.98.98-1.2 2.08-1.55-.45c-.33.28-.7.51-1.1.68L9.2 14H6.8l-.45-1.55a4.3 4.3 0 0 1-1.1-.68l-1.55.45L2.5 10.14l.98-.98A4.23 4.23 0 0 1 3.4 8.3c0-.3.03-.58.08-.86L2.5 6.46 3.7 4.38l1.55.45c.33-.28.7-.51 1.1-.68L6.8 2Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" fill="none"/>
                  <circle cx="8" cy="8.3" r="1.9" stroke="currentColor" strokeWidth="1.3"/>
                </svg>
              </button>
            </div>
          </>
        )}
      </aside>

      {/* ── Editor pane ──────────────────────────────────────────────────── */}
      <main className="editor-pane">
        {!selectedNote ? (
          <div className="editor-welcome" aria-label="Welcome screen">
            <div className="editor-welcome-inner">
              <p className="editor-welcome-day">{new Date().toLocaleDateString('en', { weekday: 'long' })}</p>
              <h2 className="editor-welcome-date">{new Date().toLocaleDateString('en', { month: 'long', day: 'numeric' })}</h2>
              <p className="editor-welcome-prompt">{getDailyPrompt()}</p>
              <button className="editor-welcome-cta" onClick={handleNewNote}>
                <svg width="12" height="12" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                  <path d="M7 1v12M1 7h12" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                </svg>
                New note
              </button>
            </div>
          </div>
        ) : (
          <div className="editor">

            <div className="editor-topbar">
              <button className="icon-btn" onClick={handleBackToList} aria-label="Back to notes">
                <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                  <path d="M13 4l-6 6 6 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </button>
            </div>

            <div className="editor-scroll"
              onDrop={handleDrop}
              onDragOver={handleDragOver}
              onPaste={handlePaste}
            >
              <input
                ref={titleLineRef}
                className="editor-title-line"
                type="text"
                placeholder="Title"
                value={firstLine}
                onChange={(e) => handleTitleChange(e.target.value)}
                onKeyDown={handleTitleKeyDown}
                aria-label="Note title (first line)"
                spellCheck
              />
              <textarea
                ref={restRef}
                className="editor-body"
                placeholder="Continue writing..."
                value={restLines}
                onChange={(e) => handleRestChange(e.target.value)}
                onKeyDown={handleRestKeyDown}
                onInput={autoResize}
                aria-label="Note body"
                spellCheck
              />

              {selectedNote.media.length > 0 && (
                <div className="editor-images" aria-label="Attached media">
                  {selectedNote.media.map((m, i) => (
                    <div key={m.id} className="editor-image-item">
                      <MediaThumb
                        refItem={m}
                        className="editor-image-thumb"
                        onClick={() => setLightboxIndex(i)}
                      />
                      <button
                        className="editor-image-remove"
                        onClick={() => handleMediaRemove(i)}
                        aria-label={`Remove ${m.type} ${i + 1}`}
                        title={`Remove ${m.type}`}
                      >
                        <svg width="8" height="8" viewBox="0 0 8 8" fill="none" aria-hidden="true">
                          <path d="M1 1l6 6M7 1L1 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                        </svg>
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="editor-footer">
              <div className="editor-stats">
                <span>{words} {words === 1 ? 'word' : 'words'}</span>
                <span className="sep">·</span>
                <span>{selectedNote.body.length} chars</span>
                <span className="sep">·</span>
                <span>Edited {formatDate(selectedNote.updatedAt)}</span>
              </div>
              <div className="editor-controls">
                {showSaved && (
                  <span className="save-indicator" aria-live="polite">Saved</span>
                )}
                {fbError && (
                  <span className="fb-error" role="alert" title={fbError}>
                    {fbError.length > 40 ? fbError.slice(0, 40) + '…' : fbError}
                  </span>
                )}
                <button
                  className="icon-btn"
                  onClick={() => mediaInputRef.current?.click()}
                  aria-label="Add image or video"
                  title="Add image or video"
                >
                  <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <rect x="1.5" y="3" width="13" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.4"/>
                    <circle cx="5.5" cy="7" r="1.3" fill="currentColor"/>
                    <path d="M1.5 12l4-4 3 3 2-2 4 4" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/>
                  </svg>
                </button>
                {galleryItems.length > 0 && (
                  <button
                    className={`icon-btn gallery-pick-btn${isGalleryView ? ' icon-btn--active' : ''}`}
                    onClick={() => setSidebarView(isGalleryView ? 'notes' : 'gallery')}
                    aria-label={`Pick from gallery (${galleryItems.length} item${galleryItems.length === 1 ? '' : 's'})`}
                    title={`From gallery (${galleryItems.length})`}
                  >
                    <svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                      <rect x="1" y="2" width="12" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.3"/>
                      <circle cx="4.5" cy="6" r="1.2" fill="currentColor"/>
                      <path d="M1 10.5l3.5-3.5 2.5 2.5 1.5-1.5 3.5 3.5" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/>
                    </svg>
                    <span className="gallery-pick-count">{galleryItems.length}</span>
                  </button>
                )}
                <input
                  ref={mediaInputRef}
                  type="file"
                  accept="image/*,video/*"
                  multiple
                  style={{ display: 'none' }}
                  onChange={(e) => handleMediaUpload(e.target.files)}
                  aria-hidden="true"
                  tabIndex={-1}
                />
                {fbConn && fbSettings && (() => {
                  const fp = selectedNote.fbPost
                  const defaultPage = fbConn.pages.find(p => p.id === fbConn.defaultPageId)
                  // When a note is already posted, we keep updating *that* page —
                  // so the main button targets the original page in update mode.
                  const targetId = fp ? fp.pageId : fbConn.defaultPageId
                  const targetPage = fbConn.pages.find(p => p.id === targetId) ?? defaultPage
                  const dirty = fp ? selectedNote.body.trim() !== fp.syncedBody.trim() : true
                  const canPost = selectedNote.body.trim().length > 0
                  const targetName = targetPage?.name || targetPage?.id || ''
                  const label = fp
                    ? (dirty ? 'Update FB post' : 'Synced with FB')
                    : (fbConn.pages.length > 1 ? `Post to ${targetName}` : 'Post to Facebook')
                  const otherPages = fbConn.pages.filter(p => p.id !== targetId)
                  return (
                    <>
                      {fp && (
                        <a
                          href={postUrl(fp.id)}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="icon-btn"
                          title="Open post on Facebook"
                          aria-label="Open post on Facebook"
                        >
                          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                            <path d="M5 2H2v10h10V9M8 2h4v4M12 2L6.5 7.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
                          </svg>
                        </a>
                      )}
                      <div className={`fb-post-split${fp && !dirty ? ' fb-post-split--synced' : ''}`}>
                        <button
                          className="fb-post-btn fb-post-btn--main"
                          onClick={() => handleFbPublish()}
                          disabled={fbBusy || !canPost || (!!fp && !dirty)}
                          title={label}
                        >
                          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                            <path d="M14 8a6 6 0 1 0-6.94 5.93V9.84H5.31V8h1.75V6.66c0-1.73 1.03-2.68 2.6-2.68.75 0 1.54.14 1.54.14v1.69h-.87c-.85 0-1.12.53-1.12 1.07V8h1.9l-.3 1.84H9.21v4.09A6.003 6.003 0 0 0 14 8z" fill="currentColor"/>
                          </svg>
                          <span>
                            {fbBusy
                              ? (fp ? 'Updating…' : 'Posting…')
                              : label}
                          </span>
                        </button>
                        {otherPages.length > 0 && !fbBusy && (
                          <FbPostMenu
                            pages={otherPages}
                            canPost={canPost}
                            hasExistingPost={!!fp}
                            onPost={(pageId) => handleFbPublish(pageId)}
                          />
                        )}
                      </div>
                    </>
                  )
                })()}
                <button
                  className="delete-btn"
                  onClick={() => handleDelete(selectedNote.id)}
                  aria-label="Delete note"
                  title="Delete note"
                >
                  <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <path d="M2.5 4.5h11M6 4.5V3h4v1.5M4.5 4.5l.75 8h6.5l.75-8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                </button>
              </div>
            </div>

          </div>
        )}
      </main>

    </div>

      {/* ── Lightbox ────────────────────────────────────────────────── */}
      {lightboxIndex !== null && selectedNote && (() => {
        const media = selectedNote.media
        const item  = media[lightboxIndex]
        const hasPrev = media.length > 1
        const hasNext = media.length > 1
        if (!item) return null
        return (
          <div
            className="lightbox-overlay"
            onClick={() => setLightboxIndex(null)}
            role="dialog"
            aria-modal="true"
            aria-label="Media viewer"
          >
            <button className="lightbox-close" onClick={() => setLightboxIndex(null)} aria-label="Close">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                <path d="M1 1l12 12M13 1L1 13" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
              </svg>
            </button>

            {hasPrev && (
              <button
                className="lightbox-nav lightbox-nav--prev"
                onClick={(e) => { e.stopPropagation(); setLightboxIndex((lightboxIndex - 1 + media.length) % media.length) }}
                aria-label="Previous"
              >
                <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
                  <path d="M11 4l-5 5 5 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </button>
            )}

            <LightboxItem refItem={item} index={lightboxIndex} />

            {hasNext && (
              <button
                className="lightbox-nav lightbox-nav--next"
                onClick={(e) => { e.stopPropagation(); setLightboxIndex((lightboxIndex + 1) % media.length) }}
                aria-label="Next"
              >
                <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
                  <path d="M7 4l5 5-5 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </button>
            )}

            {media.length > 1 && (
              <div className="lightbox-dots" onClick={(e) => e.stopPropagation()}>
                {media.map((m, i) => (
                  <button
                    key={m.id}
                    className={`lightbox-dot${i === lightboxIndex ? ' lightbox-dot--active' : ''}`}
                    onClick={() => setLightboxIndex(i)}
                    aria-label={`Go to ${i + 1}`}
                  />
                ))}
              </div>
            )}
          </div>
        )
      })()}

      <InstallPrompt />

      {/* ── Global sync transfer request modal ─────────────────────── */}
      {syncState.pendingTransfer && (
        <div
          className="modal-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="sync-transfer-title"
        >
          <div className="modal-box">
            <h3 id="sync-transfer-title" className="modal-title">
              Allow sync to {syncState.pendingTransfer.requesterName}?
            </h3>
            <p className="modal-desc">
              Another device using your sync code wants to import all your notes from this device.
              Only approve if you recognize this device.
            </p>
            <div className="modal-actions">
              <button
                className="modal-cancel-btn"
                onClick={() => denyTransfer(syncState.pendingTransfer!.transferId)}
              >
                Deny
              </button>
              <button
                className="modal-confirm-btn"
                onClick={() => approveTransfer(syncState.pendingTransfer!.transferId)}
              >
                Approve
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

// ── Lightbox item — pulls blob URL from IDB ─────────────────────────────────
function LightboxItem({ refItem, index }: { refItem: MediaRef; index: number }) {
  const url = useMediaUrl(refItem.id)
  if (!url) return <div className="lightbox-img lightbox-img--loading" />
  if (refItem.type === 'video') {
    return (
      <video
        src={url}
        controls
        autoPlay
        playsInline
        className="lightbox-img"
        onClick={(e) => e.stopPropagation()}
      />
    )
  }
  return (
    <img
      src={url}
      alt={`Attachment ${index + 1}`}
      className="lightbox-img"
      onClick={(e) => e.stopPropagation()}
    />
  )
}

// ── FB post split-button menu — picks an alternate page to publish to ───────
interface FbPostMenuProps {
  pages: { id: string; name: string; picture: string | null; category: string }[]
  canPost: boolean
  hasExistingPost: boolean
  onPost: (pageId: string) => void
}

function FbPostMenu({ pages, canPost, hasExistingPost, onPost }: FbPostMenuProps) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onClick = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className="fb-post-menu" ref={wrapRef}>
      <button
        className="fb-post-btn fb-post-btn--caret"
        onClick={() => setOpen(o => !o)}
        disabled={!canPost}
        aria-label="Post to another page"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Post to another page"
      >
        <svg width="9" height="9" viewBox="0 0 10 10" fill="none" aria-hidden="true">
          <path d="M2 3.5l3 3 3-3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </button>
      {open && (
        <div className="fb-post-menu-pop" role="menu">
          <p className="fb-post-menu-label">
            {hasExistingPost ? 'Also publish to' : 'Post to another page'}
          </p>
          {pages.map(p => (
            <button
              key={p.id}
              className="fb-post-menu-item"
              role="menuitem"
              onClick={() => { setOpen(false); onPost(p.id) }}
            >
              {p.picture ? (
                <img src={p.picture} alt="" className="fb-post-menu-pic" />
              ) : (
                <span className="fb-post-menu-pic fb-post-menu-pic--placeholder" aria-hidden="true">
                  <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
                    <path d="M14 8a6 6 0 1 0-6.94 5.93V9.84H5.31V8h1.75V6.66c0-1.73 1.03-2.68 2.6-2.68.75 0 1.54.14 1.54.14v1.69h-.87c-.85 0-1.12.53-1.12 1.07V8h1.9l-.3 1.84H9.21v4.09A6.003 6.003 0 0 0 14 8z" fill="currentColor"/>
                  </svg>
                </span>
              )}
              <span className="fb-post-menu-name">{p.name || p.id}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}