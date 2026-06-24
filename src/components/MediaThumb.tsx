import { useMediaUrl } from '../hooks/useMediaUrl'
import type { MediaRef } from '../types'

interface ThumbProps {
  refItem: MediaRef
  className?: string
  onClick?: () => void
  showPlayBadge?: boolean
}

/** Lightweight thumbnail that pulls its blob URL from IndexedDB. */
export function MediaThumb({ refItem, className, onClick, showPlayBadge }: ThumbProps) {
  const url = useMediaUrl(refItem.id)
  if (refItem.type === 'video') {
    return (
      <div className={`media-thumb media-thumb--video ${className ?? ''}`} onClick={onClick} role={onClick ? 'button' : undefined}>
        {url
          ? <video src={url} muted preload="metadata" playsInline />
          : <div className="media-thumb-fallback" aria-hidden="true" />
        }
        {showPlayBadge !== false && (
          <span className="media-thumb-play" aria-hidden="true">
            <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
              <circle cx="11" cy="11" r="11" fill="rgba(0,0,0,0.55)"/>
              <path d="M9 7.5v7l6-3.5-6-3.5z" fill="white"/>
            </svg>
          </span>
        )}
      </div>
    )
  }
  return (
    <img
      src={url ?? ''}
      alt=""
      className={`media-thumb media-thumb--image ${className ?? ''}`}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => { if (e.key === 'Enter') onClick() } : undefined}
    />
  )
}
