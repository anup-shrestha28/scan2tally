import React from 'react';
import { Layers, User as UserIcon, LogOut, Building2, Sun, Moon, Users, LayoutGrid } from 'lucide-react';
import { User, UserRole } from '../types';

interface NavbarProps {
  currentUser: User | null;
  onLogout: () => void;
  isDark: boolean;
  onToggleTheme: () => void;
  /** Absent for roles that cannot manage staff, which hides the control entirely. */
  onManageUsers?: () => void;
  onGoToWorkspace?: () => void;
  showingUsers?: boolean;
}

export default function Navbar({
  currentUser, onLogout, isDark, onToggleTheme,
  onManageUsers, onGoToWorkspace, showingUsers
}: NavbarProps) {
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

      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
        {/* Theme Toggle */}
        <button
          onClick={onToggleTheme}
          title={isDark ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            width: '36px', height: '36px',
            borderRadius: '50%',
            border: '1px solid var(--border-color)',
            background: 'transparent',
            backgroundColor: 'transparent',
            appearance: 'none',
            WebkitAppearance: 'none',
            padding: 0,
            cursor: 'pointer',
            color: isDark ? '#f59e0b' : '#6366f1',
            transition: 'all 0.2s ease',
            boxShadow: 'none',
          }}
          onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.transform = 'scale(1.12)'; }}
          onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.transform = 'scale(1)'; }}
        >
          {isDark ? <Sun size={17} /> : <Moon size={17} />}
        </button>

        {currentUser && (
          <div className="nav-user">
            {onManageUsers && (
              showingUsers ? (
                <button className="btn btn-secondary btn-sm" onClick={onGoToWorkspace} title="Back to scan batches">
                  <LayoutGrid size={15} />
                  <span>Workspace</span>
                </button>
              ) : (
                <button className="btn btn-secondary btn-sm" onClick={onManageUsers} title="Manage team members">
                  <Users size={15} />
                  <span>Manage Users</span>
                </button>
              )
            )}

            <div className="user-badge user-context">
              <span className="user-avatar">
                <UserIcon size={14} />
              </span>
              <div className="user-identity">
                <span className="context-user">{currentUser.name}</span>
                <span className="context-org">
                  <Building2 size={11} />
                  {currentUser.orgName || 'Platform Owner'}
                </span>
              </div>
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
