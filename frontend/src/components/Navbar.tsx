import React from 'react';
import { Layers, User as UserIcon, LogOut, Building2 } from 'lucide-react';
import { User, UserRole } from '../types';

interface NavbarProps {
  currentUser: User | null;
  onLogout: () => void;
}

export default function Navbar({ currentUser, onLogout }: NavbarProps) {
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
    </nav>
  );
}
