import React, { useState } from 'react';
import { ShieldCheck, UserCheck, KeyRound, Building, Layers } from 'lucide-react';
import { User, UserRole } from '../types';

interface LoginModalProps {
  onLogin: (user: User) => void;
}

export default function LoginModal({ onLogin }: LoginModalProps) {
  const [email, setEmail] = useState('operator@scan2tally.com');
  const [password, setPassword] = useState('password123');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onLogin({
      id: 'usr-001',
      name: 'John Accountant',
      email: email,
      role: 'Operator',
      status: 'Active',
      orgId: '00000000-0000-0000-0000-000000000001',
      orgName: 'Alpha Accounts Pvt Ltd'
    });
  };

  const handleDemoRole = (role: UserRole) => {
    if (role === 'Super Admin') {
      onLogin({
        id: 'usr-super',
        name: 'Alex Platform Owner',
        email: 'superadmin@scan2tally.com',
        role: 'Super Admin',
        status: 'Active',
        orgId: null,
        orgName: 'Global System Owner'
      });
    } else if (role === 'Admin') {
      onLogin({
        id: 'usr-admin',
        name: 'Sarah Company Admin',
        email: 'admin@alpha-accounts.com',
        role: 'Admin',
        status: 'Active',
        orgId: '00000000-0000-0000-0000-000000000001',
        orgName: 'Alpha Accounts Pvt Ltd'
      });
    } else {
      onLogin({
        id: 'usr-operator',
        name: 'David Data Entry Specialist',
        email: 'operator@alpha-accounts.com',
        role: 'Operator',
        status: 'Active',
        orgId: '00000000-0000-0000-0000-000000000001',
        orgName: 'Alpha Accounts Pvt Ltd'
      });
    }
  };

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      minHeight: 'calc(100vh - 100px)',
      padding: '20px'
    }}>
      <div className="card" style={{ width: '100%', maxWidth: '440px', padding: '32px' }}>
        <div style={{ textAlign: 'center', marginBottom: '24px' }}>
          <div style={{
            width: '48px',
            height: '48px',
            background: 'linear-gradient(135deg, #6366f1, #a855f7)',
            borderRadius: '12px',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'white',
            marginBottom: '12px'
          }}>
            <Layers size={28} />
          </div>
          <h2 style={{ fontSize: '1.5rem', fontWeight: 700 }}>Scan2Tally Login</h2>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.875rem', marginTop: '4px' }}>
            Automated Handwritten Bill to Tally Bridge
          </p>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label className="form-label">Email Address</label>
            <input 
              type="email" 
              className="form-input" 
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>

          <div className="form-group">
            <label className="form-label">Password</label>
            <input 
              type="password" 
              className="form-input" 
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>

          <button type="submit" className="btn btn-primary" style={{ width: '100%', padding: '12px', marginTop: '8px' }}>
            <KeyRound size={18} />
            Sign In to Dashboard
          </button>
        </form>

        <div style={{ margin: '24px 0 16px 0', borderTop: '1px solid var(--border-color)', position: 'relative' }}>
          <span style={{
            position: 'absolute',
            top: '-10px',
            left: '50%',
            transform: 'translateX(-50%)',
            background: 'var(--bg-card)',
            padding: '0 8px',
            fontSize: '0.75rem',
            color: 'var(--text-muted)'
          }}>
            QUICK ROLE DEMO LOGIN
          </span>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <button className="btn btn-secondary" onClick={() => handleDemoRole('Super Admin')} style={{ justifyContent: 'flex-start' }}>
            <ShieldCheck size={16} color="#a855f7" />
            <span>Login as <strong>Super Admin</strong> (Platform Owner)</span>
          </button>
          
          <button className="btn btn-secondary" onClick={() => handleDemoRole('Admin')} style={{ justifyContent: 'flex-start' }}>
            <Building size={16} color="#6366f1" />
            <span>Login as <strong>Admin</strong> (Company Manager)</span>
          </button>

          <button className="btn btn-secondary" onClick={() => handleDemoRole('Operator')} style={{ justifyContent: 'flex-start' }}>
            <UserCheck size={16} color="#10b981" />
            <span>Login as <strong>Operator</strong> (Data Entry Staff)</span>
          </button>
        </div>
      </div>
    </div>
  );
}
