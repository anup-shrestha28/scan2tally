import React, { useState, useEffect } from 'react';
import { Building2, Plus, CheckCircle2, XCircle, Loader2, AlertCircle, Database, HardDrive } from 'lucide-react';
import { CapacityConnectionState, CapacityMetric, Organization, OrgStatus, PlatformUsage } from '../types';
import SearchInput from './SearchInput';
import StatusFilter from './StatusFilter';
import { filterBySearch, normalizeSearchText } from '../lib/search';
import { usePolling } from '../lib/usePolling';
import {
  fetchOrganizationsWithStats,
  createOrganization,
  setOrganizationStatus,
  fetchPlatformStats,
} from '../lib/db';

type OrganizationStatusFilter = 'All' | OrgStatus;

interface SuperAdminDashboardProps {
  usage: PlatformUsage | null;
  connectionState: CapacityConnectionState;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1000)), units.length - 1);
  const value = bytes / (1000 ** unitIndex);
  return `${value.toLocaleString(undefined, { maximumFractionDigits: unitIndex < 2 ? 0 : 2 })} ${units[unitIndex]}`;
}

function CapacityMeter({
  label, icon, metric, warningAt, criticalAt, note,
}: {
  label: string;
  icon: React.ReactNode;
  metric: CapacityMetric;
  warningAt: number;
  criticalAt: number;
  note: string;
}) {
  const tone = metric.percent >= 100
    ? 'full'
    : metric.percent >= criticalAt
      ? 'critical'
      : metric.percent >= warningAt
        ? 'warning'
        : 'healthy';

  return (
    <div className={`capacity-meter capacity-meter-${tone}`}>
      <div className="capacity-meter-head">
        <div className="row-sm">
          {icon}
          <div>
            <div className="capacity-meter-label">{label}</div>
            <div className="capacity-meter-value">
              {formatBytes(metric.usedBytes)} <span>of {formatBytes(metric.quotaBytes)}</span>
            </div>
          </div>
        </div>
        <strong>{metric.percent.toFixed(1)}%</strong>
      </div>
      <div
        className="capacity-progress"
        role="progressbar"
        aria-label={`${label} capacity used`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.min(100, Math.round(metric.percent))}
      >
        <span style={{ width: `${Math.min(100, metric.percent)}%` }} />
      </div>
      <div className="capacity-meter-note">{note}</div>
    </div>
  );
}

function CapacityPlaceholder({
  label, icon, state, note,
}: {
  label: string;
  icon: React.ReactNode;
  state: CapacityConnectionState | 'unavailable';
  note: string;
}) {
  const value = state === 'connecting'
    ? 'Connecting…'
    : state === 'retrying'
      ? 'Reconnecting…'
      : 'Not connected';

  return (
    <div className="capacity-meter capacity-meter-neutral capacity-meter-placeholder" aria-busy={state === 'connecting'}>
      <div className="capacity-meter-head">
        <div className="row-sm">
          {icon}
          <div>
            <div className="capacity-meter-label">{label}</div>
            <div className="capacity-meter-value">{value}</div>
          </div>
        </div>
      </div>
      <div className="capacity-progress"><span /></div>
      <div className="capacity-meter-note">{note}</div>
    </div>
  );
}

