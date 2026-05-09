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

// ── Facebook Insights ──────────────────────────────────────────────────────

/** Per-post insight metrics cached locally. */
export interface FbPostInsight {
  postId: string;
  fetchedAt: number;            // timestamp of last fetch
  impressions: number;          // post_impressions (total views)
  reach: number;                // post_impressions_unique (unique viewers)
  engagedUsers: number;         // post_engaged_users
  reactions: number;            // post_reactions_by_type_total (sum)
  comments: number;             // from post object
  shares: number;               // from post object
  clicks: number;               // post_clicks (total)
}

/** Aggregate page-level summary cached locally. */
export interface FbPageInsightsSummary {
  fetchedAt: number;
  totalPosts: number;
  totalImpressions: number;
  totalReach: number;
  totalEngagement: number;
  /** Per-day aggregates for the sparkline trend (most recent 28 days). */
  dailyReach: { date: string; value: number }[];
  dailyImpressions: { date: string; value: number }[];
}
