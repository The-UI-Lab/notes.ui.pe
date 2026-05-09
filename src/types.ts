export interface FbPostHistoryEntry {
  ts: number;
  body: string;
  action: 'publish' | 'update';
}

export interface FbPostInfo {
  id: string;            // Graph API post id (page_id_post_id form)
  pageId: string;        // page id at the time of publishing
  postedAt: number;      // first publish timestamp
  lastSyncedAt: number;  // last successful publish/update
  syncedBody: string;    // body that matches what's on Facebook right now
  mediaCount: number;    // media items on FB (from initial publish; not editable later)
  history: FbPostHistoryEntry[];
}

export type MediaType = 'image' | 'video';

export interface MediaRef {
  id: string;
  type: MediaType;
  mime: string;
  size: number;
  width?: number;
  height?: number;
  durationMs?: number;
}

export interface Note {
  id: string;
  body: string;
  /** References to blobs stored in IndexedDB (see utils/media.ts). */
  media: MediaRef[];
  createdAt: number;
  updatedAt: number;
  fbPost?: FbPostInfo;
}
