import { useState, useCallback } from 'react';
import type { Note } from '../types';

const STORAGE_KEY = 'notes-app-v1';

function load(): Note[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Note[]) : [];
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
      title: '',
      content: '',
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
    (id: string, patch: Partial<Pick<Note, 'title' | 'content'>>) => {
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
