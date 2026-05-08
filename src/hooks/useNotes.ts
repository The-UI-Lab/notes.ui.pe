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
      return {
        id:        String(n.id ?? crypto.randomUUID()),
        body,
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

  return { notes, createNote, updateNote, deleteNote };
}
