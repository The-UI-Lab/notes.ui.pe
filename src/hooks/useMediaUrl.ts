import { useEffect, useState } from 'react'
import { getMediaUrl, releaseMediaUrl } from '../utils/media'

/** Returns a refcounted blob URL for the given media id (or `null` while loading). */
export function useMediaUrl(id: string | undefined | null): string | null {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!id) { setUrl(null); return }
    let cancelled = false
    let acquired  = false
    getMediaUrl(id).then((u) => {
      if (cancelled) {
        if (u) releaseMediaUrl(id)
        return
      }
      acquired = !!u
      setUrl(u)
    })
    return () => {
      cancelled = true
      if (acquired) releaseMediaUrl(id)
    }
  }, [id])
  return url
}
