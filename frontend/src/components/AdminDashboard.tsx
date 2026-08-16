import React, { useEffect, useMemo, useState } from 'react';
import {
  Loader2, AlertCircle, FileSpreadsheet, BookOpen, Users, Layers, ArrowRight, FileCheck2,
  ChevronLeft, ChevronRight,
} from 'lucide-react';
import { User } from '../types';
import {
  fetchOrgOverview, OrgOverview, fetchExtractedReceipts, ExtractedReceiptsReport,
} from '../lib/db';
import { LEDGER_MATCHING } from '../lib/features';
import { usePolling } from '../lib/usePolling';
import { filterBySearch } from '../lib/search';
import SearchInput from './SearchInput';

const PER_PAGE = 25;
const USERS_PER_PAGE = 10;
const BATCH_SCROLL_THRESHOLD = 10;
type RangePreset = '7' | '30' | '90' | 'all' | 'custom';
type BatchReceiptSummary = {
  batchName: string;
  receipts: number;
  latestAt: string;
  latestAtMs: number;
  operators: string[];
};

function formatDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return '—';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}

function formatDelta(value: number | null, suffix = ''): string {
  if (value === null || !Number.isFinite(value)) return 'No prior period';
  return `${value > 0 ? '+' : ''}${value.toFixed(value % 1 ? 1 : 0)}${suffix}`;
}

