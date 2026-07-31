import React, { useState, useEffect } from 'react';
import {
  UserPlus, Users, Loader2, Pencil, Trash2, UserRound, Mail, Phone, Briefcase, LockKeyhole,
  AlertCircle, CheckCircle2, XCircle, ArrowLeft, Eye, EyeOff
} from 'lucide-react';
import { TeamDirectoryMember, User, UserRole, UserStatus } from '../types';
import { fetchOrgUsers, fetchOperatorTeamDirectory, createUserAccount, updateUserAccount, changeUserPassword, changeOwnPassword, deleteUserAccount, setUserStatus, fetchOrganizations } from '../lib/db';
import SearchInput from './SearchInput';
import StatusFilter from './StatusFilter';
import { filterBySearch, normalizeSearchText } from '../lib/search';

interface UserManagementProps {
  currentUser: User;
  onBack?: () => void;
}

const ROLE_STYLES: Record<UserRole, string> = {
  'Super Admin': 'role-super',
  'Admin': 'role-admin',
  'Operator': 'role-operator',
};

type UserStatusFilter = 'All' | UserStatus;

const toTitleCase = (value: string) =>
  value.trim().toLocaleLowerCase().replace(/(^|[\s'-])(\p{L})/gu, (_, separator, letter) =>
    `${separator}${letter.toLocaleUpperCase()}`
  );

export default function UserManagement({ currentUser, onBack }: UserManagementProps) {
  const isSuperAdmin = currentUser.role === 'Super Admin';
  const isOperator = currentUser.role === 'Operator';

  const [users, setUsers] = useState<User[]>([]);
  const [operatorDirectory, setOperatorDirectory] = useState<TeamDirectoryMember[]>([]);
  const [orgs, setOrgs] = useState<{ id: string; name: string; status: string }[]>([]);
  const activeOrgs = orgs.filter(o => o.status === 'Active');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<UserStatusFilter>('All');
  const [userSearch, setUserSearch] = useState('');
  const hasUserSearch = Boolean(normalizeSearchText(userSearch));

  const [showForm, setShowForm] = useState(false);
  const [editingUser, setEditingUser] = useState<User | null>(null);
  const [selectedUser, setSelectedUser] = useState<User | null>(null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showPasswordChange, setShowPasswordChange] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [designation, setDesignation] = useState('');
  // A Super Admin creating staff must say which company; an Admin cannot choose.
  const [role, setRole] = useState<UserRole>('Operator');
  const [orgId, setOrgId] = useState('');

  const [busy, setBusy] = useState(false);
  const [pendingDeleteUser, setPendingDeleteUser] = useState<User | null>(null);
  const [pendingStatusUser, setPendingStatusUser] = useState<User | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = async () => {
    try {
      if (isOperator) {
        // Operators receive a purpose-built projection instead of SELECT access
        // to public.users. It contains no email, phone, status or other account
        // management data and is confined to active colleagues in their org.
        setOperatorDirectory(await fetchOperatorTeamDirectory());
        setLoadError(null);
        return;
      }

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

  useEffect(() => { load(); }, [currentUser.id, currentUser.role]);

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
  const organizationNames = new Map(orgs.map(org => [org.id, org.name]));
  const searchMatchedUsers = filterBySearch(displayedUsers, userSearch, user => [
    user.name,
    user.email,
    user.phone,
    user.designation,
    user.role,
    isSuperAdmin
      ? (organizationNames.get(user.organization_id || '') || 'Platform')
      : (currentUser.orgName || 'Your organization'),
  ]);
  const filteredUsers = statusFilter === 'All'
    ? searchMatchedUsers
    : searchMatchedUsers.filter(user => user.status === statusFilter);
  const filteredOperatorDirectory = filterBySearch(operatorDirectory, userSearch, member => [
    member.name,
    member.designation,
    member.role,
    currentUser.orgName,
  ]);

  const resetForm = () => {
    setName(''); setEmail(''); setPhone(''); setPassword(''); setDesignation('');
    setRole('Operator'); setOrgId(''); setFormError(null); setShowPassword(false);
    setEditingUser(null);
  };

  const beginEdit = (user: User) => {
    setEditingUser(user); setSelectedUser(null); setShowForm(true); setFormError(null);
    setName(user.name); setEmail(user.email); setPhone(user.phone || ''); setPassword('');
    setDesignation(user.designation || ''); setRole(user.role); setOrgId(user.organization_id || '');
  };

  const openPasswordChange = () => {
    setCurrentPassword('');
    setNewPassword('');
    setConfirmPassword('');
    setPasswordError(null);
    setShowNewPassword(false);
    setShowConfirmPassword(false);
    setShowPasswordChange(true);
  };

  const handlePasswordChange = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedUser) return;
    setPasswordError(null);
    if (newPassword.length < 8) {
      setPasswordError('Password must be at least 8 characters.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordError('Passwords do not match.');
      return;
    }

    setPasswordBusy(true);
    try {
      if (selectedUser.id === currentUser.id) {
        if (!currentPassword) {
          setPasswordError('Enter your current password.');
          setPasswordBusy(false);
          return;
        }
        await changeOwnPassword(currentUser.email, currentPassword, newPassword);
      } else {
        await changeUserPassword(selectedUser.id, newPassword);
      }
      setShowPasswordChange(false);
      setNotice(`${selectedUser.name}'s password was changed successfully.`);
      setTimeout(() => setNotice(null), 5000);
    } catch (err: any) {
      setPasswordError(err?.message || 'Could not change the password.');
    } finally {
      setPasswordBusy(false);
    }
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    setBusy(true);
    try {
      const normalizedName = toTitleCase(name);
      const normalizedDesignation = toTitleCase(designation);
      const input = {
        name: normalizedName,
        email,
        phone,
        password,
        role,
        designation: normalizedDesignation,
        // Ignored by the server for an Admin, who is always confined to their
        // own organisation regardless of what is sent.
        organizationId: isSuperAdmin ? (role === 'Super Admin' ? null : orgId) : undefined,
      };
      const saved = editingUser
        ? await updateUserAccount(editingUser.id, input)
        : await createUserAccount(input);
      setNotice(editingUser ? `${saved.name}'s details were updated.` : `${saved.name} can now sign in with ${saved.email}.`);
      if (!editingUser) {
        setUserSearch('');
        setStatusFilter('All');
      }
      setShowForm(false);
      resetForm();
      await load();
      setTimeout(() => setNotice(null), 1000);
    } catch (err: any) {
      setFormError(err?.message || 'Could not create the account.');
    } finally {
      setBusy(false);
    }
  };

  const removeUser = async (user: User) => {
    if (user.id === currentUser.id) return;
    setPendingDeleteUser(user);
  };

  const confirmRemoveUser = async () => {
    if (!pendingDeleteUser) return;
    const user = pendingDeleteUser;
    setBusy(true);
    try {
      await deleteUserAccount(user.id);
      setUsers(prev => prev.filter(u => u.id !== user.id));
      setSelectedUser(null);
      setPendingDeleteUser(null);
      setNotice(`${user.name}'s account was deleted.`);
      setTimeout(() => setNotice(null), 5000);
    } catch (err: any) {
      setPendingDeleteUser(null);
      const errorMessage = err?.message || '';
      setLoadError(
        /foreign key|scan_batches_created_by_fkey/i.test(errorMessage)
          ? 'This account has batches or other records linked to it, so it cannot be deleted. Deactivate the account instead to keep its history safe.'
          : errorMessage || 'Could not delete that user.'
      );
    } finally {
      setBusy(false);
    }
  };

  const deleteModal = pendingDeleteUser && (
    <div className="modal-overlay modal-overlay-top" onClick={() => !busy && setPendingDeleteUser(null)}>
      <div className="modal modal-confirm" role="dialog" aria-modal="true" aria-labelledby="delete-member-title" onClick={event => event.stopPropagation()}>
        <div className="modal-icon modal-icon-danger"><Trash2 size={22} /></div>
        <h3 className="modal-title" id="delete-member-title">Delete account?</h3>
        <p className="modal-text">
          Delete <strong>{pendingDeleteUser.name}</strong> permanently? Their batches, receipts,
          extracted transactions, and exports will also be permanently deleted.
          This action cannot be undone.
        </p>
        <div className="modal-actions">
          <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => setPendingDeleteUser(null)}>Cancel</button>
          <button type="button" className="btn btn-danger-solid" disabled={busy} onClick={confirmRemoveUser}>
            {busy ? <><Loader2 size={16} className="animate-spin" /> Deleting...</> : <><Trash2 size={16} /> Delete</>}
          </button>
        </div>
      </div>
    </div>
  );

  const confirmStatusChange = async () => {
    if (!pendingStatusUser) return;
    const user = pendingStatusUser;
    const next = user.status === 'Active' ? 'Inactive' : 'Active';
    const snapshot = users;
    setPendingStatusUser(null);
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

  const statusModal = pendingStatusUser && (() => {
    const deactivating = pendingStatusUser.status === 'Active';
    return (
      <div className="modal-overlay modal-overlay-top" onClick={() => !busy && setPendingStatusUser(null)}>
        <div className="modal modal-confirm" role="dialog" aria-modal="true" aria-labelledby="change-member-status-title" onClick={event => event.stopPropagation()}>
          <div className="modal-icon modal-icon-danger"><AlertCircle size={22} /></div>
          <h3 className="modal-title" id="change-member-status-title">
            {deactivating ? 'Deactivate account?' : 'Reactivate account?'}
          </h3>
          <p className="modal-text">
            {deactivating
              ? <> <strong>{pendingStatusUser.name}</strong> will no longer be able to sign in. Their account and history will be kept.</>
              : <>Allow <strong>{pendingStatusUser.name}</strong> to sign in again?</>}
          </p>
          <div className="modal-actions">
            <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => setPendingStatusUser(null)}>Cancel</button>
            <button type="button" className={deactivating ? 'btn btn-danger-solid' : 'btn btn-primary'} disabled={busy} onClick={confirmStatusChange}>
              {deactivating ? 'Deactivate' : 'Reactivate'}
            </button>
          </div>
        </div>
      </div>
    );
  })();

  if (loading) {
    return (
      <div className="loading-state">
        <Loader2 size={18} className="animate-spin" /> Loading users...
      </div>
    );
  }

  if (isOperator) {
    return (
      <div className="page page-compact">
        <div className="page-header page-header-center">
          <div className="row">
            {onBack && (
              <button className="back-link" onClick={onBack}>
                <ArrowLeft size={16} /> Back
              </button>
            )}
            <div>
              <h2 className="page-title page-title-icon">
                <Users size={22} color="var(--primary)" /> Team Members
              </h2>
              <p className="page-subtitle">
                Active colleagues in {currentUser.orgName || 'your organization'}
              </p>
            </div>
          </div>
          <div className="page-header-actions">
            <SearchInput
              value={userSearch}
              onChange={setUserSearch}
              ariaLabel="Search team directory"
              placeholder="Search team members…"
            />
          </div>
        </div>

        {loadError && (
          <div className="alert alert-error">
            <AlertCircle size={16} className="alert-icon" /> Could not load the team directory.
          </div>
        )}

        <div className="card">
          <div className="table-container">
            <table className="custom-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Designation</th>
                  <th style={{ width: '180px' }}>Role</th>
                </tr>
              </thead>
              <tbody>
                {filteredOperatorDirectory.length === 0 ? (
                  <tr>
                    <td colSpan={3} className="table-empty">
                      {loadError
                        ? 'The directory is temporarily unavailable.'
                        : operatorDirectory.length === 0
                          ? 'No active team members found.'
                          : `No team members match “${userSearch.trim()}”.`}
                    </td>
                  </tr>
                ) : filteredOperatorDirectory.map(member => (
                  <tr key={member.id}>
                    <td className="text-strong">
                      {member.name}
                      {member.id === currentUser.id && (
                        <span className="text-dim" style={{ fontWeight: 400, fontSize: '0.78rem', marginLeft: '6px' }}>
                          (you)
                        </span>
                      )}
                    </td>
                    <td className="text-muted">{member.designation || '—'}</td>
                    <td><span className={`role-tag ${ROLE_STYLES[member.role]}`}>{member.role}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    );
  }

  if (selectedUser) {
    const detailOrg = isSuperAdmin
      ? (orgs.find(o => o.id === selectedUser.organization_id)?.name || 'Platform')
      : (currentUser.orgName || 'Your organization');
    return (
      <div className="page page-compact">
        <div className="page-header page-header-center member-detail-header"><div className="row">
          <button className="back-link" onClick={() => setSelectedUser(null)}><ArrowLeft size={16} /> Team Members</button>
          <div><h2 className="page-title page-title-icon"><UserRound size={22} color="var(--primary)" /> Member details</h2>
            <p className="page-subtitle">View account information and management options</p></div>
        </div></div>
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
        <div className="card member-detail-card">
          <div className="member-detail-layout">
            <aside className="member-detail-profile">
              <div className="member-detail-avatar"><UserRound size={28} /></div>
              <div className="member-detail-identity">
                <span className="member-detail-eyebrow">Team member</span>
                <h3>{selectedUser.name}</h3>
                <div className="member-detail-badges">
                  <span className={`role-tag ${ROLE_STYLES[selectedUser.role]}`}>{selectedUser.role}</span>
                  <span className={`status-pill ${selectedUser.status === 'Active' ? 'status-extracted' : 'status-failed'}`}>
                    {selectedUser.status === 'Active' ? <CheckCircle2 size={12} /> : <XCircle size={12} />} {selectedUser.status}
                  </span>
                </div>
              </div>
            </aside>
            <div className="member-detail-content">
              <div className="member-detail-section-heading">
                <div>
                  <span className="member-detail-eyebrow">Profile</span>
                  <h4>Account information</h4>
                </div>
              </div>
              <div className="member-detail-info-grid">
                <div className="detail-item"><span className="text-dim text-xs"><Mail size={13} /> Email</span><strong>{selectedUser.email}</strong></div>
                <div className="detail-item"><span className="text-dim text-xs"><Phone size={13} /> Phone</span><strong>{selectedUser.phone || 'Not provided'}</strong></div>
                <div className="detail-item"><span className="text-dim text-xs"><Briefcase size={13} /> Designation</span><strong>{selectedUser.designation || 'Not provided'}</strong></div>
                <div className="detail-item"><span className="text-dim text-xs">Organization</span><strong>{detailOrg}</strong></div>
              </div>
              {selectedUser.id === currentUser.id ? (
                <div className="form-actions member-detail-actions">
                  <button className="btn btn-secondary" onClick={openPasswordChange}><LockKeyhole size={15} /> Change password</button>
                </div>
              ) : selectedUser.role !== 'Super Admin' && <div className="form-actions member-detail-actions">
                <button className="btn btn-primary" onClick={() => beginEdit(selectedUser)}><Pencil size={15} /> Edit member</button>
                <button className="btn btn-secondary" onClick={openPasswordChange}><LockKeyhole size={15} /> Change password</button>
                <button className="btn btn-danger" onClick={() => removeUser(selectedUser)} disabled={busy}><Trash2 size={15} /> Delete account</button>
              </div>}
            </div>
          </div>
        </div>
        {showPasswordChange && (
          <div className="modal-overlay" onClick={() => !passwordBusy && setShowPasswordChange(false)}>
            <div className="modal modal-prompt" role="dialog" aria-modal="true" aria-labelledby="change-password-title" onClick={e => e.stopPropagation()}>
              <div>
                <h3 className="modal-title" id="change-password-title">Change password</h3>
                <p className="modal-text" style={{ marginBottom: 0 }}>
                  Set a new sign-in password for <strong>{selectedUser.name}</strong>.
                </p>
              </div>
              <form onSubmit={handlePasswordChange}>
                {selectedUser.id === currentUser.id && (
                  <div className="form-group">
                    <label className="form-label">Current password</label>
                    <input type="password" className="form-input" value={currentPassword}
                      onChange={e => setCurrentPassword(e.target.value)} placeholder="Enter your current password" autoComplete="current-password" disabled={passwordBusy} required />
                  </div>
                )}
                <div className="form-group">
                  <label className="form-label">New password</label>
                  <div className="input-affix">
                    <input type={showNewPassword ? 'text' : 'password'} className="form-input" value={newPassword}
                      onChange={e => setNewPassword(e.target.value)} placeholder="At least 8 characters" autoComplete="new-password" minLength={8} disabled={passwordBusy} required />
                    <button type="button" className="input-affix-btn" onClick={() => setShowNewPassword(v => !v)} title={showNewPassword ? 'Hide password' : 'Show password'}>
                      {showNewPassword ? <EyeOff size={15} /> : <Eye size={15} />}
                    </button>
                  </div>
                </div>
                <div className="form-group">
                  <label className="form-label">Confirm new password</label>
                  <div className="input-affix">
                    <input type={showConfirmPassword ? 'text' : 'password'} className="form-input" value={confirmPassword}
                      onChange={e => setConfirmPassword(e.target.value)} placeholder="Re-enter the new password" autoComplete="new-password" minLength={8} disabled={passwordBusy} required />
                    <button type="button" className="input-affix-btn" onClick={() => setShowConfirmPassword(v => !v)} title={showConfirmPassword ? 'Hide password' : 'Show password'}>
                      {showConfirmPassword ? <EyeOff size={15} /> : <Eye size={15} />}
                    </button>
                  </div>
                </div>
                {passwordError && <div className="alert alert-error alert-top"><AlertCircle size={15} className="alert-icon" /><span>{passwordError}</span></div>}
                <div className="modal-actions" style={{ justifyContent: 'flex-end', marginTop: '18px' }}>
                  <button type="button" className="btn btn-secondary" disabled={passwordBusy} onClick={() => setShowPasswordChange(false)}>Cancel</button>
                  <button type="submit" className="btn btn-primary" disabled={passwordBusy}>
                    {passwordBusy ? <><Loader2 size={16} className="animate-spin" /> Saving...</> : <><LockKeyhole size={16} /> Save password</>}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}
        {deleteModal}
        {statusModal}
      </div>
    );
  }

  return (
    <div className="page page-compact">
      <div className="page-header page-header-center">
        <div className="row">
          {onBack && (
            <button className="back-link" onClick={onBack}>
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

        <div className="page-header-actions team-header-controls">
          <SearchInput
            value={userSearch}
            onChange={setUserSearch}
            ariaLabel="Search team members"
            placeholder="Search name, email or organization…"
          />
          <StatusFilter
            value={statusFilter}
            onChange={value => {
              setStatusFilter(value);
              if (showForm) {
                setShowForm(false);
                resetForm();
              }
            }}
            ariaLabel="Filter team members by status"
            options={[
              { value: 'All', label: `All statuses (${searchMatchedUsers.length})` },
              { value: 'Active', label: `Active (${searchMatchedUsers.filter(user => user.status === 'Active').length})` },
              { value: 'Inactive', label: `Inactive (${searchMatchedUsers.filter(user => user.status === 'Inactive').length})` },
            ]}
          />
          {!showForm && (
            <button className="btn btn-primary" onClick={() => { setShowForm(true); setFormError(null); }}>
              <UserPlus size={17} /> Add Team Member
            </button>
          )}
        </div>
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
        <div className={`card user-form-card ${editingUser ? 'user-form-edit' : ''}`}>
          <h3 className="section-title" style={{ marginBottom: '4px', fontSize: '1.05rem', fontWeight: 700 }}>
            {editingUser ? 'Edit team member' : 'Add a team member'}
          </h3>
          <p className="text-muted text-xs" style={{ marginBottom: '18px' }}>
            {editingUser
              ? 'Update this team member’s profile and access details.'
              : 'Set their login details and share the password securely. It will not be emailed.'}
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
              <div className="form-group">
                <label className="form-label">Phone <span className="text-dim">(optional)</span></label>
                <input className="form-input" value={phone} onChange={e => setPhone(e.target.value)} placeholder="98XXXXXXXX" disabled={busy} />
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

            <div className="grid-2 user-form-profile-grid">
              {!editingUser && (
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
              )}

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
                {busy ? <><Loader2 size={16} className="animate-spin" /> Saving...</> : editingUser ? <><Pencil size={16} /> Save changes</> : <><UserPlus size={16} /> Create account</>}
              </button>
              {editingUser && editingUser.id !== currentUser.id && editingUser.role !== 'Super Admin' && (
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={busy}
                  onClick={() => {
                    const member = editingUser;
                    setShowForm(false);
                    resetForm();
                    setSelectedUser(member);
                    openPasswordChange();
                  }}
                >
                  <LockKeyhole size={16} /> Change password
                </button>
              )}
              <button type="button" className="btn btn-secondary" disabled={busy}
                      onClick={() => { setShowForm(false); resetForm(); }}>
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      {!showForm && <div className="card">
        <div className="table-container">
          <table className="custom-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Organization</th>
                <th style={{ width: '150px' }}>Role</th>
                <th style={{ width: '110px' }}>Status</th>
                <th style={{ width: '310px' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredUsers.length === 0 ? (
                <tr>
                  <td colSpan={6} className="table-empty">
                    {users.length === 0
                      ? 'No team members yet.'
                      : hasUserSearch
                        ? `No team members match “${userSearch.trim()}”${statusFilter === 'All' ? '.' : ` with ${statusFilter.toLowerCase()} status.`}`
                        : `No ${statusFilter.toLowerCase()} team members.`}
                  </td>
                </tr>
              ) : filteredUsers.map(u => {
                const isSelf = u.id === currentUser.id;
                const roleClass = ROLE_STYLES[u.role];
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
                      <span className={`role-tag ${roleClass}`}>
                        {u.role}
                      </span>
                    </td>
                    <td>
                      <span className={`status-pill ${u.status === 'Active' ? 'status-extracted' : 'status-failed'}`}>
                        {u.status === 'Active' ? <CheckCircle2 size={12} /> : <XCircle size={12} />} {u.status}
                      </span>
                    </td>
                    <td>
                      <div className="table-actions">
                        <button className="btn btn-sm table-action-view" onClick={() => setSelectedUser(u)} title="View member details"><Eye size={14} /> View</button>
                        {!isSelf && u.role !== 'Super Admin' && <>
                          <button className="btn btn-sm table-action-edit table-action-icon" onClick={() => beginEdit(u)} title="Edit member" aria-label={`Edit ${u.name}`}><Pencil size={14} /></button>
                          <button className="btn btn-sm table-action-delete table-action-icon" onClick={() => removeUser(u)} title="Delete account" aria-label={`Delete ${u.name}`}><Trash2 size={14} /></button>
                          <button className={`btn btn-sm table-action-status ${u.status === 'Active' ? 'table-action-deactivate' : 'table-action-reactivate'}`} onClick={() => setPendingStatusUser(u)} title={u.status === 'Active' ? 'Block this person from signing in' : 'Allow this person to sign in again'}>
                            {u.status === 'Active' ? 'Deactivate' : 'Reactivate'}
                          </button>
                        </>}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>}
      {deleteModal}
      {statusModal}
    </div>
  );
}
