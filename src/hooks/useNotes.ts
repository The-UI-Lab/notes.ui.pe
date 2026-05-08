import { useState, useCallback } from 'react';
import type { Note } from '../types';

const STORAGE_KEY = 'notes-app-v1';

function load(): Note[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Array<Record<string, unknown>>;
    return parsed.map((n) => {
      // Migrate old format (title + content) → single body
      let body: string;
      if (typeof n.body === 'string') {
        body = n.body;
      } else {
        const title   = typeof n.title   === 'string' ? n.title   : '';
        const content = typeof n.content === 'string' ? n.content : '';
        body = title ? (content ? `${title}\n\n${content}` : title) : content;
      }
      const images = Array.isArray(n.images)
        ? (n.images as unknown[]).filter((s): s is string => typeof s === 'string')
        : [];
      return {
        id:        String(n.id ?? crypto.randomUUID()),
        body,
        images,
        createdAt: Number(n.createdAt ?? Date.now()),
        updatedAt: Number(n.updatedAt ?? Date.now()),
      };
    });
  } catch {
    return [];
  }
}

function persist(notes: Note[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(notes));
}

export function useNotes() {
  const [notes, setNotes] = useState<Note[]>(load);

  const createNote = useCallback((): Note => {
    const note: Note = {
      id: crypto.randomUUID(),
      body: '',
      images: [],
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
      const next = prev.filter((n) => n.id !== id);
      persist(next);
      return next;
    });
  }, []);

  const addImages = useCallback((id: string, dataUrls: string[]) => {
    setNotes((prev) => {
      const next = prev.map((n) =>
        n.id === id
          ? { ...n, images: [...(n.images ?? []), ...dataUrls], updatedAt: Date.now() }
          : n
      );
      persist(next);
      return next;
    });
  }, []);

  const removeImage = useCallback((id: string, index: number) => {
    setNotes((prev) => {
      const next = prev.map((n) => {
        if (n.id !== id) return n;
        const images = [...(n.images ?? [])];
        images.splice(index, 1);
        return { ...n, images, updatedAt: Date.now() };
      });
      persist(next);
      return next;
    });
  }, []);

  const restoreNotes = useCallback((restoredNotes: Note[]) => {
    persist(restoredNotes);
    setNotes(restoredNotes);
  }, []);

  return { notes, createNote, updateNote, deleteNote, addImages, removeImage, restoreNotes };
}
