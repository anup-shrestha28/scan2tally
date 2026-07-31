import React, { useEffect, useRef, useState } from 'react';
import { Layers, User as UserIcon, LogOut, Building2, Sun, Moon, Users, LayoutGrid, BookOpen, PieChart, ChevronDown, LockKeyhole, Loader2, AlertCircle, Eye, EyeOff } from 'lucide-react';
import { User, UserRole } from '../types';
import { changeOwnPassword } from '../lib/db';

interface NavbarProps {
  currentUser: User | null;
  onLogout: () => void;
  isDark: boolean;
  onToggleTheme: () => void;
  /** Opens the role-appropriate team view (read-only for Operators). */
  onManageUsers?: () => void;
  /** Admin only: the chart of accounts every extraction is matched against. */
  onManageLedgers?: () => void;
  /** Admin only: the organisation-wide view of scanning and exports. */
  onViewOverview?: () => void;
  onGoToWorkspace?: () => void;
  currentView?: string;
}

export default function Navbar({
  currentUser, onLogout, isDark, onToggleTheme,
  onManageUsers, onManageLedgers, onViewOverview, onGoToWorkspace, currentView
}: NavbarProps) {
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const accountMenuRef = useRef<HTMLDivElement | null>(null);
  const [showPasswordChange, setShowPasswordChange] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showCurrentPassword, setShowCurrentPassword] = useState(false);
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordBusy, setPasswordBusy] = useState(false);

  const openPasswordChange = () => {
    setCurrentPassword('');
    setNewPassword('');
    setConfirmPassword('');
    setShowCurrentPassword(false);
    setShowNewPassword(false);
    setShowConfirmPassword(false);
    setPasswordError(null);
    setShowPasswordChange(true);
    setAccountMenuOpen(false);
  };

  const handlePasswordChange = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!currentUser) return;
    setPasswordError(null);
    if (!currentPassword) {
      setPasswordError('Enter your current password.');
      return;
    }
    if (newPassword.length < 8) {
      setPasswordError('New password must be at least 8 characters.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordError('New passwords do not match.');
      return;
    }
    setPasswordBusy(true);
    try {
      await changeOwnPassword(currentUser.email, currentPassword, newPassword);
      setShowPasswordChange(false);
    } catch (error: any) {
      setPasswordError(error?.message || 'Could not change your password.');
    } finally {
      setPasswordBusy(false);
    }
  };

  useEffect(() => {
    if (!accountMenuOpen) return;

    const handlePointerDown = (event: MouseEvent) => {
      if (!accountMenuRef.current?.contains(event.target as Node)) {
        setAccountMenuOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setAccountMenuOpen(false);
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [accountMenuOpen]);

  // The workspace is where the actual work happens, so every other screen keeps
  // a way straight back to it rather than relying on the browser's back button.
  const awayFromWorkspace =
    currentView === 'users' || currentView === 'ledgers' || currentView === 'overview';
  const getRoleClass = (role: UserRole) => {
    switch (role) {
      case 'Super Admin': return 'role-super';
      case 'Admin': return 'role-admin';
      case 'Operator': return 'role-operator';
      default: return '';
    }
  };

  return (
    <nav className={`navbar${currentUser ? '' : ' login-navbar'}`}>
      {currentUser && (
        <div className="brand">
          <div className="brand-icon">
            <Layers size={20} />
          </div>
          <span>Scan2Tally</span>
        </div>
      )}

      <div className="nav-right">
        {/* Theme Toggle */}
        <button
          className="theme-toggle"
          onClick={onToggleTheme}
          title={isDark ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
        >
          {isDark ? <Sun size={17} /> : <Moon size={17} />}
        </button>

        {currentUser && (
          <div className="nav-user">
            {awayFromWorkspace ? (
              <button className="nav-link" onClick={onGoToWorkspace} title="Back to scan batches">
                <LayoutGrid size={15} />
                <span>Workspace</span>
              </button>
            ) : (
              <>
                {onViewOverview && (
                  <button className={`nav-link${currentView === 'overview' ? ' nav-link-active' : ''}`} onClick={onViewOverview}
                          title="How your organisation is doing">
                    <PieChart size={15} />
                    <span>Overview</span>
                  </button>
                )}
                {onManageLedgers && (
                  <button className={`nav-link${currentView === 'ledgers' ? ' nav-link-active' : ''}`} onClick={onManageLedgers}
                          title="The ledgers extracted names are matched against">
                    <BookOpen size={15} />
                    <span>Ledgers</span>
                  </button>
                )}
                {onManageUsers && (
                  <button className={`nav-link${currentView === 'users' ? ' nav-link-active' : ''}`} onClick={onManageUsers} title="View team members">
                    <Users size={15} />
                    <span>Team</span>
                  </button>
                )}
              </>
            )}

            <div className="account-menu" ref={accountMenuRef}>
              <button
                type="button"
                className="account-trigger"
                aria-haspopup="menu"
                aria-expanded={accountMenuOpen}
                onClick={() => setAccountMenuOpen(open => !open)}
              >
                <span className="user-avatar" aria-hidden="true">
                  <UserIcon size={14} />
                </span>
                <span className="account-trigger-name">{currentUser.name}</span>
                <ChevronDown
                  size={14}
                  className={`account-chevron${accountMenuOpen ? ' account-chevron-open' : ''}`}
                />
              </button>

              {accountMenuOpen && (
                <div className="account-dropdown" role="menu">
                  <div className="account-summary">
                    <span className="user-avatar account-summary-avatar" aria-hidden="true">
                      <UserIcon size={16} />
                    </span>
                    <span className="user-identity">
                      <span className="context-user">{currentUser.name}</span>
                      <span className="context-org">
                        <Building2 size={11} />
                        {currentUser.orgName || 'Platform Owner'}
                      </span>
                    </span>
                  </div>

                  <div className="account-role-row">
                    <span>Access level</span>
                    <span className={`role-tag ${getRoleClass(currentUser.role)}`}>
                      {currentUser.role}
                    </span>
                  </div>

                  <button
                    type="button"
                    className="account-menu-item"
                    role="menuitem"
                    onClick={openPasswordChange}
                  >
                    <LockKeyhole size={15} />
                    Change password
                  </button>

                  <button
                    type="button"
                    className="account-menu-item account-logout"
                    role="menuitem"
                    onClick={() => {
                      setAccountMenuOpen(false);
                      onLogout();
                    }}
                  >
                    <LogOut size={15} />
                    Logout
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
      {showPasswordChange && currentUser && (
        <div className="modal-overlay" onClick={() => !passwordBusy && setShowPasswordChange(false)}>
          <div className="modal modal-prompt" role="dialog" aria-modal="true" aria-labelledby="navbar-change-password-title" onClick={event => event.stopPropagation()}>
            <div>
              <h3 className="modal-title" id="navbar-change-password-title">Change password</h3>
            </div>
            <form onSubmit={handlePasswordChange}>
              <div className="form-group">
                <label className="form-label">Current password</label>
                <div className="input-affix">
                  <input type={showCurrentPassword ? 'text' : 'password'} className="form-input" value={currentPassword} onChange={event => setCurrentPassword(event.target.value)} autoComplete="current-password" disabled={passwordBusy} required />
                  <button type="button" className="input-affix-btn" onClick={() => setShowCurrentPassword(value => !value)} title={showCurrentPassword ? 'Hide password' : 'Show password'}>
                    {showCurrentPassword ? <EyeOff size={15} /> : <Eye size={15} />}
                  </button>
                </div>
              </div>
              <div className="form-group">
                <label className="form-label">New password</label>
                <div className="input-affix">
                  <input type={showNewPassword ? 'text' : 'password'} className="form-input" value={newPassword} onChange={event => setNewPassword(event.target.value)} placeholder="At least 8 characters" autoComplete="new-password" minLength={8} disabled={passwordBusy} required />
                  <button type="button" className="input-affix-btn" onClick={() => setShowNewPassword(value => !value)} title={showNewPassword ? 'Hide password' : 'Show password'}>
                    {showNewPassword ? <EyeOff size={15} /> : <Eye size={15} />}
                  </button>
                </div>
              </div>
              <div className="form-group">
                <label className="form-label">Confirm new password</label>
                <div className="input-affix">
                  <input type={showConfirmPassword ? 'text' : 'password'} className="form-input" value={confirmPassword} onChange={event => setConfirmPassword(event.target.value)} autoComplete="new-password" minLength={8} disabled={passwordBusy} required />
                  <button type="button" className="input-affix-btn" onClick={() => setShowConfirmPassword(value => !value)} title={showConfirmPassword ? 'Hide password' : 'Show password'}>
                    {showConfirmPassword ? <EyeOff size={15} /> : <Eye size={15} />}
                  </button>
                </div>
              </div>
              <button
                type="button"
                className="password-help-link"
                title={currentUser.role === 'Super Admin'
                  ? 'If you don’t remember your current password, please contact Super Admin.'
                  : 'If you don’t remember your current password, please contact your administrator.'}
              >
                Forgot Password?
              </button>
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
    </nav>
  );
}
