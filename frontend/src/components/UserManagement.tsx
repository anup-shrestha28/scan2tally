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

const toTitleCase = (value: string) =>
  value.trim().toLocaleLowerCase().replace(/(^|[\s'-])(\p{L})/gu, (_, separator, letter) =>
    `${separator}${letter.toLocaleUpperCase()}`
  );

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

  const displayedUsers = isSuperAdmin
    ? [...users].sort((a, b) => {
        const getSortRank = (user: User) => {
          if (user.role === 'Super Admin') return 0;
          const roleRank = user.role === 'Admin' ? 0 : 1;
          return user.status === 'Active' ? 1 + roleRank : 3 + roleRank;
        };
        return getSortRank(a) - getSortRank(b) || a.name.localeCompare(b.name);
      })
    : users;

  const resetForm = () => {
    setName(''); setEmail(''); setPassword(''); setDesignation('');
    setRole('Operator'); setOrgId(''); setFormError(null); setShowPassword(false);
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    setBusy(true);
    try {
      const normalizedName = toTitleCase(name);
      const normalizedDesignation = toTitleCase(designation);
      const created = await createUserAccount({
        name: normalizedName,
        email,
        password,
        role,
        designation: normalizedDesignation,
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
      <div className="loading-state">
        <Loader2 size={18} className="animate-spin" /> Loading users...
      </div>
    );
  }

  return (
    <div className="page page-compact">
      <div className="page-header page-header-center">
        <div className="row">
          {onBack && (
            <button className="btn btn-secondary" onClick={onBack}>
              <ArrowLeft size={16} /> Back
            </button>
          )}
          <div>
            <h2 className="page-title page-title-icon">
              <Users size={22} color="var(--primary)" /> Team Members
            </h2>
            <p className="page-subtitle">
              {isSuperAdmin
                ? 'Everyone across all client organizations'
                : `Staff in ${currentUser.orgName || 'your organization'}`}
            </p>
          </div>
        </div>

        {!showForm && (
          <button className="btn btn-primary" onClick={() => { setShowForm(true); setFormError(null); }}>
            <UserPlus size={17} /> Add Team Member
          </button>
        )}
      </div>

      {notice && (
        <div className="alert alert-success">
          <CheckCircle2 size={16} className="alert-icon" /> {notice}
        </div>
      )}

      {loadError && (
        <div className="alert alert-error">
          <AlertCircle size={16} className="alert-icon" /> {loadError}
        </div>
      )}

      {showForm && (
        <div className="card">
          <h3 className="section-title" style={{ marginBottom: '4px', fontSize: '1.05rem', fontWeight: 700 }}>
            Add a team member
          </h3>
          <p className="text-muted text-xs" style={{ marginBottom: '18px' }}>
            Set their login details and share the password securely. It will not be emailed.
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
                <div className="input-affix">
                  <input
                    type={showPassword ? 'text' : 'password'}
                    className="form-input"
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
                    className="input-affix-btn"
                    onClick={() => setShowPassword(v => !v)}
                    title={showPassword ? 'Hide password' : 'Show password'}
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
                </select>
              </div>
            </div>

            <div className="grid-2">
              <div className="form-group">
                <label className="form-label">Designation <span className="text-dim">(optional)</span></label>
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
                    <p className="form-hint">No active organizations. Reactivate one first.</p>
                  )}
                </div>
              )}
            </div>

            {formError && (
              <div className="alert alert-error alert-top" style={{ marginBottom: '12px' }}>
                <AlertCircle size={15} className="alert-icon" />
                <span>{formError}</span>
              </div>
            )}

            <div className="form-actions">
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
                <th>Organization</th>
                <th style={{ width: '150px' }}>Role</th>
                <th style={{ width: '110px' }}>Status</th>
                <th style={{ width: '130px' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.length === 0 ? (
                <tr>
                  <td colSpan={6} className="table-empty">
                    No team members yet.
                  </td>
                </tr>
              ) : displayedUsers.map(u => {
                const isSelf = u.id === currentUser.id;
                const style = ROLE_STYLES[u.role];
                return (
                  <tr key={u.id}>
                    <td className="text-strong">
                      {u.name}
                      {isSelf && (
                        <span className="text-dim" style={{ fontWeight: 400, fontSize: '0.78rem', marginLeft: '6px' }}>
                          (you)
                        </span>
                      )}
                      {u.designation && (
                        <div className="text-muted text-2xs" style={{ fontWeight: 400 }}>
                          {u.designation}
                        </div>
                      )}
                    </td>
                    <td className="text-muted">{u.email}</td>
                    <td>
                      {isSuperAdmin
                        ? (orgs.find(o => o.id === u.organization_id)?.name || 'Platform')
                        : (currentUser.orgName || 'Your organization')}
                    </td>
                    <td>
                      <span className={`role-tag role-tag-icon ${style.cls}`}>
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
                        <span className="text-dim" style={{ fontSize: '0.78rem' }}>—</span>
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
