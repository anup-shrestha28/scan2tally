import React, { useState, useEffect } from 'react';
import {
  UserPlus, Users, ShieldCheck, Building, UserCheck, Loader2,
  AlertCircle, CheckCircle2, XCircle, ArrowLeft, Eye, EyeOff
} from 'lucide-react';
import { User, UserRole } from '../types';
import { fetchOrgUsers, createUserAccount, setUserStatus, fetchOrganizations } from '../lib/db';

interface UserManagementProps {
  currentUser: User;
  onBack?: () => void;
}

const ROLE_STYLES: Record<UserRole, { cls: string; icon: React.ReactNode }> = {
  'Super Admin': { cls: 'role-super', icon: <ShieldCheck size={12} /> },
  'Admin': { cls: 'role-admin', icon: <Building size={12} /> },
  'Operator': { cls: 'role-operator', icon: <UserCheck size={12} /> },
};

export default function UserManagement({ currentUser, onBack }: UserManagementProps) {
  const isSuperAdmin = currentUser.role === 'Super Admin';

  const [users, setUsers] = useState<User[]>([]);
  const [orgs, setOrgs] = useState<{ id: string; name: string; status: string }[]>([]);
  const activeOrgs = orgs.filter(o => o.status === 'Active');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [designation, setDesignation] = useState('');
  // A Super Admin creating staff must say which company; an Admin cannot choose.
  const [role, setRole] = useState<UserRole>('Operator');
  const [orgId, setOrgId] = useState('');

  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = async () => {
    try {
      const [list, orgList] = await Promise.all([
        fetchOrgUsers(),
        isSuperAdmin ? fetchOrganizations() : Promise.resolve([]),
      ]);
      setUsers(list);
      setOrgs(orgList);
      setLoadError(null);
    } catch (err: any) {
      setLoadError(err?.message || 'Could not load users.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const resetForm = () => {
    setName(''); setEmail(''); setPassword(''); setDesignation('');
    setRole('Operator'); setOrgId(''); setFormError(null); setShowPassword(false);
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    setBusy(true);
    try {
      const created = await createUserAccount({
        name, email, password, role, designation,
        // Ignored by the server for an Admin, who is always confined to their
        // own organisation regardless of what is sent.
        organizationId: isSuperAdmin ? (role === 'Super Admin' ? null : orgId) : undefined,
      });
      setNotice(`${created.name} can now sign in with ${created.email}.`);
      setShowForm(false);
      resetForm();
      await load();
      setTimeout(() => setNotice(null), 8000);
    } catch (err: any) {
      setFormError(err?.message || 'Could not create the account.');
    } finally {
      setBusy(false);
    }
  };

  const toggleStatus = async (user: User) => {
    const next = user.status === 'Active' ? 'Inactive' : 'Active';
    const snapshot = users;
    setUsers(prev => prev.map(u => (u.id === user.id ? { ...u, status: next } : u)));
    try {
      await setUserStatus(user.id, next);
      setNotice(
        next === 'Inactive'
          ? `${user.name} can no longer sign in.`
          : `${user.name} can sign in again.`
      );
      setTimeout(() => setNotice(null), 5000);
    } catch (err: any) {
      setUsers(snapshot);
      setLoadError(err?.message || 'Could not update that user.');
    }
  };

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '10px', minHeight: '40vh', color: 'var(--text-muted)' }}>
        <Loader2 size={18} className="animate-spin" /> Loading users...
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '12px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          {onBack && (
            <button className="btn btn-secondary btn-sm" onClick={onBack}>
              <ArrowLeft size={15} /> Back
            </button>
          )}
          <div>
            <h2 style={{ fontSize: '1.5rem', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Users size={22} color="var(--primary)" /> Team Members
            </h2>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.875rem' }}>
              {isSuperAdmin
                ? 'Everyone across all client organizations'
                : `Staff in ${currentUser.orgName || 'your organization'}`}
            </p>
          </div>
        </div>

        <button className="btn btn-primary" onClick={() => { setShowForm(v => !v); setFormError(null); }}>
          <UserPlus size={17} /> {showForm ? 'Cancel' : 'Add Team Member'}
        </button>
      </div>

      {notice && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: '8px',
          background: 'rgba(16, 185, 129, 0.12)', border: '1px solid rgba(16, 185, 129, 0.35)',
          color: '#10b981', borderRadius: 'var(--radius-md)', padding: '10px 14px', fontSize: '0.85rem'
        }}>
          <CheckCircle2 size={16} /> {notice}
        </div>
      )}

      {loadError && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: '8px',
          background: 'rgba(244, 63, 94, 0.12)', border: '1px solid rgba(244, 63, 94, 0.35)',
          color: '#f43f5e', borderRadius: 'var(--radius-md)', padding: '10px 14px', fontSize: '0.85rem'
        }}>
          <AlertCircle size={16} /> {loadError}
        </div>
      )}

      {showForm && (
        <div className="card">
          <h3 style={{ fontSize: '1.05rem', fontWeight: 700, marginBottom: '4px' }}>Add a team member</h3>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.82rem', marginBottom: '18px' }}>
            They will sign in with the email and password you set here. Share the password with
            them directly — it is not emailed out.
          </p>

          <form onSubmit={handleCreate}>
            <div className="grid-2">
              <div className="form-group">
                <label className="form-label">Full name</label>
                <input className="form-input" value={name} onChange={e => setName(e.target.value)}
                       placeholder="Ram Bahadur" disabled={busy} required />
              </div>
              <div className="form-group">
                <label className="form-label">Email address</label>
                <input type="email" className="form-input" value={email} onChange={e => setEmail(e.target.value)}
                       placeholder="ram@company.com" autoComplete="off" disabled={busy} required />
              </div>
            </div>

            <div className="grid-2">
              <div className="form-group">
                <label className="form-label">Password</label>
                <div style={{ position: 'relative' }}>
                  <input
                    type={showPassword ? 'text' : 'password'}
                    className="form-input"
                    style={{ width: '100%', paddingRight: '40px' }}
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    placeholder="At least 8 characters"
                    autoComplete="new-password"
                    minLength={8}
                    disabled={busy}
                    required
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(v => !v)}
                    title={showPassword ? 'Hide password' : 'Show password'}
                    style={{
                      position: 'absolute', right: '10px', top: '50%', transform: 'translateY(-50%)',
                      background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer',
                      display: 'flex', alignItems: 'center'
                    }}
                  >
                    {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
                  </button>
                </div>
              </div>

              <div className="form-group">
                <label className="form-label">Role</label>
                <select className="form-select" value={role} disabled={busy}
                        onChange={e => setRole(e.target.value as UserRole)}>
                  <option value="Operator">Operator — uploads and reviews vouchers</option>
                  <option value="Admin">Admin — also manages team members</option>
                  {isSuperAdmin && <option value="Super Admin">Super Admin — manages every organization</option>}
                </select>
              </div>
            </div>

            <div className="grid-2">
              <div className="form-group">
                <label className="form-label">Designation <span style={{ color: 'var(--text-dim)' }}>(optional)</span></label>
                <input className="form-input" value={designation} onChange={e => setDesignation(e.target.value)}
                       placeholder="Accountant" disabled={busy} />
              </div>

              {isSuperAdmin && role !== 'Super Admin' && (
                <div className="form-group">
                  <label className="form-label">Organization</label>
                  <select className="form-select" value={orgId} disabled={busy} required
                          onChange={e => setOrgId(e.target.value)}>
                    <option value="">Choose an organization...</option>
                    {/* A deactivated organization is suspended; staff should not
                        be added to it until it's reactivated. */}
                    {activeOrgs.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
                  </select>
                  {activeOrgs.length === 0 && (
                    <p style={{ color: 'var(--text-dim)', fontSize: '0.78rem', marginTop: '6px' }}>
                      No active organizations. Reactivate one first.
                    </p>
                  )}
                </div>
              )}
            </div>

            {formError && (
              <div style={{
                display: 'flex', alignItems: 'flex-start', gap: '8px',
                background: 'rgba(244, 63, 94, 0.12)', border: '1px solid rgba(244, 63, 94, 0.35)',
                color: '#f43f5e', borderRadius: 'var(--radius-md)', padding: '10px 12px',
                fontSize: '0.82rem', marginBottom: '12px'
              }}>
                <AlertCircle size={15} style={{ flexShrink: 0, marginTop: '1px' }} />
                <span>{formError}</span>
              </div>
            )}

            <div style={{ display: 'flex', gap: '10px' }}>
              <button type="submit" className="btn btn-primary" disabled={busy}>
                {busy ? <><Loader2 size={16} className="animate-spin" /> Creating...</> : <><UserPlus size={16} /> Create account</>}
              </button>
              <button type="button" className="btn btn-secondary" disabled={busy}
                      onClick={() => { setShowForm(false); resetForm(); }}>
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      <div className="card">
        <div className="table-container">
          <table className="custom-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th style={{ width: '150px' }}>Role</th>
                <th style={{ width: '110px' }}>Status</th>
                <th style={{ width: '130px' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.length === 0 ? (
                <tr>
                  <td colSpan={5} style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '28px' }}>
                    No team members yet.
                  </td>
                </tr>
              ) : users.map(u => {
                const isSelf = u.id === currentUser.id;
                const style = ROLE_STYLES[u.role];
                return (
                  <tr key={u.id}>
                    <td style={{ fontWeight: 600 }}>
                      {u.name}
                      {isSelf && (
                        <span style={{ color: 'var(--text-dim)', fontWeight: 400, fontSize: '0.78rem', marginLeft: '6px' }}>
                          (you)
                        </span>
                      )}
                      {u.designation && (
                        <div style={{ color: 'var(--text-muted)', fontWeight: 400, fontSize: '0.75rem' }}>
                          {u.designation}
                        </div>
                      )}
                    </td>
                    <td style={{ color: 'var(--text-muted)' }}>{u.email}</td>
                    <td>
                      <span className={`role-tag ${style.cls}`} style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
                        {style.icon} {u.role}
                      </span>
                    </td>
                    <td>
                      <span className={`status-pill ${u.status === 'Active' ? 'status-extracted' : 'status-failed'}`}>
                        {u.status === 'Active' ? <CheckCircle2 size={12} /> : <XCircle size={12} />} {u.status}
                      </span>
                    </td>
                    <td>
                      {/* Locking yourself out would need another admin to undo. */}
                      {isSelf ? (
                        <span style={{ color: 'var(--text-dim)', fontSize: '0.78rem' }}>—</span>
                      ) : (
                        <button
                          className={`btn btn-sm ${u.status === 'Active' ? 'btn-danger' : 'btn-secondary'}`}
                          onClick={() => toggleStatus(u)}
                          title={u.status === 'Active' ? 'Block this person from signing in' : 'Allow this person to sign in again'}
                        >
                          {u.status === 'Active' ? 'Deactivate' : 'Reactivate'}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
