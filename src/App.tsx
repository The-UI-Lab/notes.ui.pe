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

function countWords(text: string): number {
  return text.trim() ? text.trim().split(/\s+/).length : 0
}

const STREAK_KEY = 'notes-streak-v1'

function getStreak(): number {
  try {
    const raw = localStorage.getItem(STREAK_KEY)
    return raw ? (JSON.parse(raw).count as number) : 0
  } catch {
    return 0
  }
}

function bumpStreak(): number {
  const today = new Date().toISOString().slice(0, 10)
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
  try {
    const raw = localStorage.getItem(STREAK_KEY)
    const data = raw ? JSON.parse(raw) : { lastDate: '', count: 0 }
    if (data.lastDate === today) return data.count as number
    const newCount: number = data.lastDate === yesterday ? data.count + 1 : 1
    localStorage.setItem(STREAK_KEY, JSON.stringify({ lastDate: today, count: newCount }))
    return newCount
  } catch {
    return 1
  }
}

// ── Component ────────────────────────────────────────────────────────────────

export default function App() {
  const { notes, createNote, updateNote, deleteNote } = useNotes()

  const sortedNotes = [...notes].sort((a, b) => b.updatedAt - a.updatedAt)

  const [selectedId, setSelectedId] = useState<string | null>(
    () => sortedNotes[0]?.id ?? null
  )
  const [mobileView, setMobileView] = useState<'list' | 'editor'>('list')
  const [showSaved, setShowSaved] = useState(false)
  const [streak, setStreak] = useState<number>(getStreak)

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const titleRef = useRef<HTMLInputElement>(null)
  const contentRef = useRef<HTMLTextAreaElement>(null)

  const selectedNote: Note | undefined = notes.find((n) => n.id === selectedId)

  // ── Handlers ──────────────────────────────────────────────────────────────

  const handleNewNote = useCallback(() => {
    const note = createNote()
    setSelectedId(note.id)
    setMobileView('editor')
    setTimeout(() => titleRef.current?.focus(), 50)
  }, [createNote])

  const handleSelectNote = useCallback((id: string) => {
    setSelectedId(id)
    setMobileView('editor')
  }, [])

  const handleUpdate = useCallback(
    (id: string, patch: { title?: string; content?: string }) => {
      updateNote(id, patch)
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

  // ── Auto-resize textarea ──────────────────────────────────────────────────

  const autoResize = useCallback(() => {
    const ta = contentRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = `${ta.scrollHeight}px`
  }, [])

  useEffect(() => {
    autoResize()
  }, [selectedNote?.content, autoResize])

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

  const words = selectedNote ? countWords(selectedNote.content) : 0

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className={`app${mobileView === 'editor' ? ' app--editor-view' : ''}`}>

      {/* ── Sidebar ──────────────────────────────────────────────────────── */}
      <aside className="sidebar" aria-label="Notes list">

        <div className="sidebar-brand">
          <svg className="sidebar-brand-icon" width="22" height="22" viewBox="0 0 22 22" fill="none" aria-hidden="true">
            <rect x="3" y="2" width="14" height="18" rx="2.5" stroke="currentColor" strokeWidth="1.6" fill="none"/>
            <path d="M7 8h8M7 11.5h6M7 15h4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
            <path d="M15 2v4h4" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" fill="none"/>
          </svg>
          <span className="sidebar-brand-name">Notes</span>
          {streak > 1 && (
            <span className="streak-badge" title={`${streak}-day writing streak`}>
              <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                <path d="M6 1C6 1 9.5 4 9.5 7A3.5 3.5 0 0 1 2.5 7C2.5 5.2 4 3 6 1Z" fill="currentColor"/>
              </svg>
              {streak}
            </span>
          )}
        </div>

        <button className="new-note-btn" onClick={handleNewNote} title="New note (⌘N)">
          <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden="true">
            <path d="M7.5 2v11M2 7.5h11" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
          </svg>
          New note
        </button>

        <div className="notes-list" role="list">
          {sortedNotes.length === 0 ? (
            <div className="notes-empty">
              <p>Every great idea starts somewhere.</p>
              <button className="notes-empty-cta" onClick={handleNewNote}>Write your first note</button>
            </div>
          ) : (
            sortedNotes.map((note) => (
              <button
                key={note.id}
                role="listitem"
                className={`note-item${selectedId === note.id ? ' note-item--active' : ''}`}
                onClick={() => handleSelectNote(note.id)}
              >
                <span className="note-item-title">{note.title || 'Untitled'}</span>
                <span className="note-item-preview">
                  {note.content.slice(0, 72) || 'No content yet'}
                </span>
                <span className="note-item-meta">{formatDate(note.updatedAt)}</span>
              </button>
            ))
          )}
        </div>

        <div className="sidebar-footer">
          <span>{notes.length} {notes.length === 1 ? 'note' : 'notes'}</span>
          <span className="sidebar-footer-hint">⌘N new</span>
        </div>
      </aside>

      {/* ── Editor pane ──────────────────────────────────────────────────── */}
      <main className="editor-pane">
        {!selectedNote ? (
          <div className="editor-welcome" aria-label="Welcome screen">
            <div className="editor-welcome-inner">
              <div className="editor-welcome-icon" aria-hidden="true">
                <svg width="48" height="48" viewBox="0 0 48 48" fill="none">
                  <rect x="8" y="6" width="28" height="36" rx="4" stroke="currentColor" strokeWidth="2" fill="none" opacity="0.25"/>
                  <path d="M16 18h16M16 24h12M16 30h8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" opacity="0.4"/>
                  <path d="M34 28l8-8-4-4-8 8v4h4z" fill="currentColor" opacity="0.7"/>
                </svg>
              </div>
              <h2>Nothing open yet</h2>
              <p>Pick a note on the left, or start fresh.</p>
              <button className="new-note-btn new-note-btn--welcome" onClick={handleNewNote}>
                <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden="true">
                  <path d="M7.5 2v11M2 7.5h11" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                </svg>
                New note
              </button>
            </div>
          </div>
        ) : (
          <div className="editor">

            <div className="editor-topbar">
              <button
                className="editor-back-btn"
                onClick={() => setMobileView('list')}
                aria-label="Back to notes"
              >
                <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                  <path d="M13 4l-6 6 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </button>
            </div>

            <div className="editor-scroll">
              <input
                ref={titleRef}
                className="editor-title"
                type="text"
                placeholder="Untitled"
                value={selectedNote.title}
                onChange={(e) => handleUpdate(selectedNote.id, { title: e.target.value })}
                aria-label="Note title"
              />
              <textarea
                ref={contentRef}
                className="editor-textarea"
                placeholder="Let your thoughts flow..."
                value={selectedNote.content}
                onChange={(e) => {
                  handleUpdate(selectedNote.id, { content: e.target.value })
                  autoResize()
                }}
                onInput={autoResize}
                aria-label="Note content"
              />
            </div>

            <div className="editor-footer">
              <div className="editor-stats">
                <span>{words} {words === 1 ? 'word' : 'words'}</span>
                <span className="sep">·</span>
                <span>{selectedNote.content.length} chars</span>
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
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
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


