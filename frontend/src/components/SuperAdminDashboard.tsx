import React, { useState, useEffect } from 'react';
import { Building2, Plus, CheckCircle2, XCircle, Loader2, AlertCircle, Database, HardDrive } from 'lucide-react';
import { CapacityMetric, Organization, OrgStatus, PlatformUsage } from '../types';
import StatusFilter from './StatusFilter';
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
  usageError?: string | null;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / (1024 ** unitIndex);
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

export default function SuperAdminDashboard({ usage, usageError }: SuperAdminDashboardProps) {
  const [orgs, setOrgs] = useState<Organization[]>([]);
  const [stats, setStats] = useState({ activeUsers: 0, receipts: 0, batches: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [statusFilter, setStatusFilter] = useState<OrganizationStatusFilter>('All');

  const [newOrgName, setNewOrgName] = useState('');
  const [showAddModal, setShowAddModal] = useState(false);
  const filteredOrgs = statusFilter === 'All'
    ? orgs
    : orgs.filter(org => org.status === statusFilter);

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

      {usage?.storage && usage.database ? (
        <section className="card capacity-card" aria-labelledby="capacity-heading">
          <div className="capacity-card-head">
            <div>
              <h3 id="capacity-heading" className="section-title section-title-lg">
                <HardDrive size={20} color="var(--primary)" /> Supabase Capacity
              </h3>
              <p className="text-muted text-xs">
                Live project usage · warning at {usage.warningThresholdPercent}% · critical at {usage.criticalThresholdPercent}%
              </p>
            </div>
            <span className="capacity-checked">
              Updated {new Date(usage.checkedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </span>
          </div>

          <div className="capacity-grid">
            <CapacityMeter
              label="File storage"
              icon={<HardDrive size={18} />}
              metric={usage.storage}
              warningAt={usage.warningThresholdPercent}
              criticalAt={usage.criticalThresholdPercent}
              note={`${usage.storage.objectCount || 0} stored ${usage.storage.objectCount === 1 ? 'file' : 'files'}`}
            />
            <CapacityMeter
              label="Database"
              icon={<Database size={18} />}
              metric={usage.database}
              warningAt={usage.warningThresholdPercent}
              criticalAt={usage.criticalThresholdPercent}
              note="Tables, indexes and Supabase-managed schemas"
            />
          </div>

          {Object.keys(usage.storage.byBucket || {}).length > 0 && (
            <div className="capacity-breakdown" aria-label="Storage by bucket">
              {Object.entries(usage.storage.byBucket || {})
                .sort(([, first], [, second]) => second - first)
                .map(([bucket, bytes]) => (
                  <span key={bucket}><strong>{bucket}</strong> {formatBytes(bytes)}</span>
                ))}
            </div>
          )}
        </section>
      ) : usageError ? (
        <div className="alert alert-warning alert-top">
          <AlertCircle size={16} className="alert-icon" />
          <div className="alert-body">
            <div className="alert-title">Capacity monitoring needs setup</div>
            <div className="alert-detail">{usageError}</div>
          </div>
        </div>
      ) : null}

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
          <StatusFilter
            value={statusFilter}
            onChange={setStatusFilter}
            ariaLabel="Filter organizations by status"
            options={[
              { value: 'All', label: `All statuses (${orgs.length})` },
              { value: 'Active', label: `Active (${orgs.filter(org => org.status === 'Active').length})` },
              { value: 'Inactive', label: `Inactive (${orgs.filter(org => org.status === 'Inactive').length})` },
            ]}
          />
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
