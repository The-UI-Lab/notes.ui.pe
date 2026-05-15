/**
 * PhotoGallery — a holding area for photos and videos that haven't been
 * attached to a note yet. Items can be added by file-pick or drag-and-drop,
 * and inserted into any open note with one tap. Inserting removes the item
 * from the gallery (it lives in the note from that point forward).
 */

import { useRef, useCallback, useState } from 'react'
import type { GalleryItem } from '../types'
import { MediaThumb } from './MediaThumb'
import { ingestImageFile, ingestVideoFile, type MediaRecord } from '../utils/media'

interface PhotoGalleryProps {
  items: GalleryItem[]
  /** Called with ingested MediaRecords so the hook can persist + sync them. */
  onAdd: (records: MediaRecord[]) => Promise<void>
  /** Remove an item from the gallery entirely (no note target). */
  onRemove: (id: string) => void
  /** Insert a gallery item into the currently open note. */
  onUse: (item: GalleryItem) => void
  /** Whether a note is currently open (enables the "Use" action). */
  hasActiveNote: boolean
  /** Whether multi-device sync is on (shows sync badge). */
  syncEnabled: boolean
}

export function PhotoGallery({
  items,
  onAdd,
  onRemove,
  onUse,
  hasActiveNote,
  syncEnabled,
}: PhotoGalleryProps) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const dropZoneRef  = useRef<HTMLDivElement>(null)
  const [dragOver,   setDragOver]   = useState(false)
  const [ingesting,  setIngesting]  = useState(false)

  const ingestFiles = useCallback(async (files: File[]) => {
    if (!files.length) return
    setIngesting(true)
    try {
      const records: MediaRecord[] = []
      for (const file of files) {
        try {
          const rec = file.type.startsWith('video/')
            ? await ingestVideoFile(file)
            : file.type.startsWith('image/')
              ? await ingestImageFile(file)
              : null
          if (rec) records.push(rec)
        } catch (err) {
          console.error('Gallery: failed to ingest file', err)
        }
      }
      if (records.length) await onAdd(records)
    } finally {
      setIngesting(false)
    }
  }, [onAdd])

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? [])
    if (fileInputRef.current) fileInputRef.current.value = ''
    void ingestFiles(files)
  }, [ingestFiles])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const files = Array.from(e.dataTransfer.files).filter(
      f => f.type.startsWith('image/') || f.type.startsWith('video/')
    )
    void ingestFiles(files)
  }, [ingestFiles])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (Array.from(e.dataTransfer.items).some(
      i => i.type.startsWith('image/') || i.type.startsWith('video/')
    )) {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
      setDragOver(true)
    }
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    // Only clear when leaving the drop zone entirely (not entering a child)
    if (!dropZoneRef.current?.contains(e.relatedTarget as Node)) {
      setDragOver(false)
    }
  }, [])

  const sorted = [...items].sort((a, b) => b.createdAt - a.createdAt)

  return (
    <div className="gallery-panel">
      {/* Header row */}
      <div className="gallery-header">
        {syncEnabled && (
          <span className="gallery-sync-badge" title="Synced across devices">
            <svg width="10" height="10" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <path d="M2 7a5 5 0 0 1 8.5-3.5M12 7a5 5 0 0 1-8.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
              <path d="M10 3l.5 2.5L13 4.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
              <path d="M4 11l-.5-2.5L1 9.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            Synced
          </span>
        )}
        <button
          className="gallery-add-btn"
          onClick={() => fileInputRef.current?.click()}
          disabled={ingesting}
          aria-label="Add photos or videos to gallery"
        >
          {ingesting ? (
            <svg width="12" height="12" viewBox="0 0 14 14" fill="none" className="gallery-spinner" aria-hidden="true">
              <circle cx="7" cy="7" r="5.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeDasharray="10 24"/>
            </svg>
          ) : (
            <svg width="12" height="12" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <path d="M7 1v12M1 7h12" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
            </svg>
          )}
          Add photos
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*,video/*"
          multiple
          style={{ display: 'none' }}
          onChange={handleFileChange}
          aria-hidden="true"
          tabIndex={-1}
        />
      </div>

      {/* Drop zone + grid */}
      <div
        ref={dropZoneRef}
        className={`gallery-grid-wrap${dragOver ? ' gallery-grid-wrap--dragover' : ''}`}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
      >
        {sorted.length === 0 ? (
          <div className="gallery-empty">
            <svg width="28" height="28" viewBox="0 0 28 28" fill="none" aria-hidden="true">
              <rect x="2" y="5" width="24" height="18" rx="3" stroke="currentColor" strokeWidth="1.5"/>
              <circle cx="9" cy="12" r="2.5" stroke="currentColor" strokeWidth="1.3"/>
              <path d="M2 20l7-6 5 5 3-3 9 7" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/>
            </svg>
            <p>No photos yet</p>
            <p className="gallery-empty-sub">Add photos or videos here, then insert them into any note.</p>
            {dragOver && <p className="gallery-drop-hint">Drop to add</p>}
          </div>
        ) : (
          <div className="gallery-grid" role="list" aria-label="Gallery items">
            {sorted.map(item => (
              <GalleryCell
                key={item.id}
                item={item}
                hasActiveNote={hasActiveNote}
                onUse={onUse}
                onRemove={onRemove}
              />
            ))}
          </div>
        )}
        {dragOver && sorted.length > 0 && (
          <div className="gallery-drop-overlay" aria-hidden="true">Drop to add</div>
        )}
      </div>
    </div>
  )
}

