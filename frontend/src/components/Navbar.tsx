import React, { useEffect, useRef, useState } from 'react';
import { Layers, User as UserIcon, LogOut, Building2, Sun, Moon, Users, LayoutGrid, BookOpen, PieChart, ChevronDown } from 'lucide-react';
import { User, UserRole } from '../types';

interface NavbarProps {
  currentUser: User | null;
  onLogout: () => void;
  isDark: boolean;
  onToggleTheme: () => void;
  /** Absent for roles that cannot manage staff, which hides the control entirely. */
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
                  <button className={`nav-link${currentView === 'users' ? ' nav-link-active' : ''}`} onClick={onManageUsers} title="Manage team members">
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
    </nav>
  );
}
