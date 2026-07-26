import React from 'react';
import { Layers, User as UserIcon, LogOut, Building2, Sun, Moon } from 'lucide-react';
import { User, UserRole } from '../types';

interface NavbarProps {
  currentUser: User | null;
  onLogout: () => void;
  isDark: boolean;
  onToggleTheme: () => void;
}

export default function Navbar({ currentUser, onLogout, isDark, onToggleTheme }: NavbarProps) {
  const getRoleClass = (role: UserRole) => {
    switch (role) {
      case 'Super Admin': return 'role-super';
      case 'Admin': return 'role-admin';
      case 'Operator': return 'role-operator';
      default: return '';
    }
  };

  return (
    <nav className="navbar">
      <div className="brand">
        <div className="brand-icon">
          <Layers size={20} />
        </div>
        <span>Scan2Tally</span>
      </div>

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
            background: isDark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.06)',
            cursor: 'pointer',
            color: isDark ? '#f59e0b' : '#6366f1',
            transition: 'all 0.2s ease',
            boxShadow: isDark ? '0 0 8px rgba(245,158,11,0.3)' : '0 0 8px rgba(99,102,241,0.25)',
          }}
          onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.transform = 'scale(1.12)'; }}
          onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.transform = 'scale(1)'; }}
        >
          {isDark ? <Sun size={17} /> : <Moon size={17} />}
        </button>

        {currentUser && (
          <div className="nav-user">
            <div className="user-badge">
              <Building2 size={16} color="#94a3b8" />
              <span style={{ fontWeight: 600 }}>{currentUser.orgName || 'Platform Owner'}</span>
            </div>

            <div className="user-badge">
              <UserIcon size={16} color="#94a3b8" />
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
