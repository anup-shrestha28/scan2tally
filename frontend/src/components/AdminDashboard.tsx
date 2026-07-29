import React, { useEffect, useState } from 'react';
import {
  Loader2, AlertCircle, FileSpreadsheet, BookOpen, Users, Layers, ArrowRight,
} from 'lucide-react';
import { User } from '../types';
import { fetchOrgOverview, OrgOverview } from '../lib/db';
import { LEDGER_MATCHING } from '../lib/features';

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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchOrgOverview()
      .then(data => { if (!cancelled) setOverview(data); })
      .catch((err: any) => { if (!cancelled) setError(err?.message || 'Could not load your overview.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

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

  const { batches, receipts, rows, ledgersUnresolved, ledgerCount, exports, staff } = overview;
  const awaiting = receipts.Pending + receipts.Processing;

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
          note={receipts.Processing ? `${receipts.Processing} being read right now` : 'nothing in progress'}
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

      <div className="grid-auto">
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

        <div className="card">
          <h3 className="section-title">
            <Users size={18} color="var(--primary)" />
            Who Has Been Scanning
          </h3>
          {!staff.length ? (
            <p className="text-muted" style={{ fontSize: '0.85rem' }}>
              No receipts have been uploaded yet.
            </p>
          ) : (
            <div className="table-container">
              <table className="custom-table">
                <thead>
                  <tr><th>Staff Member</th><th>Receipts Uploaded</th></tr>
                </thead>
                <tbody>
                  {staff.map(person => (
                    <tr key={person.id}>
                      <td style={{ fontWeight: 500 }}>{person.name}</td>
                      <td>{person.receipts}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
