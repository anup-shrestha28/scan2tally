import React, { useState } from 'react';
import { Building2, Plus, CheckCircle2, XCircle } from 'lucide-react';
import { Organization } from '../types';

export default function SuperAdminDashboard() {
  const [orgs, setOrgs] = useState<Organization[]>([
    { id: '00000000-0000-0000-0000-000000000001', name: 'Alpha Accounts Pvt Ltd', status: 'Active', usersCount: 3, created_at: '2026-07-20' },
    { id: '00000000-0000-0000-0000-000000000002', name: 'Himalayan Trading Co.', status: 'Active', usersCount: 2, created_at: '2026-07-22' }
  ]);

  const [newOrgName, setNewOrgName] = useState('');
  const [showAddModal, setShowAddModal] = useState(false);

  const handleCreateOrg = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newOrgName.trim()) return;

    const newOrg: Organization = {
      id: `org-${Date.now()}`,
      name: newOrgName,
      status: 'Active',
      usersCount: 1,
      created_at: new Date().toISOString().split('T')[0]
    };

    setOrgs([...orgs, newOrg]);
    setNewOrgName('');
    setShowAddModal(false);
  };

  const toggleOrgStatus = (id: string) => {
    setOrgs(orgs.map(org => {
      if (org.id === id) {
        return { ...org, status: org.status === 'Active' ? 'Inactive' : 'Active' };
      }
      return org;
    }));
  };

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

      <div className="grid-3">
        <div className="card">
          <div style={{ color: 'var(--text-muted)', fontSize: '0.875rem' }}>Total Client Organizations</div>
          <div style={{ fontSize: '2rem', fontWeight: 700, marginTop: '4px' }}>{orgs.length}</div>
        </div>

        <div className="card">
          <div style={{ color: 'var(--text-muted)', fontSize: '0.875rem' }}>Active Staff Users</div>
          <div style={{ fontSize: '2rem', fontWeight: 700, marginTop: '4px', color: '#10b981' }}>5</div>
        </div>

        <div className="card">
          <div style={{ color: 'var(--text-muted)', fontSize: '0.875rem' }}>Supabase Storage Usage</div>
          <div style={{ fontSize: '2rem', fontWeight: 700, marginTop: '4px', color: '#818cf8' }}>14.2 MB / 1 GB</div>
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
                required
              />
            </div>
            <button type="submit" className="btn btn-primary">Save Organization</button>
            <button type="button" className="btn btn-secondary" onClick={() => setShowAddModal(false)}>Cancel</button>
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
              {orgs.map((org) => (
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
                      onClick={() => toggleOrgStatus(org.id)}
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
