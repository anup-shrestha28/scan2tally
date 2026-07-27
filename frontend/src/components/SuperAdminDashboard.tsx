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
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        gap: '10px', minHeight: '40vh', color: 'var(--text-muted)'
      }}>
        <Loader2 size={18} className="animate-spin" /> Loading organizations...
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h2 style={{ fontSize: '1.5rem', fontWeight: 700 }}>Super Admin Platform Control</h2>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.875rem' }}>
            Manage client organizations, global storage, and multi-tenant security
          </p>
        </div>

        <button className="btn btn-primary" onClick={() => setShowAddModal(true)}>
          <Plus size={18} />
          Create New Client Organization
        </button>
      </div>

      {error && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: '8px',
          background: 'rgba(244, 63, 94, 0.12)', border: '1px solid rgba(244, 63, 94, 0.35)',
          color: '#f43f5e', borderRadius: 'var(--radius-md)', padding: '10px 14px', fontSize: '0.85rem'
        }}>
          <AlertCircle size={16} style={{ flexShrink: 0 }} /> {error}
        </div>
      )}

      {/* Every figure below is counted from the database. The storage tile that
          used to sit here reported a fixed "14.2 MB / 1 GB" that was never real. */}
      <div className="grid-3">
        <div className="card">
          <div style={{ color: 'var(--text-muted)', fontSize: '0.875rem' }}>Total Client Organizations</div>
          <div style={{ fontSize: '2rem', fontWeight: 700, marginTop: '4px' }}>{orgs.length}</div>
        </div>

        <div className="card">
          <div style={{ color: 'var(--text-muted)', fontSize: '0.875rem' }}>Active Staff Users</div>
          <div style={{ fontSize: '2rem', fontWeight: 700, marginTop: '4px', color: '#10b981' }}>
            {stats.activeUsers}
          </div>
        </div>

        <div className="card">
          <div style={{ color: 'var(--text-muted)', fontSize: '0.875rem' }}>Receipts Scanned</div>
          <div style={{ fontSize: '2rem', fontWeight: 700, marginTop: '4px', color: '#818cf8' }}>
            {stats.receipts}
          </div>
          <div style={{ color: 'var(--text-dim)', fontSize: '0.75rem', marginTop: '2px' }}>
            across {stats.batches} {stats.batches === 1 ? 'batch' : 'batches'}
          </div>
        </div>
      </div>

      {showAddModal && (
        <div className="card" style={{ borderColor: 'var(--primary)' }}>
          <h3 style={{ fontSize: '1.1rem', marginBottom: '12px' }}>Create New Client Organization</h3>
          <form onSubmit={handleCreateOrg} style={{ display: 'flex', gap: '12px', alignItems: 'flex-end' }}>
            <div className="form-group" style={{ flex: 1, marginBottom: 0 }}>
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
        <h3 style={{ fontSize: '1.1rem', marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
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
                  <td colSpan={5} style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '28px' }}>
                    No client organizations yet.
                  </td>
                </tr>
              ) : orgs.map((org) => (
                <tr key={org.id}>
                  <td style={{ fontWeight: 600 }}>{org.name}</td>
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
