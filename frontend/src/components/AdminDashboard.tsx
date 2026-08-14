import React, { useEffect, useMemo, useState } from 'react';
import {
  Loader2, AlertCircle, FileSpreadsheet, BookOpen, Users, Layers, ArrowRight, FileCheck2,
  ChevronLeft, ChevronRight, ChevronDown,
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
  const [overview, setOverview] = useState<OrgOverview | null>(null);
  const [extracted, setExtracted] = useState<ExtractedReceiptsReport | null>(null);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [userPage, setUserPage] = useState(1);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Matches every query token against any of the visible columns, so
  // "lily batch 11" narrows by operator and batch at once. A group also matches
  // on the names of the receipts inside it, so searching for a single page of a
  // PDF still finds the upload it belongs to.
  const filtered = useMemo(() => filterBySearch(
    extracted?.groups || [],
    search,
    group => [
      group.label,
      group.operatorName,
      group.batchName,
      group.extractedAt,
      ...group.members.map(member => member.filename),
    ],
  ), [extracted, search]);

  const filteredReceiptCount = useMemo(
    () => filtered.reduce((sum, group) => sum + group.members.length, 0),
    [filtered],
  );

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

  const { batches, receipts, rows, ledgersUnresolved, ledgerCount, exports } = overview;
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
          {LEDGER_MATCHING && (
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
          note={receipts.Queued || receipts.Processing
            ? `${receipts.Queued} queued · ${receipts.Processing} being read`
            : 'nothing in progress'}
        />
      </div>

      {/* Adapts rather than leaving holes, because the two ledger tiles are only
          here when that feature is switched on. */}
      <div className="grid-auto grid-auto-sm">
        <Tile
          label="Failed Receipts"
          value={receipts.Failed}
          tone={receipts.Failed ? 'rose' : undefined}
          note={receipts.Failed ? 'these need a retry or a better photo' : 'nothing failed'}
        />
        {LEDGER_MATCHING && (
          <>
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
          </>
        )}
      </div>

      {extracted && (
        <div className="card">
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

      {/* The single most consequential thing an Admin can be told. Everything
          above is reporting; this is the one that silently corrupts a ledger. */}
      {LEDGER_MATCHING && !ledgerCount && (
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

      <div className="card">
        <h3 className="section-title">
          <FileSpreadsheet size={18} color="var(--primary)" />
          Recent Tally Exports
        </h3>
        {!exports.length ? (
          <p className="text-muted" style={{ fontSize: '0.85rem' }}>
            No spreadsheets have been generated yet.
          </p>
        ) : (
          <div className="table-container">
            <table className="custom-table">
              <thead>
                <tr><th>File</th><th>Rows</th><th>By</th><th>When</th></tr>
              </thead>
              <tbody>
                {exports.map(record => (
                  <tr key={record.id}>
                    <td style={{ fontWeight: 500 }}>{record.file_name}</td>
                    <td>{record.record_count}</td>
                    <td className="text-muted">{record.generated_by_name || '—'}</td>
                    <td className="text-muted text-xs">{record.created_at}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Who extracted what, and where it lives. Row-level security scopes every
          row here to this Admin's own organisation. */}
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
              {/* Per-operator totals, counted in receipts rather than in the
                  collapsed upload rows above. Each one filters the table
                  instead of only reporting, so the number is a way in. */}
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
                  ariaLabel="Search extracted receipts"
                  placeholder="Search by file, operator or batch…"
                  className="search-input-wide"
                />
              </div>

              {!filtered.length ? (
                <p className="text-muted" style={{ fontSize: '0.85rem' }}>
                  No extracted receipts match “{search}”.
                </p>
              ) : (
                <>
                  <div className="table-container">
                    <table className="custom-table">
                      <thead>
                        <tr>
                          <th style={{ width: '56px' }}>#</th>
                          <th>Receipt</th>
                          <th>Extracted By</th>
                          <th>Batch</th>
                          <th>When</th>
                        </tr>
                      </thead>
                      <tbody>
                        {paginated.map((group, index) => {
                          const isGroup = group.members.length > 1;
                          const isOpen = expanded.has(group.key);
                          return (
                            <React.Fragment key={group.key}>
                              <tr>
                                {/* Numbered across the whole result set, not per
                                    page, so a row's number does not change as
                                    the reader pages through. */}
                                <td className="text-muted">{pageStart + index + 1}</td>
                                <td style={{ fontWeight: 500 }}>
                                  {isGroup ? (
                                    <button
                                      type="button"
                                      className="upload-group-toggle"
                                      onClick={() => setExpanded(previous => {
                                        const next = new Set(previous);
                                        if (next.has(group.key)) next.delete(group.key);
                                        else next.add(group.key);
                                        return next;
                                      })}
                                      aria-expanded={isOpen}
                                    >
                                      {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                                      <span>{group.label}</span>
                                      <span className="upload-group-count">
                                        {group.members.length} receipts
                                      </span>
                                    </button>
                                  ) : group.label}
                                </td>
                                <td>{group.operatorName}</td>
                                <td className="text-muted">{group.batchName}</td>
                                <td className="text-muted text-xs">{group.extractedAt}</td>
                              </tr>
                              {isGroup && isOpen && group.members.map(member => (
                                <tr key={member.id} className="upload-group-member">
                                  <td />
                                  <td className="text-muted">{member.filename}</td>
                                  <td />
                                  <td />
                                  <td className="text-muted text-xs">{member.extractedAt}</td>
                                </tr>
                              ))}
                            </React.Fragment>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>

                  {pageCount > 1 && (
                    <div className="files-pagination" aria-label="Extracted receipt pages">
                      {/* Counted in uploads, because that is what a row is
                          here; the receipt total is named separately rather
                          than left to look like the same number. */}
                      <span className="pagination-summary">
                        Showing {pageStart + 1}–{Math.min(pageStart + PER_PAGE, filtered.length)} of {filtered.length} uploads
                        {' · '}{filteredReceiptCount} {filteredReceiptCount === 1 ? 'receipt' : 'receipts'}
                        {filteredReceiptCount !== extracted.total && ` of ${extracted.total}`}
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
