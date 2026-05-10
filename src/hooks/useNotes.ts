import { useState, useCallback, useEffect, useRef } from 'react';
import type { Note, FbPostInfo, MediaRef } from '../types';
import {
  putMedia,
  deleteMedia,
  base64ToBlob,
  type MediaRecord,
} from '../utils/media';
import {
  isSyncEnabled,
  syncPushSingle,
  syncDeleteNote,
  startSync,
  stopSync,
  syncOnce,
  getLastSyncTime,
  type SyncState,
  type SyncCallbacks,
} from '../utils/sync';
import type { S3Config } from '../utils/s3';

const STORAGE_KEY   = 'notes-app-v1';
const MIGRATION_KEY = 'notes-media-migrated-v1';

interface RawNote {
  id?: unknown;
  title?: unknown;
  content?: unknown;
  body?: unknown;
  images?: unknown;
  media?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
  fbPost?: unknown;
}

function load(): Note[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as RawNote[];
    return parsed.map((n) => {
      let body: string;
      if (typeof n.body === 'string') {
        body = n.body;
      } else {
        const title   = typeof n.title   === 'string' ? n.title   : '';
        const content = typeof n.content === 'string' ? n.content : '';
        body = title ? (content ? `${title}\n\n${content}` : title) : content;
      }
      const media = Array.isArray(n.media)
        ? (n.media as unknown[]).filter((m): m is MediaRef =>
            !!m && typeof m === 'object' &&
            typeof (m as MediaRef).id   === 'string' &&
            typeof (m as MediaRef).type === 'string')
        : [];
      const fbPost =
        n.fbPost && typeof n.fbPost === 'object'
          ? (n.fbPost as FbPostInfo)
          : undefined;
      return {
        id:        String(n.id ?? crypto.randomUUID()),
        body,
        media,
        createdAt: Number(n.createdAt ?? Date.now()),
        updatedAt: Number(n.updatedAt ?? Date.now()),
        ...(fbPost ? { fbPost } : {}),
      };
    });
  } catch {
    return [];
  }
}

function persist(notes: Note[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(notes));
}

/**
 * One-shot migration: legacy `images: string[]` (data URLs) get extracted,
 * stored in IndexedDB, and replaced with `media` refs. Frees localStorage.
 */
async function migrateLegacyImages(): Promise<Note[] | null> {
  if (localStorage.getItem(MIGRATION_KEY)) return null;
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    localStorage.setItem(MIGRATION_KEY, '1');
    return null;
  }
  let parsed: RawNote[];
  try { parsed = JSON.parse(raw) as RawNote[]; }
  catch { localStorage.setItem(MIGRATION_KEY, '1'); return null; }

  let didMigrate = false;
  const migrated: Note[] = [];
  for (const n of parsed) {
    const legacyImages = Array.isArray(n.images)
      ? (n.images as unknown[]).filter((s): s is string => typeof s === 'string')
      : [];
    const existingMedia = Array.isArray(n.media)
      ? (n.media as unknown[]).filter((m): m is MediaRef =>
          !!m && typeof m === 'object' &&
          typeof (m as MediaRef).id   === 'string' &&
          typeof (m as MediaRef).type === 'string')
      : [];

    const newMedia: MediaRef[] = [...existingMedia];
    for (const dataUrl of legacyImages) {
      const m = /^data:([^;]+);base64,(.*)$/.exec(dataUrl);
      if (!m) continue;
      const [, mime, b64] = m;
      const blob = base64ToBlob(b64, mime);
      const rec: MediaRecord = {
        id: crypto.randomUUID(),
        type: 'image',
        mime,
        blob,
        size: blob.size,
        createdAt: Date.now(),
      };
      try {
        await putMedia(rec);
        newMedia.push({ id: rec.id, type: 'image', mime, size: rec.size });
        didMigrate = true;
      } catch { /* skip on failure */ }
    }

    let body: string;
    if (typeof n.body === 'string') body = n.body;
    else {
      const title   = typeof n.title   === 'string' ? n.title   : '';
      const content = typeof n.content === 'string' ? n.content : '';
      body = title ? (content ? `${title}\n\n${content}` : title) : content;
    }
      const fbPost =
        n.fbPost && typeof n.fbPost === 'object'
          ? (n.fbPost as FbPostInfo)
          : undefined;

    migrated.push({
      id:        String(n.id ?? crypto.randomUUID()),
      body,
      media:     newMedia,
      createdAt: Number(n.createdAt ?? Date.now()),
      updatedAt: Number(n.updatedAt ?? Date.now()),
      ...(fbPost ? { fbPost } : {}),
    });
  }

  if (didMigrate) persist(migrated);
  localStorage.setItem(MIGRATION_KEY, '1');
  return didMigrate ? migrated : null;
}