// ── Individual gallery cell ───────────────────────────────────────────────

interface GalleryCellProps {
  item: GalleryItem
  hasActiveNote: boolean
  onUse: (item: GalleryItem) => void
  onRemove: (id: string) => void
}

function GalleryCell({ item, hasActiveNote, onUse, onRemove }: GalleryCellProps) {
  const [confirm, setConfirm] = useState(false)

  const handleRemoveClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (confirm) {
      onRemove(item.id)
    } else {
      setConfirm(true)
      // Auto-reset confirm state after 2.5s
      setTimeout(() => setConfirm(false), 2500)
    }
  }

  return (
    <div
      className="gallery-cell"
      role="listitem"
    >
      <div className="gallery-cell-thumb">
        <MediaThumb refItem={item} className="gallery-thumb-img" />
        {item.type === 'video' && (
          <span className="gallery-cell-video-badge" aria-label="Video">
            <svg width="9" height="9" viewBox="0 0 10 10" fill="none" aria-hidden="true">
              <path d="M3 2l5.5 3L3 8V2z" fill="currentColor"/>
            </svg>
          </span>
        )}
      </div>
      <div className="gallery-cell-actions">
        {hasActiveNote && (
          <button
            className="gallery-cell-use"
            onClick={() => onUse(item)}
            title="Insert into note"
            aria-label="Insert into note"
          >
            <svg width="11" height="11" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <path d="M7 1v9M3 7l4 4 4-4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"/>
              <path d="M1 13h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
            Use
          </button>
        )}
        <button
          className={`gallery-cell-remove${confirm ? ' gallery-cell-remove--confirm' : ''}`}
          onClick={handleRemoveClick}
          title={confirm ? 'Tap again to delete' : 'Delete from gallery'}
          aria-label={confirm ? 'Confirm delete' : 'Delete from gallery'}
        >
          {confirm ? (
            <svg width="11" height="11" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <path d="M2 7l4 4 6-7" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          ) : (
            <svg width="10" height="10" viewBox="0 0 12 12" fill="none" aria-hidden="true">
              <path d="M1.5 3h9M5 3V2h2v1M4.5 3l.5 7M7.5 3l-.5 7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          )}
        </button>
      </div>
    </div>
  )
}
