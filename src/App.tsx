import { useState, useRef, useEffect, useCallback } from 'react'
import { useNotes } from './hooks/useNotes'
import type { Note } from './types'
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

function exportNotes(notes: Note[]): void {
  if (!notes.length) return
  const text = [...notes]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((n) => {
      const title = extractTitle(n.body)
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

// ── Component ────────────────────────────────────────────────────────────────

export default function App() {
  const { notes, createNote, updateNote, deleteNote } = useNotes()
  const sortedNotes = [...notes].sort((a, b) => b.updatedAt - a.updatedAt)

  const [selectedId,  setSelectedId]  = useState<string | null>(() => sortedNotes[0]?.id ?? null)
  const [mobileView,  setMobileView]  = useState<'list' | 'editor'>('list')
  const [sidebarView, setSidebarView] = useState<'notes' | 'settings'>('notes')
  const [showSaved,   setShowSaved]   = useState(false)
  const [streak,      setStreak]      = useState<number>(getStreak)
  const [theme,       setTheme]       = useState<Theme>(loadTheme)
  const [searchQuery, setSearchQuery] = useState('')

  const filteredNotes = searchQuery.trim()
    ? sortedNotes.filter(n => n.body.toLowerCase().includes(searchQuery.toLowerCase()))
    : sortedNotes

  const saveTimer    = useRef<ReturnType<typeof setTimeout> | null>(null)
  const titleLineRef = useRef<HTMLInputElement>(null)
  const restRef      = useRef<HTMLTextAreaElement>(null)
  const notesListRef = useRef<HTMLDivElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)

  const [searchOpen, setSearchOpen] = useState(false)

  const selectedNote: Note | undefined = notes.find((n) => n.id === selectedId)

  // ── Theme ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    applyTheme(theme)
    localStorage.setItem(THEME_KEY, theme)
  }, [theme])

  // ── Scroll to top on note switch ──────────────────────────────────────────
  useEffect(() => {
    const scroll = restRef.current?.closest('.editor-scroll')
    if (scroll instanceof HTMLElement) scroll.scrollTop = 0
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
      }, 700)
    },
    [updateNote]
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

  // ── Auto-resize rest textarea ─────────────────────────────────────────────
  const autoResize = useCallback(() => {
    const ta = restRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = `${ta.scrollHeight}px`
  }, [])

  useEffect(() => {
    autoResize()
  }, [selectedNote?.body, autoResize])

  // ── Keyboard shortcuts ────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'n') {
        e.preventDefault()
        handleNewNote()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [handleNewNote])

  // ── Derived ───────────────────────────────────────────────────────────────
  const words      = selectedNote ? countWords(selectedNote.body) : 0
  const totalWords = notes.reduce((s, n) => s + countWords(n.body), 0)

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
  return (
    <div className={`app${mobileView === 'editor' ? ' app--editor-view' : ''}`}>

      {/* ── Sidebar ──────────────────────────────────────────────────────── */}
      <aside className="sidebar" aria-label="Notes list">

        <div className="sidebar-brand">
          {sidebarView === 'settings' ? (
            <>
              <button className="icon-btn" onClick={() => setSidebarView('notes')} aria-label="Back to notes">
                <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
                  <path d="M11 4l-5 5 5 5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </button>
              <span className="sidebar-brand-name">Settings</span>
            </>
          ) : (
            <>
              <svg className="sidebar-brand-icon" width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                <rect x="3" y="2" width="12" height="16" rx="2" stroke="currentColor" strokeWidth="1.5" fill="none"/>
                <path d="M6.5 7.5h7M6.5 10.5h5.5M6.5 13.5h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
              </svg>
              <span className="sidebar-brand-name">Notes</span>
              {streak > 1 && (
                <span className="streak-badge" title={`${streak}-day writing streak`}>
                  <svg width="10" height="10" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                    <path d="M6 1C6 1 9.5 4 9.5 7A3.5 3.5 0 0 1 2.5 7C2.5 5.2 4 3 6 1Z" fill="currentColor"/>
                  </svg>
                  {streak}
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
            <div className="settings-section">
              <p className="settings-label">Data</p>
              <button
                className="settings-action-btn"
                onClick={() => exportNotes(notes)}
                disabled={notes.length === 0}
              >
                Export all notes
              </button>
            </div>
            <div className="settings-stats">
              <span>{notes.length} {notes.length === 1 ? 'note' : 'notes'}</span>
              <span className="sep">·</span>
              <span>{totalWords.toLocaleString()} words total</span>
            </div>
          </div>
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
              ) : (
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
              <button className="icon-btn" onClick={() => setSidebarView('settings')} aria-label="Settings" title="Settings">
                <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.4"/>
                  <path d="M8 1.5V3M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1.06 1.06M11.54 11.54l1.06 1.06M3.4 12.6l1.06-1.06M11.54 4.46l1.06-1.06" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
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
              <div className="editor-welcome-icon" aria-hidden="true">
                <svg width="44" height="44" viewBox="0 0 44 44" fill="none">
                  <rect x="7" y="5" width="25" height="32" rx="4" stroke="currentColor" strokeWidth="1.8" fill="none" opacity="0.2"/>
                  <path d="M14 17h16M14 22h12M14 27h8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" opacity="0.35"/>
                  <path d="M30 26l7-7-3.5-3.5-7 7v3.5H30z" fill="currentColor" opacity="0.6"/>
                </svg>
              </div>
              <h2>Nothing open yet</h2>
              <p>Select a note or tap the pen to start.</p>
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

            <div className="editor-scroll">
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
  )
}