export function useNotes() {
  const [notes, setNotes] = useState<Note[]>(load);
  const [syncState, setSyncState] = useState<SyncState>({
    enabled: isSyncEnabled(),
    status: isSyncEnabled() ? 'idle' : 'disabled',
    lastSync: getLastSyncTime(),
    error: null,
  });
  const notesRef = useRef(notes);
  notesRef.current = notes;
  const pushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const s3ConfigRef = useRef<S3Config | null>(null);

  // Debounced push: waits 3s after last change before syncing to S3
  const schedulePush = useCallback((note: Note) => {
    if (!isSyncEnabled() || !s3ConfigRef.current) return;
    if (pushTimerRef.current) clearTimeout(pushTimerRef.current);
    pushTimerRef.current = setTimeout(() => {
      if (s3ConfigRef.current) {
        syncPushSingle(note, s3ConfigRef.current).catch(() => {});
      }
    }, 3000);
  }, []);

  useEffect(() => {
    let cancelled = false;
    migrateLegacyImages()
      .then((migrated) => { if (!cancelled && migrated) setNotes(migrated); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const createNote = useCallback((): Note => {
    const note: Note = {
      id: crypto.randomUUID(),
      body: '',
      media: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    setNotes((prev) => {
      const next = [note, ...prev];
      persist(next);
      return next;
    });
    return note;
  }, []);

  const updateNote = useCallback(
    (id: string, patch: Partial<Pick<Note, 'body'>>) => {
      setNotes((prev) => {
        const next = prev.map((n) =>
          n.id === id ? { ...n, ...patch, updatedAt: Date.now() } : n
        );
        persist(next);
        return next;
      });
    },
    []
  );

  const deleteNote = useCallback((id: string) => {
    setNotes((prev) => {
      const target = prev.find((n) => n.id === id);
      if (target) {
        Promise.all(target.media.map((m) => deleteMedia(m.id))).catch(() => {});
      }
      const next = prev.filter((n) => n.id !== id);
      persist(next);
      // Push deletion to S3
      if (s3ConfigRef.current) {
        syncDeleteNote(id, s3ConfigRef.current).catch(() => {});
      }
      return next;
    });
  }, []);

  const addMedia = useCallback((id: string, refs: MediaRef[]) => {
    setNotes((prev) => {
      const next = prev.map((n) =>
        n.id === id
          ? { ...n, media: [...n.media, ...refs], updatedAt: Date.now() }
          : n
      );
      persist(next);
      return next;
    });
  }, []);

  const removeMedia = useCallback((id: string, index: number) => {
    setNotes((prev) => {
      const next = prev.map((n) => {
        if (n.id !== id) return n;
        const media = [...n.media];
        const [removed] = media.splice(index, 1);
        if (removed) deleteMedia(removed.id).catch(() => {});
        return { ...n, media, updatedAt: Date.now() };
      });
      persist(next);
      return next;
    });
  }, []);

  const restoreNotes = useCallback((restoredNotes: Note[]) => {
    persist(restoredNotes);
    setNotes(restoredNotes);
  }, []);

  const setFbPost = useCallback((id: string, fbPost: FbPostInfo) => {
    setNotes((prev) => {
      const next = prev.map((n) =>
        n.id === id ? { ...n, fbPost } : n
      );
      persist(next);
      return next;
    });
  }, []);

  const clearFbPost = useCallback((id: string) => {
    setNotes((prev) => {
      const next = prev.map((n) => {
        if (n.id !== id) return n;
        const { fbPost: _omit, ...rest } = n;
        void _omit;
        return rest as Note;
      });
      persist(next);
      return next;
    });
  }, []);

  // ── Sync lifecycle ──────────────────────────────────────────────────────

  const initSync = useCallback((s3: S3Config) => {
    s3ConfigRef.current = s3;
    if (!isSyncEnabled()) return;
    const callbacks: SyncCallbacks = {
      getNotes: () => notesRef.current,
      onNotesChanged: (merged) => {
        persist(merged);
        setNotes(merged);
      },
      onStatusChange: setSyncState,
    };
    startSync(callbacks, s3);
  }, []);

  const stopSyncEngine = useCallback(() => {
    stopSync();
  }, []);

  const triggerSync = useCallback(async () => {
    if (!s3ConfigRef.current) return;
    setSyncState(prev => ({ ...prev, status: 'syncing' }));
    try {
      await syncOnce(
        () => notesRef.current,
        (merged) => { persist(merged); setNotes(merged); },
        s3ConfigRef.current,
      );
      setSyncState({ enabled: true, status: 'idle', lastSync: Date.now(), error: null });
    } catch (e) {
      setSyncState(prev => ({ ...prev, status: 'error', error: (e as Error).message }));
    }
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => { stopSync(); };
  }, []);

  return {
    notes,
    createNote,
    updateNote,
    deleteNote,
    addMedia,
    removeMedia,
    restoreNotes,
    setFbPost,
    clearFbPost,
    syncState,
    initSync,
    stopSyncEngine,
    triggerSync,
    schedulePush,
  };
}