export default function SuperAdminDashboard({ usage, connectionState }: SuperAdminDashboardProps) {
  const [orgs, setOrgs] = useState<Organization[]>([]);
  const [stats, setStats] = useState({ activeUsers: 0, receipts: 0, batches: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [statusFilter, setStatusFilter] = useState<OrganizationStatusFilter>('All');
  const [organizationSearch, setOrganizationSearch] = useState('');

  const [newOrgName, setNewOrgName] = useState('');
  const [showAddModal, setShowAddModal] = useState(false);
  const hasOrganizationSearch = Boolean(normalizeSearchText(organizationSearch));
  const searchMatchedOrgs = filterBySearch(orgs, organizationSearch, org => [
    org.name,
    org.created_at,
    Number.isNaN(new Date(org.created_at).getTime())
      ? org.created_at
      : new Date(org.created_at).toLocaleDateString(),
    `${org.usersCount ?? 0} ${(org.usersCount ?? 0) === 1 ? 'user' : 'users'}`,
  ]);
  const filteredOrgs = statusFilter === 'All'
    ? searchMatchedOrgs
    : searchMatchedOrgs.filter(org => org.status === statusFilter);

  const load = async () => {
    try {
      const [list, platform] = await Promise.all([
        fetchOrganizationsWithStats(),
        fetchPlatformStats(),
      ]);
      setOrgs(list);
      setStats(platform);
      setError(null);
    } catch (err: any) {
      setError(err?.message || 'Could not load organizations.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  // These totals change as every client organisation works. Refreshing only
  // the read-only counters avoids racing the organisation controls below.
  usePolling(async ({ signal }) => {
    const platform = await fetchPlatformStats();
    if (!signal.aborted) setStats(platform);
  }, {
    enabled: !loading,
    intervalMs: 30000,
    maxIntervalMs: 120000,
  });

  const handleCreateOrg = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = newOrgName.trim();
    if (!name) return;
    if (orgs.some(o => o.name.toLowerCase() === name.toLowerCase())) {
      setError(`An organization named "${name}" already exists.`);
      return;
    }

    setBusy(true);
    try {
      const created = await createOrganization(name);
      setOrgs(prev => [...prev, created]);
      setOrganizationSearch('');
      setStatusFilter('All');
      setNewOrgName('');
      setShowAddModal(false);
      setError(null);
    } catch (err: any) {
      setError(err?.message || 'Could not create the organization.');
    } finally {
      setBusy(false);
    }
  };

  const toggleOrgStatus = async (org: Organization) => {
    const next = org.status === 'Active' ? 'Inactive' : 'Active';
    const snapshot = orgs;
    setOrgs(prev => prev.map(o => (o.id === org.id ? { ...o, status: next } : o)));
    try {
      await setOrganizationStatus(org.id, next);
      setError(null);
    } catch (err: any) {
      // Roll back rather than leave the screen disagreeing with the database.
      setOrgs(snapshot);
      setError(err?.message || 'Could not update that organization.');
    }
  };

  if (loading) {
    return (
      <div className="loading-state">
        <Loader2 size={18} className="animate-spin" /> Loading organizations...
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page-header page-header-center">
        <div>
          <h2 className="page-title">Super Admin Platform Control</h2>
          <p className="page-subtitle">
            Manage client organizations, global storage, and multi-tenant security
          </p>
        </div>

        <button className="btn btn-primary" onClick={() => setShowAddModal(true)}>
          <Plus size={18} />
          Create New Client Organization
        </button>
      </div>

      {error && (
        <div className="alert alert-error">
          <AlertCircle size={16} className="alert-icon" /> {error}
        </div>
      )}

      {/* Every figure below is counted from the database. The storage tile that
          used to sit here reported a fixed "14.2 MB / 1 GB" that was never real. */}
      <div className="grid-3">
        <div className="card">
          <div className="stat-label">Total Client Organizations</div>
          <div className="stat-value">{orgs.length}</div>
        </div>

        <div className="card">
          <div className="stat-label">Active Staff Users</div>
          <div className="stat-value">{stats.activeUsers}</div>
        </div>

        <div className="card">
          <div className="stat-label">Receipts Scanned</div>
          <div className="stat-value">{stats.receipts}</div>
          <div className="stat-note">
            across {stats.batches} {stats.batches === 1 ? 'batch' : 'batches'}
          </div>
        </div>
      </div>

      <section className="card capacity-card" aria-labelledby="capacity-heading">
        <div className="capacity-card-head">
          <div>
            <h3 id="capacity-heading" className="section-title section-title-lg">
              <HardDrive size={20} color="var(--primary)" /> Supabase Capacity
            </h3>
            <p className="text-muted text-xs">
              {usage?.monitoringMode === 'storage-only' ? 'Live file storage' : 'Live project usage'}
              {' · current bytes, not billing-cycle average'}
              {usage && ` · warning at ${usage.warningThresholdPercent}% · critical at ${usage.criticalThresholdPercent}%`}
            </p>
          </div>
          <span className={`capacity-live capacity-live-${connectionState}`} aria-live="polite">
            <span className="capacity-live-dot" />
            {connectionState === 'live' && usage
              ? `Live · ${new Date(usage.checkedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`
              : connectionState === 'retrying'
                ? 'Reconnecting'
                : 'Connecting'}
          </span>
        </div>

        <div className="capacity-grid">
          {usage?.storage ? (
            <CapacityMeter
              label="File storage"
              icon={<HardDrive size={18} />}
              metric={usage.storage}
              warningAt={usage.warningThresholdPercent}
              criticalAt={usage.criticalThresholdPercent}
              note={`${usage.storage.objectCount || 0} stored ${usage.storage.objectCount === 1 ? 'file' : 'files'}`}
            />
          ) : (
            <CapacityPlaceholder
              label="File storage"
              icon={<HardDrive size={18} />}
              state={connectionState}
              note="Reading current files from Supabase Storage"
            />
          )}

          {usage?.database ? (
            <CapacityMeter
              label="Database"
              icon={<Database size={18} />}
              metric={usage.database}
              warningAt={usage.warningThresholdPercent}
              criticalAt={usage.criticalThresholdPercent}
              note="All databases, tables and indexes in this project cluster"
            />
          ) : (
            <CapacityPlaceholder
              label="Database"
              icon={<Database size={18} />}
              state={usage?.monitoringMode === 'storage-only' ? 'unavailable' : connectionState}
              note={usage?.monitoringMode === 'storage-only'
                ? 'Database tracking activates when the secure metric is deployed'
                : 'Reading current tables and indexes'}
            />
          )}
        </div>

        {usage?.storage && Object.keys(usage.storage.byBucket || {}).length > 0 && (
          <div className="capacity-breakdown" aria-label="Storage by bucket">
            {Object.entries(usage.storage.byBucket || {})
              .sort(([, first], [, second]) => second - first)
              .map(([bucket, bytes]) => (
                <span key={bucket}><strong>{bucket}</strong> {formatBytes(bytes)}</span>
              ))}
          </div>
        )}
      </section>

      {showAddModal && (
        <div className="card" style={{ borderColor: 'var(--primary)' }}>
          <h3 className="section-title section-title-lg section-title-tight">Create New Client Organization</h3>
          <form onSubmit={handleCreateOrg} className="inline-form">
            <div className="form-group fill">
              <label className="form-label">Organization / Client Company Name</label>
              <input
                type="text"
                className="form-input"
                placeholder="e.g. Everest Logistics & Distributing"
                value={newOrgName}
                onChange={(e) => setNewOrgName(e.target.value)}
                disabled={busy}
                autoFocus
                required
              />
            </div>
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? <><Loader2 size={16} className="animate-spin" /> Saving...</> : 'Save Organization'}
            </button>
            <button type="button" className="btn btn-secondary" disabled={busy}
                    onClick={() => { setShowAddModal(false); setNewOrgName(''); }}>
              Cancel
            </button>
          </form>
        </div>
      )}

      <div className="card">
        <div className="table-section-toolbar">
          <h3 className="section-title section-title-lg">
            <Building2 size={20} color="var(--primary)" />
            Subscribed Client Organizations
          </h3>
          <div className="table-toolbar-controls">
            <SearchInput
              value={organizationSearch}
              onChange={setOrganizationSearch}
              ariaLabel="Search client organizations"
              placeholder="Search organizations…"
            />
            <StatusFilter
              value={statusFilter}
              onChange={setStatusFilter}
              ariaLabel="Filter organizations by status"
              options={[
                { value: 'All', label: `All statuses (${searchMatchedOrgs.length})` },
                { value: 'Active', label: `Active (${searchMatchedOrgs.filter(org => org.status === 'Active').length})` },
                { value: 'Inactive', label: `Inactive (${searchMatchedOrgs.filter(org => org.status === 'Inactive').length})` },
              ]}
            />
          </div>
        </div>

        <div className="table-container">
          <table className="custom-table">
            <thead>
              <tr>
                <th>Organization Name</th>
                <th>Status</th>
                <th>Users</th>
                <th>Created Date</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredOrgs.length === 0 ? (
                <tr>
                  <td colSpan={5} className="table-empty">
                    {orgs.length === 0
                      ? 'No client organizations yet.'
                      : hasOrganizationSearch
                        ? `No organizations match “${organizationSearch.trim()}”${statusFilter === 'All' ? '.' : ` with ${statusFilter.toLowerCase()} status.`}`
                        : `No ${statusFilter.toLowerCase()} organizations.`}
                  </td>
                </tr>
              ) : filteredOrgs.map((org) => (
                <tr key={org.id}>
                  <td className="text-strong">{org.name}</td>
                  <td>
                    <span className={`status-pill ${org.status === 'Active' ? 'status-extracted' : 'status-failed'}`}>
                      {org.status === 'Active' ? <CheckCircle2 size={12} /> : <XCircle size={12} />}
                      {org.status}
                    </span>
                  </td>
                  <td>{org.usersCount} users</td>
                  <td>{org.created_at}</td>
                  <td>
                    <button
                      className={`btn btn-sm ${org.status === 'Active' ? 'btn-danger' : 'btn-secondary'}`}
                      onClick={() => toggleOrgStatus(org)}
                    >
                      {org.status === 'Active' ? 'Deactivate' : 'Activate'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
