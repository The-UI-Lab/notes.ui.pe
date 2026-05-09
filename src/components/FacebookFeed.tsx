import { useCallback, useMemo, useRef, useState, useEffect } from 'react'
import type { Note } from '../types'
import { deletePost, pageUrl, postUrl, type FbSettings } from '../utils/facebook'
import { MediaThumb } from './MediaThumb'

/** Max collapsed height for post body (in px). Roughly ~6 lines. */
const COLLAPSED_HEIGHT = 120

interface Props {
  notes: Note[]
  fb: FbSettings
  onOpenNote: (id: string) => void
  onClearFbPost: (noteId: string) => void
  onOpenInsights?: () => void
}

function formatRelative(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d`
  const d = new Date(ts)
  return d.toLocaleDateString('en', { month: 'short', day: 'numeric' })
}

function extractTitle(body: string): string {
  return body.split('\n')[0].trim().slice(0, 80) || 'Untitled'
}

/** Renders post body text with a "See more" / "See less" toggle for long content. */
function CollapsibleBody({ text }: { text: string }) {
  const bodyRef = useRef<HTMLDivElement>(null)
  const [overflows, setOverflows] = useState(false)
  const [expanded, setExpanded]   = useState(false)

  useEffect(() => {
    const el = bodyRef.current
    if (!el) return
    setOverflows(el.scrollHeight > COLLAPSED_HEIGHT)
  }, [text])

  const toggle = useCallback(() => setExpanded(e => !e), [])

  return (
    <div className={`fb-post-body-wrap${overflows && !expanded ? ' fb-post-body-wrap--clamped' : ''}`}>
      <div
        ref={bodyRef}
        className="fb-post-body"
        style={overflows && !expanded ? { maxHeight: COLLAPSED_HEIGHT, overflow: 'hidden' } : undefined}
      >
        {text.split('\n').map((line, i) => (
          <p key={i}>{line || '\u00A0'}</p>
        ))}
      </div>
      {overflows && (
        <button className="fb-post-see-more" onClick={toggle}>
          {expanded ? 'See less' : 'See more'}
        </button>
      )}
    </div>
  )
}

export function FacebookFeed({ notes, fb, onOpenNote, onClearFbPost, onOpenInsights }: Props) {
  const published = useMemo(
    () => notes
      .filter((n): n is Note & { fbPost: NonNullable<Note['fbPost']> } => Boolean(n.fbPost))
      .sort((a, b) => b.fbPost.postedAt - a.fbPost.postedAt),
    [notes],
  )

  const [expandedHistory, setExpandedHistory] = useState<Record<string, boolean>>({})
  const [pendingDelete,   setPendingDelete]   = useState<string | null>(null)
  const [deleting,        setDeleting]        = useState(false)
  const [deleteError,     setDeleteError]     = useState<string | null>(null)

  const confirmDelete = async () => {
    if (!pendingDelete) return
    const note = notes.find(n => n.id === pendingDelete)
    if (!note?.fbPost) return
    setDeleting(true)
    setDeleteError(null)
    try {
      await deletePost(fb, note.fbPost.id)
      onClearFbPost(note.id)
      setPendingDelete(null)
    } catch (e) {
      setDeleteError((e as Error).message)
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="fb-feed">

      <div className="fb-feed-header">
        <div className="fb-feed-page">
          <span className="fb-feed-page-avatar" aria-hidden="true">
            <svg width="22" height="22" viewBox="0 0 16 16" fill="none">
              <path d="M14 8a6 6 0 1 0-6.94 5.93V9.84H5.31V8h1.75V6.66c0-1.73 1.03-2.68 2.6-2.68.75 0 1.54.14 1.54.14v1.69h-.87c-.85 0-1.12.53-1.12 1.07V8h1.9l-.3 1.84H9.21v4.09A6.003 6.003 0 0 0 14 8z" fill="currentColor"/>
            </svg>
          </span>
          <div className="fb-feed-page-meta">
            <span className="fb-feed-page-title">Your Page</span>
            <span className="fb-feed-page-sub">{published.length} {published.length === 1 ? 'post' : 'posts'} from Notes</span>
          </div>
          {onOpenInsights && (
            <button
              className="fb-feed-open-link"
              onClick={onOpenInsights}
              title="View Insights"
              aria-label="View Insights"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <rect x="1.5" y="9" width="3" height="5.5" rx="0.7" stroke="currentColor" strokeWidth="1.2"/>
                <rect x="6.5" y="5" width="3" height="9.5" rx="0.7" stroke="currentColor" strokeWidth="1.2"/>
                <rect x="11.5" y="1.5" width="3" height="13" rx="0.7" stroke="currentColor" strokeWidth="1.2"/>
              </svg>
            </button>
          )}
          <a
            href={pageUrl(fb.pageId)}
            target="_blank"
            rel="noopener noreferrer"
            className="fb-feed-open-link"
            title="Open Page on Facebook"
            aria-label="Open Page on Facebook"
          >
            <svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <path d="M5 2H2v10h10V9M8 2h4v4M12 2L6.5 7.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </a>
        </div>
      </div>

      <div className="fb-feed-scroll">
        {published.length === 0 ? (
          <div className="fb-feed-empty">
            <p>No posts yet.</p>
            <span>Publish a note to your Page to see it here.</span>
          </div>
        ) : (
          published.map((note) => {
            const fp = note.fbPost
            const drift = note.body.trim() !== fp.syncedBody.trim()
            const expanded = !!expandedHistory[note.id]
            const visibleMedia = note.media.slice(0, Math.min(fp.mediaCount, 4))
            return (
              <article key={note.id} className="fb-post-card">
                <header className="fb-post-head">
                  <span className="fb-post-avatar" aria-hidden="true">
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                      <path d="M14 8a6 6 0 1 0-6.94 5.93V9.84H5.31V8h1.75V6.66c0-1.73 1.03-2.68 2.6-2.68.75 0 1.54.14 1.54.14v1.69h-.87c-.85 0-1.12.53-1.12 1.07V8h1.9l-.3 1.84H9.21v4.09A6.003 6.003 0 0 0 14 8z" fill="currentColor"/>
                    </svg>
                  </span>
                  <div className="fb-post-head-meta">
                    <span className="fb-post-title">{extractTitle(fp.syncedBody)}</span>
                    <span className="fb-post-sub">
                      {formatRelative(fp.postedAt)}
                      {fp.lastSyncedAt > fp.postedAt && (
                        <> · edited {formatRelative(fp.lastSyncedAt)}</>
                      )}
                      {drift && <span className="fb-post-drift" title="Local note differs from posted version">· unsynced</span>}
                    </span>
                  </div>
                </header>

                <CollapsibleBody text={fp.syncedBody} />

                {fp.mediaCount > 0 && visibleMedia.length > 0 && (
                  <div className={`fb-post-images fb-post-images--${Math.min(fp.mediaCount, 4)}`}>
                    {visibleMedia.map((m, i) => (
                      <div key={m.id} className="fb-post-image">
                        <MediaThumb refItem={m} />
                        {i === 3 && fp.mediaCount > 4 && (
                          <span className="fb-post-image-more">+{fp.mediaCount - 4}</span>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                <footer className="fb-post-actions">
                  <button className="fb-post-action" onClick={() => onOpenNote(note.id)}>
                    <svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                      <path d="M9.5 2.5l2 2-7 7H2.5v-2l7-7z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/>
                    </svg>
                    Edit note
                  </button>
                  <a
                    href={postUrl(fp.id)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="fb-post-action"
                  >
                    <svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                      <path d="M5 2H2v10h10V9M8 2h4v4M12 2L6.5 7.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                    Open
                  </a>
                  {fp.history.length > 1 && (
                    <button
                      className="fb-post-action"
                      onClick={() => setExpandedHistory(s => ({ ...s, [note.id]: !s[note.id] }))}
                    >
                      <svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                        <circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.3"/>
                        <path d="M7 4.5V7l1.7 1" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
                      </svg>
                      {expanded ? 'Hide history' : `History (${fp.history.length})`}
                    </button>
                  )}
                  <button
                    className="fb-post-action fb-post-action--danger"
                    onClick={() => { setDeleteError(null); setPendingDelete(note.id) }}
                  >
                    <svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                      <path d="M2.5 4h9M5 4V2.7h4V4M3.7 4l.6 7h5.4l.6-7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                    Delete
                  </button>
                </footer>

                {expanded && fp.history.length > 1 && (
                  <div className="fb-post-history">
                    {[...fp.history].reverse().map((h, i) => (
                      <div key={i} className="fb-post-history-item">
                        <span className="fb-post-history-meta">
                          {h.action === 'publish' ? 'Published' : 'Updated'}
                          {' · '}
                          {new Date(h.ts).toLocaleString(undefined, {
                            month: 'short', day: 'numeric',
                            hour: '2-digit', minute: '2-digit',
                          })}
                        </span>
                        <p className="fb-post-history-body">{h.body || <em>(empty)</em>}</p>
                      </div>
                    ))}
                  </div>
                )}
              </article>
            )
          })
        )}
      </div>

      {pendingDelete && (
        <div
          className="modal-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="Delete Facebook post"
          onClick={e => { if (e.target === e.currentTarget && !deleting) setPendingDelete(null) }}
        >
          <div className="modal-box">
            <h3 className="modal-title">Delete from Facebook?</h3>
            <p className="modal-desc">
              This permanently removes the post from your Page. The local note will be kept (it just won't be linked anymore).
            </p>
            {deleteError && <p className="modal-error">{deleteError}</p>}
            <div className="modal-actions">
              <button
                className="modal-cancel-btn"
                onClick={() => setPendingDelete(null)}
                disabled={deleting}
              >
                Cancel
              </button>
              <button
                className="modal-confirm-btn modal-confirm-btn--danger"
                onClick={confirmDelete}
                disabled={deleting}
              >
                {deleting ? 'Deleting…' : 'Delete post'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
