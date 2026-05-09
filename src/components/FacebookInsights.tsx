import { useState, useCallback, useMemo } from 'react'
import type { Note, FbPostInsight, FbPageInsightsSummary } from '../types'
import {
  fetchPostInsights,
  fetchPageDailyMetrics,
  type FbSettings,
} from '../utils/facebook'

// ── Local cache (localStorage) ─────────────────────────────────────────────

const INSIGHTS_KEY   = 'notes-fb-insights-v1'
const PAGE_STATS_KEY = 'notes-fb-page-stats-v1'

function loadPostInsights(): Record<string, FbPostInsight> {
  try {
    return JSON.parse(localStorage.getItem(INSIGHTS_KEY) ?? '{}')
  } catch {
    return {}
  }
}

function savePostInsights(data: Record<string, FbPostInsight>): void {
  localStorage.setItem(INSIGHTS_KEY, JSON.stringify(data))
}

function loadPageSummary(): FbPageInsightsSummary | null {
  try {
    const raw = localStorage.getItem(PAGE_STATS_KEY)
    return raw ? (JSON.parse(raw) as FbPageInsightsSummary) : null
  } catch {
    return null
  }
}

function savePageSummary(data: FbPageInsightsSummary): void {
  localStorage.setItem(PAGE_STATS_KEY, JSON.stringify(data))
}

// ── Sparkline (pure SVG) ───────────────────────────────────────────────────

