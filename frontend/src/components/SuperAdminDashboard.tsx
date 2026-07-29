import React, { useState, useEffect } from 'react';
import { Building2, Plus, CheckCircle2, XCircle, Loader2, AlertCircle } from 'lucide-react';
import { Organization } from '../types';
import {
  fetchOrganizationsWithStats,
  createOrganization,
  setOrganizationStatus,
  fetchPlatformStats,
} from '../lib/db';

export default function SuperAdminDashboard() {
  const [orgs, setOrgs] = useState<Organization[]>([]);
  const [stats, setStats] = useState({ activeUsers: 0, receipts: 0, batches: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [newOrgName, setNewOrgName] = useState('');
  const [showAddModal, setShowAddModal] = useState(false);

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
        <h3 className="section-title section-title-lg">
          <Building2 size={20} color="var(--primary)" />
          Subscribed Client Organizations
        </h3>

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
              {orgs.length === 0 ? (
                <tr>
                  <td colSpan={5} className="table-empty">
                    No client organizations yet.
                  </td>
                </tr>
              ) : orgs.map((org) => (
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
