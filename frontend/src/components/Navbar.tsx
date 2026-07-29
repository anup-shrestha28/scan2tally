import React from 'react';
import { Layers, User as UserIcon, LogOut, Building2, Sun, Moon, Users, LayoutGrid, BookOpen, PieChart } from 'lucide-react';
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
              <button className="btn btn-secondary btn-sm" onClick={onGoToWorkspace} title="Back to scan batches">
                <LayoutGrid size={15} />
                <span>Workspace</span>
              </button>
            ) : (
              <>
                {onViewOverview && (
                  <button className="btn btn-secondary btn-sm" onClick={onViewOverview}
                          title="How your organisation is doing">
                    <PieChart size={15} />
                    <span>Overview</span>
                  </button>
                )}
                {onManageLedgers && (
                  <button className="btn btn-secondary btn-sm" onClick={onManageLedgers}
                          title="The ledgers extracted names are matched against">
                    <BookOpen size={15} />
                    <span>Ledgers</span>
                  </button>
                )}
                {onManageUsers && (
                  <button className="btn btn-secondary btn-sm" onClick={onManageUsers} title="Manage team members">
                    <Users size={15} />
                    <span>Team</span>
                  </button>
                )}
              </>
            )}

            <div className="user-badge">
              <Building2 size={16} color="var(--text-muted)" />
              <span className="text-strong">{currentUser.orgName || 'Platform Owner'}</span>
            </div>

            <div className="user-badge">
              <UserIcon size={16} color="var(--text-muted)" />
              <span>{currentUser.name}</span>
              <span className={`role-tag ${getRoleClass(currentUser.role)}`}>
                {currentUser.role}
              </span>
            </div>

            <button className="btn btn-secondary btn-sm" onClick={onLogout} title="Logout">
              <LogOut size={16} />
              <span>Logout</span>
            </button>
          </div>
        )}
      </div>
    </nav>
  );
}
