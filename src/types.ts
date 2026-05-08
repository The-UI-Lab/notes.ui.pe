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
  imageCount: number;    // images on FB (from initial publish; not editable later)
  history: FbPostHistoryEntry[];
}

export interface Note {
  id: string;
  body: string;
  images: string[]; // base64 data URLs stored in localStorage
  createdAt: number;
  updatedAt: number;
  fbPost?: FbPostInfo;
}