function Sparkline({ data, color = 'var(--accent)', height = 32, width = 160 }: {
  data: number[]
  color?: string
  height?: number
  width?: number
}) {
  if (data.length < 2) return null
  const max = Math.max(...data, 1)
  const step = width / (data.length - 1)
  const pad = 2
  const pts = data.map((v, i) => ({
    x: i * step,
    y: pad + (height - 2 * pad) * (1 - v / max),
  }))
  const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')
  const areaD = d + ` L${pts[pts.length - 1].x.toFixed(1)},${height} L0,${height} Z`

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="fb-insights-sparkline" aria-hidden="true">
      <defs>
        <linearGradient id="spark-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.18" />
          <stop offset="100%" stopColor={color} stopOpacity="0.02" />
        </linearGradient>
      </defs>
      <path d={areaD} fill="url(#spark-fill)" />
      <path d={d} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

// ── Formatting ─────────────────────────────────────────────────────────────

function fmtNum(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'K'
  return String(n)
}

function fmtAge(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return `${Math.floor(diff / 86_400_000)}d ago`
}

function extractTitle(body: string): string {
  return body.split('\n')[0].trim().slice(0, 60) || 'Untitled'
}

// ── Component ──────────────────────────────────────────────────────────────

interface Props {
  notes: Note[]
  fb: FbSettings
  onBack?: () => void
}

export function FacebookInsights({ notes, fb }: Props) {
  const [postInsights, setPostInsights] = useState<Record<string, FbPostInsight>>(loadPostInsights)
  const [pageSummary, setPageSummary]   = useState<FbPageInsightsSummary | null>(loadPageSummary)
  const [fetching, setFetching]         = useState(false)
  const [error, setError]               = useState<string | null>(null)
  const [progress, setProgress]         = useState('')

  const published = useMemo(
    () => notes
      .filter((n): n is Note & { fbPost: NonNullable<Note['fbPost']> } => Boolean(n.fbPost))
      .sort((a, b) => b.fbPost.postedAt - a.fbPost.postedAt),
    [notes],
  )

  const fetchAll = useCallback(async () => {
    setFetching(true)
    setError(null)
    setProgress('Fetching page metrics…')

    try {
      // 1) Page-level daily metrics
      const daily = await fetchPageDailyMetrics(fb)

      // 2) Per-post insights (batched sequentially to be kind to rate limits)
      const cache = { ...postInsights }
      for (let i = 0; i < published.length; i++) {
        const note = published[i]
        setProgress(`Post ${i + 1} of ${published.length}…`)
        try {
          const ins = await fetchPostInsights(fb, note.fbPost.id)
          cache[note.fbPost.id] = ins
        } catch {
          // Skip posts that can't be fetched (deleted, etc.)
        }
      }

      // 3) Build page-level summary
      let totalImpressions = 0
      let totalReach = 0
      let totalEngagement = 0
      for (const ins of Object.values(cache)) {
        totalImpressions += ins.impressions
        totalReach += ins.reach
        totalEngagement += ins.engagedUsers
      }

      const summary: FbPageInsightsSummary = {
        fetchedAt: Date.now(),
        totalPosts: published.length,
        totalImpressions,
        totalReach,
        totalEngagement,
        dailyReach: daily.dailyReach,
        dailyImpressions: daily.dailyImpressions,
      }

      setPostInsights(cache)
      setPageSummary(summary)
      savePostInsights(cache)
      savePageSummary(summary)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setFetching(false)
      setProgress('')
    }
  }, [fb, published, postInsights])

  // Sort posts by impressions (top performing first), falling back to postedAt
  const rankedPosts = useMemo(() => {
    return [...published].sort((a, b) => {
      const aIns = postInsights[a.fbPost.id]?.impressions ?? -1
      const bIns = postInsights[b.fbPost.id]?.impressions ?? -1
      return bIns - aIns
    })
  }, [published, postInsights])

  const hasData = pageSummary !== null

  return (
    <div className="fb-insights">
      {/* Refresh bar */}
      <div className="fb-insights-toolbar">
        <button
          className={`fb-insights-fetch-btn${fetching ? ' fb-insights-fetch-btn--busy' : ''}`}
          onClick={fetchAll}
          disabled={fetching || published.length === 0}
          title={published.length === 0 ? 'No posts to analyze' : 'Fetch latest insights from Facebook'}
        >
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true" className={fetching ? 'fb-insights-spin' : ''}>
            <path d="M14 8A6 6 0 1 1 8 2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
            <path d="M8 2V5L10.5 3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          {fetching ? 'Fetching…' : 'Refresh'}
        </button>
        {hasData && <span className="fb-insights-updated">Updated {fmtAge(pageSummary!.fetchedAt)}</span>}
      </div>

      {error && <div className="fb-insights-error">{error}</div>}
      {fetching && progress && <div className="fb-insights-progress">{progress}</div>}

      <div className="fb-insights-scroll">
        {!hasData && !fetching ? (
          <div className="fb-insights-empty">
            <div className="fb-insights-empty-icon" aria-hidden="true">
              <svg width="36" height="36" viewBox="0 0 36 36" fill="none">
                <rect x="4" y="14" width="6" height="18" rx="1.5" fill="currentColor" opacity="0.15"/>
                <rect x="13" y="8" width="6" height="24" rx="1.5" fill="currentColor" opacity="0.25"/>
                <rect x="22" y="4" width="6" height="28" rx="1.5" fill="currentColor" opacity="0.35"/>
              </svg>
            </div>
            <p className="fb-insights-empty-text">No insights data yet</p>
            <span className="fb-insights-empty-sub">
              Tap <strong>Refresh</strong> to pull metrics for your {published.length} {published.length === 1 ? 'post' : 'posts'} from Facebook.
            </span>
          </div>
        ) : hasData ? (
          <>
            {/* Page-level summary cards */}
            <div className="fb-insights-summary">
              <div className="fb-insights-stat">
                <span className="fb-insights-stat-value">{fmtNum(pageSummary!.totalImpressions)}</span>
                <span className="fb-insights-stat-label">Impressions</span>
              </div>
              <div className="fb-insights-stat">
                <span className="fb-insights-stat-value">{fmtNum(pageSummary!.totalReach)}</span>
                <span className="fb-insights-stat-label">Reach</span>
              </div>
              <div className="fb-insights-stat">
                <span className="fb-insights-stat-value">{fmtNum(pageSummary!.totalEngagement)}</span>
                <span className="fb-insights-stat-label">Engaged</span>
              </div>
              <div className="fb-insights-stat">
                <span className="fb-insights-stat-value">{pageSummary!.totalPosts}</span>
                <span className="fb-insights-stat-label">Posts</span>
              </div>
            </div>

            {/* Trend sparklines */}
            {(pageSummary!.dailyReach.length > 1 || pageSummary!.dailyImpressions.length > 1) && (
              <div className="fb-insights-trends">
                <h4 className="fb-insights-section-title">Trends (28 days)</h4>
                {pageSummary!.dailyImpressions.length > 1 && (
                  <div className="fb-insights-trend-row">
                    <span className="fb-insights-trend-label">Impressions</span>
                    <Sparkline data={pageSummary!.dailyImpressions.map(d => d.value)} />
                  </div>
                )}
                {pageSummary!.dailyReach.length > 1 && (
                  <div className="fb-insights-trend-row">
                    <span className="fb-insights-trend-label">Reach</span>
                    <Sparkline data={pageSummary!.dailyReach.map(d => d.value)} color="var(--text-muted)" />
                  </div>
                )}
              </div>
            )}

            {/* Per-post ranking */}
            <div className="fb-insights-posts">
              <h4 className="fb-insights-section-title">Post Performance</h4>
              {rankedPosts.map((note) => {
                const ins = postInsights[note.fbPost.id]
                return (
                  <div key={note.id} className="fb-insights-post-row">
                    <div className="fb-insights-post-info">
                      <span className="fb-insights-post-title">{extractTitle(note.fbPost.syncedBody)}</span>
                      {ins && (
                        <span className="fb-insights-post-meta">
                          {fmtNum(ins.impressions)} views · {fmtNum(ins.reach)} reach · {fmtNum(ins.engagedUsers)} engaged
                        </span>
                      )}
                    </div>
                    <div className="fb-insights-post-metrics">
                      {ins ? (
                        <div className="fb-insights-post-pills">
                          {ins.reactions > 0 && <span className="fb-insights-pill" title="Reactions">❤️ {fmtNum(ins.reactions)}</span>}
                          {ins.comments > 0 && <span className="fb-insights-pill" title="Comments">💬 {fmtNum(ins.comments)}</span>}
                          {ins.shares > 0 && <span className="fb-insights-pill" title="Shares">🔁 {fmtNum(ins.shares)}</span>}
                          {ins.clicks > 0 && <span className="fb-insights-pill" title="Clicks">👆 {fmtNum(ins.clicks)}</span>}
                          {ins.reactions === 0 && ins.comments === 0 && ins.shares === 0 && ins.clicks === 0 && (
                            <span className="fb-insights-pill fb-insights-pill--muted">No engagement yet</span>
                          )}
                        </div>
                      ) : (
                        <span className="fb-insights-post-no-data">—</span>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>

          </>
        ) : null}
      </div>
    </div>
  )
}
