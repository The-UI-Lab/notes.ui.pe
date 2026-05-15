import { useState, useCallback, useEffect, useRef } from 'react';
import type { Note, FbPostInfo, MediaRef, GalleryItem } from '../types';
import {
  putMedia,
  deleteMedia,
  base64ToBlob,
  addToGallery,
  removeFromGallery,
  getAllGalleryItems,
  deleteGalleryItem,
  type MediaRecord,
} from '../utils/media';
import {
  isSyncEnabled,
  syncPushSingle,
  syncDeleteNote,
  syncPushGalleryAdd,
  syncPushGalleryRemove,
  startSync,
  stopSync,
  triggerSync as syncTrigger,
  getLastSyncTime,
  type SyncState,
  type SyncCallbacks,
} from '../utils/sync';
import { secureGet, secureSet } from '../utils/vault';

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

function parseNotes(raw: string): Note[] {
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
}

async function loadNotes(): Promise<Note[]> {
  try {
    const raw = await secureGet(STORAGE_KEY);
    if (!raw) return [];
    return parseNotes(raw);
  } catch {
    return [];
  }
}

function persist(notes: Note[]): void {
  // Fire-and-forget async encryption + write
  secureSet(STORAGE_KEY, JSON.stringify(notes)).catch(() => {});
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
  const [notes, setNotes] = useState<Note[]>([]);
  const [notesLoaded, setNotesLoaded] = useState(false);
  const [galleryItems, setGalleryItems] = useState<GalleryItem[]>([]);
  const [syncState, setSyncState] = useState<SyncState>({
    enabled: isSyncEnabled(),
    status: isSyncEnabled() ? 'idle' : 'disabled',
    lastSync: getLastSyncTime(),
    error: null,
    deviceCount: 0,
  });
  const notesRef = useRef(notes);
  notesRef.current = notes;
  const galleryRef = useRef(galleryItems);
  galleryRef.current = galleryItems;
  const pushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Debounced push: waits 1.5s after last change before syncing via WebSocket
  const schedulePush = useCallback((note: Note) => {
    if (!isSyncEnabled()) return;
    if (pushTimerRef.current) clearTimeout(pushTimerRef.current);
    pushTimerRef.current = setTimeout(() => {
      syncPushSingle(note).catch(() => {});
    }, 1500);
  }, []);

  // Load notes from encrypted storage once vault is unlocked
  const loadFromVault = useCallback(async () => {
    const loaded = await loadNotes();
    setNotes(loaded);
    setNotesLoaded(true);
    // Run legacy migration after load
    try {
      const migrated = await migrateLegacyImages();
      if (migrated) {
        persist(migrated);
        setNotes(migrated);
      }
    } catch { /* migration is best-effort */ }
  }, []);

  // Load gallery separately — never blocks vault initialization.
  // Uses a timeout so an IDB version-upgrade stall (old tab holds v1 open)
  // cannot hang the app.
  const loadGallery = useCallback(() => {
    const TIMEOUT_MS = 5000;
    const promise = getAllGalleryItems();
    const timeout = new Promise<GalleryItem[]>((_, reject) =>
      setTimeout(() => reject(new Error('gallery-idb-timeout')), TIMEOUT_MS)
    );
    Promise.race([promise, timeout])
      .then(items => setGalleryItems(items))
      .catch(() => { /* best-effort: gallery stays empty, user can still add */ });
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
      // Push deletion via sync
      syncDeleteNote(id).catch(() => {});
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

  /** Add one or more files to the gallery. */
  const addToGalleryItems = useCallback(async (records: MediaRecord[]): Promise<GalleryItem[]> => {
    const newItems: GalleryItem[] = [];
    for (const rec of records) {
      await putMedia(rec);
      const item: GalleryItem = {
        id: rec.id,
        type: rec.type,
        mime: rec.mime,
        size: rec.size,
        width: rec.width,
        height: rec.height,
        durationMs: rec.durationMs,
        createdAt: rec.createdAt,
      };
      await addToGallery(item);
      syncPushGalleryAdd(item).catch(() => {});
      newItems.push(item);
    }
    setGalleryItems(prev => [...prev, ...newItems]);
    return newItems;
  }, []);

  /** Remove an item from the gallery (deletes blob + manifest entry). */
  const removeGalleryItem = useCallback(async (id: string) => {
    await deleteGalleryItem(id);
    syncPushGalleryRemove(id).catch(() => {});
    setGalleryItems(prev => prev.filter(i => i.id !== id));
  }, []);

  /**
   * Move a gallery item into a note: adds it to the note's media array and
   * removes it from the gallery manifest (blob stays in the media store).
   */
  const useGalleryItem = useCallback((item: GalleryItem, noteId: string) => {
    // Add to note
    const ref: MediaRef = {
      id: item.id,
      type: item.type,
      mime: item.mime,
      size: item.size,
      width: item.width,
      height: item.height,
      durationMs: item.durationMs,
    };
    setNotes(prev => {
      const next = prev.map(n =>
        n.id === noteId
          ? { ...n, media: [...n.media, ref], updatedAt: Date.now() }
          : n
      );
      persist(next);
      return next;
    });
    // Remove from gallery (manifest only — blob stays)
    removeFromGallery(item.id).catch(() => {});
    syncPushGalleryRemove(item.id).catch(() => {});
    setGalleryItems(prev => prev.filter(i => i.id !== item.id));
    // Schedule sync push of the updated note
    setNotes(prev => {
      const note = prev.find(n => n.id === noteId);
      if (note) syncPushSingle(note).catch(() => {});
      return prev;
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

  const initSync = useCallback(() => {
    if (!isSyncEnabled()) return;
    const cbs: SyncCallbacks = {
      getNotes: () => notesRef.current,
      onNotesChanged: (merged) => {
        persist(merged);
        setNotes(merged);
      },
      onNoteUpdated: (note) => {
        setNotes((prev) => {
          const exists = prev.find(n => n.id === note.id);
          let next: Note[];
          if (exists) {
            next = prev.map(n => n.id === note.id ? note : n);
          } else {
            next = [note, ...prev];
          }
          persist(next);
          return next;
        });
      },
      onNoteDeleted: (noteId) => {
        setNotes((prev) => {
          const next = prev.filter(n => n.id !== noteId);
          persist(next);
          return next;
        });
      },
      onStatusChange: setSyncState,
      // Gallery callbacks
      getGalleryItems: () => galleryRef.current,
      onGalleryItemAdded: (item) => {
        // Store blob is already handled in applyRemoteOp; just update UI state
        addToGallery(item).catch(() => {});
        setGalleryItems(prev => {
          if (prev.find(i => i.id === item.id)) return prev;
          return [...prev, item];
        });
      },
      onGalleryItemRemoved: (id) => {
        removeFromGallery(id).catch(() => {});
        setGalleryItems(prev => prev.filter(i => i.id !== id));
      },
    };
    startSync(cbs);
  }, []);

  const stopSyncEngine = useCallback(() => {
    stopSync();
  }, []);

  const triggerSync = useCallback(async () => {
    await syncTrigger();
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
    galleryItems,
    addToGalleryItems,
    removeGalleryItem,
    useGalleryItem,
    syncState,
    setSyncState,
    notesLoaded,
    loadFromVault,
    loadGallery,
    initSync,
    stopSyncEngine,
    triggerSync,
    schedulePush,
  };
}