function downloadOverviewCsv(overview: OrgOverview): void {
  const escape = (value: unknown) => `"${String(value ?? '').replace(/"/g, '""')}"`;
  const header = ['Receipt ID', 'Status', 'Uploaded At', 'Extracted At', 'Extracted By'];
  const lines = overview.receiptAnalytics.map(row => [row.id, row.status, row.uploadedAt, row.extractedAt, row.extractedBy].map(escape).join(','));
  const blob = new Blob([[header.map(escape).join(','), ...lines].join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `scan2tally-overview-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

type PageItem = number | 'start-ellipsis' | 'end-ellipsis';

/** Condenses a long page list so the control keeps a fixed width. */
function getPageItems(currentPage: number, pageCount: number): PageItem[] {
  if (pageCount <= 7) return Array.from({ length: pageCount }, (_, index) => index + 1);
  if (currentPage <= 4) return [1, 2, 3, 4, 5, 'end-ellipsis', pageCount];
  if (currentPage >= pageCount - 3) {
    return [1, 'start-ellipsis', pageCount - 4, pageCount - 3, pageCount - 2, pageCount - 1, pageCount];
  }
  return [1, 'start-ellipsis', currentPage - 1, currentPage, currentPage + 1, 'end-ellipsis', pageCount];
}

/**
 * What an Admin sees about their own organisation.
 *
 * An Admin manages a company's books; an Operator enters them. Until now both
 * saw the identical batch workspace, which left the person accountable for the
 * numbers with no way to see the shape of them — how much is waiting, what
 * failed, and which ledger names will not survive the trip into Tally.
 */
interface AdminDashboardProps {
  currentUser: User;
  onOpenWorkspace: () => void;
  onOpenLedgers: () => void;
  onOpenTeam: () => void;
}

/** Tones are named rather than hex, so the palette lives in one place. */
type Tone = 'emerald' | 'amber' | 'rose' | 'indigo';

function Tile({ label, value, tone, note }: {
  label: string; value: React.ReactNode; tone?: Tone; note?: string;
}) {
  return (
    <div className="card">
      <div className="stat-label">{label}</div>
      <div className={`stat-value${tone ? ` tone-${tone}` : ''}`}>{value}</div>
      {note && <div className="stat-note">{note}</div>}
    </div>
  );
}

export default function AdminDashboard({
  currentUser, onOpenWorkspace, onOpenLedgers, onOpenTeam,
}: AdminDashboardProps) {
  const showTechnicalOverview = currentUser.role !== 'Admin';
  const [overview, setOverview] = useState<OrgOverview | null>(null);
  const [extracted, setExtracted] = useState<ExtractedReceiptsReport | null>(null);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [userPage, setUserPage] = useState(1);
  const [rangePreset, setRangePreset] = useState<RangePreset>('30');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const batchSummaries = useMemo<BatchReceiptSummary[]>(() => {
    const batches = new Map<string, BatchReceiptSummary & { operatorSet: Set<string> }>();
    for (const record of extracted?.records || []) {
      const existing = batches.get(record.batchName);
      if (existing) {
        existing.receipts += 1;
        existing.operatorSet.add(record.operatorName);
        if (record.extractedAtMs > existing.latestAtMs) {
          existing.latestAtMs = record.extractedAtMs;
          existing.latestAt = record.extractedAt;
        }
      } else {
        batches.set(record.batchName, {
          batchName: record.batchName,
          receipts: 1,
          latestAt: record.extractedAt,
          latestAtMs: record.extractedAtMs,
          operators: [],
          operatorSet: new Set([record.operatorName]),
        });
      }
    }
    return [...batches.values()]
      .map(({ operatorSet, ...batch }) => ({
        ...batch,
        operators: [...operatorSet].sort((a, b) => a.localeCompare(b)),
      }))
      .sort((a, b) => b.latestAtMs - a.latestAtMs || a.batchName.localeCompare(b.batchName));
  }, [extracted]);

  const filtered = useMemo(() => filterBySearch(
    batchSummaries,
    search,
    batch => [
      batch.batchName,
      batch.latestAt,
      ...batch.operators,
    ],
  ), [batchSummaries, search]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PER_PAGE));
  // Derived rather than stored, so deleting or filtering down to fewer pages
  // cannot strand the reader on a page that no longer exists.
  const visiblePage = Math.min(page, pageCount);
  const pageStart = (visiblePage - 1) * PER_PAGE;
  const paginated = filtered.slice(pageStart, pageStart + PER_PAGE);

  const userCount = extracted?.byOperator.length || 0;
  const userPageCount = Math.max(1, Math.ceil(userCount / USERS_PER_PAGE));
  const visibleUserPage = Math.min(userPage, userPageCount);
  const userPageStart = (visibleUserPage - 1) * USERS_PER_PAGE;
  const paginatedUsers = extracted?.byOperator.slice(
    userPageStart,
    userPageStart + USERS_PER_PAGE,
  ) || [];

  const analytics = useMemo(() => {
    const rows = overview?.receiptAnalytics || [];
    const now = new Date();
    let end = new Date(now);
    end.setHours(23, 59, 59, 999);
    let start = new Date(now);
    if (rangePreset === 'custom' && customFrom) start = new Date(`${customFrom}T00:00:00`);
    else if (rangePreset === '7' || rangePreset === '30' || rangePreset === '90') {
      start.setDate(start.getDate() - Number(rangePreset) + 1);
      start.setHours(0, 0, 0, 0);
    } else {
      const timestamps = rows.map(row => Date.parse(row.uploadedAt || '')).filter(Number.isFinite);
      start = timestamps.length ? new Date(Math.min(...timestamps)) : new Date(now);
      start.setHours(0, 0, 0, 0);
    }
    if (rangePreset === 'custom' && customTo) end = new Date(`${customTo}T23:59:59.999`);
    if (start > end) [start, end] = [end, start];

    const duration = end.getTime() - start.getTime();
    const previousStart = new Date(start.getTime() - duration - 1);
    const previousEnd = new Date(start.getTime() - 1);
    const inWindow = (date: string | null, from: Date, to: Date) => {
      const time = Date.parse(date || '');
      return Number.isFinite(time) && time >= from.getTime() && time <= to.getTime();
    };
    const summarize = (from: Date, to: Date) => {
      const extractedRows = rows.filter(row => row.status === 'Extracted' && inWindow(row.extractedAt || row.uploadedAt, from, to));
      const failed = rows.filter(row => row.status === 'Failed' && inWindow(row.uploadedAt, from, to)).length;
      const durations = extractedRows
        .map(row => Date.parse(row.extractedAt || '') - Date.parse(row.uploadedAt || ''))
        .filter(value => Number.isFinite(value) && value >= 0)
        .map(value => value / 1000);
      const byUser = new Map<string, number>();
      extractedRows.forEach(row => byUser.set(row.extractedBy || 'Unknown', (byUser.get(row.extractedBy || 'Unknown') || 0) + 1));
      return {
        extracted: extractedRows.length,
        failed,
        total: extractedRows.length + failed,
        successRate: extractedRows.length + failed ? (extractedRows.length / (extractedRows.length + failed)) * 100 : null,
        averageSeconds: durations.length ? durations.reduce((sum, value) => sum + value, 0) / durations.length : null,
        byUser,
      };
    };
    const current = summarize(start, end);
    const previous = rangePreset === 'all' ? null : summarize(previousStart, previousEnd);
    const dayCount = Math.max(1, Math.ceil(duration / 86400000));
    const bucketCount = Math.min(dayCount, 14);
    const bucketSize = Math.max(1, Math.ceil(dayCount / bucketCount));
    const trend = Array.from({ length: bucketCount }, (_, index) => {
      const bucketStart = new Date(start.getTime() + index * bucketSize * 86400000);
      const bucketEnd = new Date(Math.min(end.getTime(), bucketStart.getTime() + bucketSize * 86400000 - 1));
      const extracted = rows.filter(row => row.status === 'Extracted' && inWindow(row.extractedAt || row.uploadedAt, bucketStart, bucketEnd)).length;
      const failed = rows.filter(row => row.status === 'Failed' && inWindow(row.uploadedAt, bucketStart, bucketEnd)).length;
      return { label: bucketStart.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }), extracted, failed };
    });
    const users = [...new Set([
      ...current.byUser.keys(),
      ...(previous ? previous.byUser.keys() : []),
    ])]
      .map(name => ({ name, current: current.byUser.get(name) || 0, previous: previous?.byUser.get(name) || 0 }))
      .sort((a, b) => b.current - a.current || a.name.localeCompare(b.name));
    return { current, previous, trend, users, start, end };
  }, [overview, rangePreset, customFrom, customTo]);

  useEffect(() => { setPage(1); }, [search]);
  useEffect(() => { setUserPage(1); }, [userCount]);

  useEffect(() => {
    let cancelled = false;
    fetchOrgOverview()
      .then(data => { if (!cancelled) setOverview(data); })
      .catch((err: any) => { if (!cancelled) setError(err?.message || 'Could not load your overview.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  // Kept off the blocking path above: the tiles are the point of this screen,
  // and a slow or failed receipt listing must not stop them rendering.
  useEffect(() => {
    let cancelled = false;
    fetchExtractedReceipts()
      .then(data => { if (!cancelled) setExtracted(data); })
      .catch(() => { /* the section simply stays absent */ });
    return () => { cancelled = true; };
  }, []);

  // Extraction, exports and uploads are performed from the workspace (often by
  // another operator), so this read-only overview should stay current without
  // requiring an Admin to reload it. Poll faster only while work is in flight.
  usePolling(async ({ signal }) => {
    const [data, receipts] = await Promise.all([
      fetchOrgOverview(),
      fetchExtractedReceipts().catch(() => null),
    ]);
    if (signal.aborted) return;
    setOverview(data);
    if (receipts) setExtracted(receipts);
  }, {
    enabled: !loading && Boolean(overview),
    intervalMs: overview && (overview.receipts.Queued || overview.receipts.Processing) ? 5000 : 30000,
    maxIntervalMs: 120000,
  });

  if (loading) {
    return (
      <div className="loading-state">
        <Loader2 size={18} className="animate-spin" /> Loading your overview...
      </div>
    );
  }

  if (error || !overview) {
    return (
      <div className="card panel-message">
        <AlertCircle size={28} className="panel-message-icon tone-rose" />
        <h3>Could not load your overview</h3>
        <p>{error}</p>
      </div>
    );
  }

  const { batches, receipts, rows, ledgersUnresolved, ledgerCount } = overview;
  const awaiting = receipts.Pending + receipts.Queued + receipts.Processing;

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h2 className="page-title">{currentUser.orgName || 'Your Organisation'}</h2>
          <p className="page-subtitle">
            Scanning activity, extraction quality and Tally exports across your company
          </p>
        </div>
        <div className="page-actions">
          {LEDGER_MATCHING && showTechnicalOverview && (
            <button className="btn btn-secondary" onClick={onOpenLedgers}>
              <BookOpen size={16} /> Chart of Accounts
            </button>
          )}
          <button className="btn btn-secondary" onClick={onOpenTeam}>
            <Users size={16} /> Team
          </button>
          <button className="btn btn-primary" onClick={onOpenWorkspace}>
            <Layers size={16} /> Open Workspace
          </button>
        </div>
      </div>

      <div className="grid-3">
        <Tile
          label="Scan Batches"
          value={batches.active}
          note={batches.archived ? `${batches.archived} archived` : 'none archived'}
        />
        <Tile
          label="Receipts Extracted"
          value={receipts.Extracted}
          note={`${rows} voucher ${rows === 1 ? 'line' : 'lines'} on record`}
        />
        <Tile
          label="Awaiting Extraction"
          value={awaiting}
          tone={awaiting ? 'amber' : undefined}
          note={awaiting ? `${awaiting} receipt${awaiting === 1 ? '' : 's'} waiting` : 'nothing waiting'}
        />
      </div>

      {LEDGER_MATCHING && showTechnicalOverview && (
        <div className="grid-auto grid-auto-sm">
          <Tile
            label="Ledgers In Use"
            value={ledgerCount}
            note={ledgerCount ? 'names checked against Tally' : 'not set up yet'}
          />
          <Tile
            label="Rows Needing a Ledger"
            value={ledgersUnresolved}
            tone={ledgersUnresolved ? 'amber' : undefined}
            note={ledgersUnresolved ? 'Tally would create new accounts for these' : 'all rows resolve'}
          />
        </div>
      )}

      <div className="card overview-analytics">
        <div className="overview-analytics-header">
          <div>
            <h3 className="section-title">Performance Analytics</h3>
            <p className="text-muted overview-analytics-caption">
              {showTechnicalOverview
                ? 'Extraction volume, quality and speed for the selected period'
                : 'Extraction volume and quality for the selected period'}
            </p>
          </div>
          <div className="overview-range-controls" aria-label="Analytics date range">
            {(['7', '30', '90', 'all'] as RangePreset[]).map(preset => (
              <button
                type="button"
                key={preset}
                className={`overview-range-button${rangePreset === preset ? ' overview-range-button-active' : ''}`}
                onClick={() => setRangePreset(preset)}
              >
                {preset === 'all' ? 'All time' : `${preset} days`}
              </button>
            ))}
            <button
              type="button"
              className={`overview-range-button${rangePreset === 'custom' ? ' overview-range-button-active' : ''}`}
              onClick={() => setRangePreset('custom')}
            >Custom</button>
          </div>
        </div>
        {rangePreset === 'custom' && (
          <div className="overview-custom-range">
            <label>From <input type="date" value={customFrom} onChange={event => setCustomFrom(event.target.value)} /></label>
            <label>To <input type="date" value={customTo} onChange={event => setCustomTo(event.target.value)} /></label>
          </div>
        )}

        <div className="grid-auto grid-auto-sm overview-metric-grid">
          <Tile label="Extracted" value={analytics.current.extracted} note={formatDelta(analytics.previous && analytics.current.extracted - analytics.previous.extracted, ' vs prior')} />
          <Tile label="Success Rate" value={analytics.current.successRate === null ? '—' : `${analytics.current.successRate.toFixed(1)}%`} tone={analytics.current.successRate !== null && analytics.current.successRate < 90 ? 'amber' : 'emerald'} note={formatDelta(analytics.previous && analytics.current.successRate !== null && analytics.previous.successRate !== null ? analytics.current.successRate - analytics.previous.successRate : null, ' pp vs prior')} />
          <Tile label="Failure Rate" value={analytics.current.total ? `${((analytics.current.failed / analytics.current.total) * 100).toFixed(1)}%` : '—'} tone={analytics.current.failed ? 'rose' : 'emerald'} note={formatDelta(analytics.previous && analytics.previous.total && analytics.current.total ? ((analytics.current.failed / analytics.current.total) - (analytics.previous.failed / analytics.previous.total)) * 100 : null, ' pp vs prior')} />
          {showTechnicalOverview && (
            <Tile label="Average Extraction Time" value={formatDuration(analytics.current.averageSeconds)} note={formatDuration(analytics.previous && analytics.current.averageSeconds !== null && analytics.previous.averageSeconds !== null ? analytics.current.averageSeconds - analytics.previous.averageSeconds : null) + ' vs prior'} />
          )}
        </div>

        <div className="overview-analytics-columns">
          <div>
            <h4 className="overview-subheading">Receipts over time</h4>
            <div className="overview-trend-chart" aria-label="Receipts extracted and failed over time">
              {analytics.trend.map(bucket => {
                const max = Math.max(1, ...analytics.trend.map(item => item.extracted + item.failed));
                return (
                  <div className="overview-trend-column" key={bucket.label} title={`${bucket.label}: ${bucket.extracted} extracted, ${bucket.failed} failed`}>
                    <div className="overview-trend-bar-area">
                      <div className="overview-trend-bar overview-trend-bar-failed" style={{ height: `${(bucket.failed / max) * 100}%` }} />
                      <div className="overview-trend-bar overview-trend-bar-extracted" style={{ height: `${(bucket.extracted / max) * 100}%` }} />
                    </div>
                    <span>{bucket.label}</span>
                  </div>
                );
              })}
            </div>
            <div className="overview-chart-legend"><span><i className="legend-dot legend-dot-extracted" />Extracted</span><span><i className="legend-dot legend-dot-failed" />Failed</span></div>
          </div>
          <div>
            <h4 className="overview-subheading">Productivity by user</h4>
            <div className="table-container overview-user-trend-table">
              <table className="custom-table">
                <thead><tr><th>User</th><th>Extracted</th><th>vs prior</th></tr></thead>
                <tbody>{analytics.users.map(user => (
                  <tr key={user.name}>
                    <td><button type="button" className="overview-drill-link" onClick={() => { setSearch(user.name); document.getElementById('extracted-receipts')?.scrollIntoView({ behavior: 'smooth' }); }}>{user.name}</button></td>
                    <td>{user.current}</td>
                    <td className="text-muted">{analytics.previous ? formatDelta(user.current - user.previous) : '—'}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          </div>
        </div>
      </div>

      {showTechnicalOverview && (
        <div className="grid-auto grid-auto-sm">
          <div className="card overview-health-card">
            <div className="overview-card-heading"><h3 className="section-title">Queue Health</h3><span className={`health-badge${overview.reviewStats.stuck ? ' health-badge-alert' : ''}`}>{overview.reviewStats.stuck ? 'Attention' : 'Healthy'}</span></div>
            <div className="overview-health-list">
              <div><span>Queued / processing</span><strong>{receipts.Queued + receipts.Processing}</strong></div>
              <div><span>Stuck over 10 minutes</span><strong className={overview.reviewStats.stuck ? 'tone-rose' : ''}>{overview.reviewStats.stuck}</strong></div>
            </div>
            <button type="button" className="btn btn-secondary overview-drill-button" onClick={() => document.getElementById('extracted-receipts')?.scrollIntoView({ behavior: 'smooth' })}>View receipt details <ArrowRight size={14} /></button>
          </div>
          <div className="card overview-health-card">
            <div className="overview-card-heading"><h3 className="section-title">Review Workload</h3><span className="health-badge">Manual checks</span></div>
            <div className="overview-health-list">
              <div><span>Receipts needing review</span><strong>{overview.reviewStats.receipts}</strong></div>
              <div><span>Verification warnings</span><strong>{overview.reviewStats.warnings}</strong></div>
              <div><span>Signatures detected</span><strong>{overview.reviewStats.signatures}</strong></div>
            </div>
          </div>
          <div className="card overview-health-card">
            <div className="overview-card-heading"><h3 className="section-title">Export Activity</h3><span className="health-badge">All time</span></div>
            <div className="overview-health-list">
              <div><span>Spreadsheets generated</span><strong>{overview.exportStats.count}</strong></div>
              <div><span>Rows exported</span><strong>{overview.exportStats.rows}</strong></div>
              <div><span>Latest export</span><strong className="overview-small-value">{overview.exportStats.latestAt ? new Date(overview.exportStats.latestAt).toLocaleDateString() : 'None'}</strong></div>
            </div>
            <button type="button" className="btn btn-secondary overview-drill-button" onClick={() => downloadOverviewCsv(overview)}>Download receipt CSV <FileSpreadsheet size={14} /></button>
          </div>
        </div>
      )}

      {showTechnicalOverview && (analytics.current.failed / Math.max(1, analytics.current.total) > 0.1 || overview.reviewStats.stuck > 0 || overview.ledgersUnresolved > 0) && (
        <div className="card overview-alerts-card">
          <h3 className="section-title"><AlertCircle size={18} className="tone-amber" /> Admin Alerts</h3>
          <div className="overview-alert-list">
            {analytics.current.failed / Math.max(1, analytics.current.total) > 0.1 && <button type="button" onClick={() => document.getElementById('extracted-receipts')?.scrollIntoView({ behavior: 'smooth' })}>Failure rate is above 10% for the selected period.</button>}
            {overview.reviewStats.stuck > 0 && <button type="button" onClick={() => document.getElementById('extracted-receipts')?.scrollIntoView({ behavior: 'smooth' })}>{overview.reviewStats.stuck} receipt{overview.reviewStats.stuck === 1 ? '' : 's'} may be stuck in the extraction queue.</button>}
            {overview.ledgersUnresolved > 0 && <button type="button" onClick={onOpenLedgers}>{overview.ledgersUnresolved} transaction rows need ledger review.</button>}
          </div>
        </div>
      )}

      {extracted && (
        <div className="card" id="extracted-receipts">
          <h3 className="section-title">
            <Users size={18} color="var(--primary)" />
            Receipts Extracted by User
          </h3>
          <div className={`table-container${userCount > USERS_PER_PAGE ? ' overview-user-table-scroll' : ''}`}>
            <table className="custom-table">
              <thead>
                <tr><th>User</th><th>Receipts Extracted</th></tr>
              </thead>
              <tbody>
                {paginatedUsers.map(person => (
                  <tr key={person.name}>
                    <td>{person.name}</td>
                    <td>{person.receipts}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {userPageCount > 1 && (
            <div className="files-pagination" aria-label="Users pagination">
              <span className="pagination-summary">
                Showing {userPageStart + 1}–{Math.min(userPageStart + USERS_PER_PAGE, userCount)} of {userCount} users
              </span>
              <div className="pagination-controls">
                <button
                  type="button"
                  className="pagination-arrow"
                  onClick={() => setUserPage(current => Math.max(1, current - 1))}
                  disabled={visibleUserPage === 1}
                  aria-label="Previous users page"
                >
                  <ChevronLeft size={15} />
                </button>
                {getPageItems(visibleUserPage, userPageCount).map(item => (
                  typeof item === 'number' ? (
                    <button
                      type="button"
                      key={item}
                      className={`pagination-page${visibleUserPage === item ? ' pagination-page-active' : ''}`}
                      onClick={() => setUserPage(item)}
                      aria-current={visibleUserPage === item ? 'page' : undefined}
                    >
                      {item}
                    </button>
                  ) : (
                    <span key={item} className="receipt-pagination-ellipsis" aria-hidden="true">…</span>
                  )
                ))}
                <button
                  type="button"
                  className="pagination-arrow"
                  onClick={() => setUserPage(current => Math.min(userPageCount, current + 1))}
                  disabled={visibleUserPage === userPageCount}
                  aria-label="Next users page"
                >
                  <ChevronRight size={15} />
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Technical accounting diagnostics stay out of the simplified Admin view. */}
      {LEDGER_MATCHING && showTechnicalOverview && !ledgerCount && (
        <div className="card notice-card">
          <div className="row row-top fill" style={{ gap: '10px', minWidth: '280px' }}>
            <AlertCircle size={18} className="alert-icon tone-amber" style={{ marginTop: '2px' }} />
            <div>
              <div className="text-strong" style={{ marginBottom: '2px' }}>
                Your chart of accounts is empty
              </div>
              <div className="text-muted" style={{ fontSize: '0.85rem' }}>
                Ledger names are exported exactly as they were handwritten. Tally creates a
                brand new account for any name it does not already have, which splits one
                account's balance across two. Adding your ledgers stops that.
              </div>
            </div>
          </div>
          <button className="btn btn-primary" onClick={onOpenLedgers}>
            Set it up <ArrowRight size={15} />
          </button>
        </div>
      )}

      {/* Batch-level extraction totals. Row-level security scopes every row here
          to this Admin's own organisation. */}
      {extracted && (
        <div className="card">
          <h3 className="section-title">
            <FileCheck2 size={18} color="var(--primary)" />
            Extracted Receipts
            <span className="text-muted" style={{ fontSize: '0.8rem', fontWeight: 500 }}>
              {extracted.total} total
            </span>
          </h3>
          {!extracted.records.length ? (
            <p className="text-muted" style={{ fontSize: '0.85rem' }}>
              No receipts have been extracted yet.
            </p>
          ) : (
            <>
              {/* Per-operator totals filter the batch summary below, so an Admin
                  can see which batches a user contributed to without reading
                  every receipt row. */}
              {extracted.byOperator.length > 1 && (
                <div className="operator-chips" aria-label="Receipts extracted per operator">
                  {extracted.byOperator.map(person => {
                    const active = search === person.name;
                    return (
                      <button
                        type="button"
                        key={person.name}
                        className={`operator-chip${active ? ' operator-chip-active' : ''}`}
                        onClick={() => setSearch(active ? '' : person.name)}
                        aria-pressed={active}
                        title={active ? 'Clear this filter' : `Show only ${person.name}'s receipts`}
                      >
                        <Users size={13} aria-hidden="true" />
                        <span>{person.name}</span>
                        <span className="operator-chip-count">{person.receipts}</span>
                      </button>
                    );
                  })}
                </div>
              )}

              <div className="receipt-table-toolbar">
                <SearchInput
                  value={search}
                  onChange={setSearch}
                  ariaLabel="Search extracted batches"
                  placeholder="Search by batch or user…"
                  className="search-input-wide"
                />
              </div>

              {!filtered.length ? (
                <p className="text-muted" style={{ fontSize: '0.85rem' }}>
                  No extracted batches match “{search}”.
                </p>
              ) : (
                <>
                  <div className={`table-container${filtered.length > BATCH_SCROLL_THRESHOLD ? ' overview-batch-table-scroll' : ''}`}>
                    <table className="custom-table">
                      <thead>
                        <tr>
                          <th style={{ width: '56px' }}>#</th>
                          <th>Batch Name</th>
                          <th>Total Receipts</th>
                        </tr>
                      </thead>
                      <tbody>
                        {paginated.map((batch, index) => (
                          <tr key={batch.batchName}>
                            <td className="text-muted">{pageStart + index + 1}</td>
                            <td style={{ fontWeight: 500 }}>{batch.batchName}</td>
                            <td>{batch.receipts}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  {pageCount > 1 && (
                    <div className="files-pagination" aria-label="Extracted batch pages">
                      <span className="pagination-summary">
                        Showing {pageStart + 1}–{Math.min(pageStart + PER_PAGE, filtered.length)} of {filtered.length} batches
                      </span>
                      <div className="pagination-controls">
                        <button
                          type="button"
                          className="pagination-arrow"
                          onClick={() => setPage(p => Math.max(1, p - 1))}
                          disabled={visiblePage === 1}
                          aria-label="Previous page"
                        >
                          <ChevronLeft size={15} />
                        </button>
                        {getPageItems(visiblePage, pageCount).map(item => (
                          typeof item === 'number' ? (
                            <button
                              type="button"
                              key={item}
                              className={`pagination-page${visiblePage === item ? ' pagination-page-active' : ''}`}
                              onClick={() => setPage(item)}
                              aria-current={visiblePage === item ? 'page' : undefined}
                            >
                              {item}
                            </button>
                          ) : (
                            <span key={item} className="receipt-pagination-ellipsis" aria-hidden="true">…</span>
                          )
                        ))}
                        <button
                          type="button"
                          className="pagination-arrow"
                          onClick={() => setPage(p => Math.min(pageCount, p + 1))}
                          disabled={visiblePage === pageCount}
                          aria-label="Next page"
                        >
                          <ChevronRight size={15} />
                        </button>
                      </div>
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
