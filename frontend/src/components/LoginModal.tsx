import React, { useState } from 'react';
import { KeyRound, Layers, AlertCircle, Loader2, Mail, LockKeyhole, Eye, EyeOff } from 'lucide-react';
import { signIn } from '../lib/db';

interface LoginModalProps {
  /** Called after Supabase confirms the credentials; the profile is loaded by App. */
  onAuthenticated: () => void;
}

export default function LoginModal({ onAuthenticated }: LoginModalProps) {
  const [email, setEmail] = useState(() => localStorage.getItem('scan2tally-remembered-email') || '');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [rememberMe, setRememberMe] = useState(() => Boolean(localStorage.getItem('scan2tally-remembered-email')));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (rememberMe) {
        localStorage.setItem('scan2tally-remembered-email', email.trim());
      } else {
        localStorage.removeItem('scan2tally-remembered-email');
      }
      await signIn(email.trim(), password);
      onAuthenticated();
    } catch (err: any) {
      // Supabase phrases this as "Invalid login credentials", which reads like
      // a system fault rather than a typo.
      const message = String(err?.message || '');
      setError(
        /invalid login credentials/i.test(message)
          ? 'That email and password do not match an account.'
          : message || 'Could not sign in. Please try again.'
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-header">
          <div className="login-logo">
            <Layers size={28} />
          </div>
          <h2 className="login-title">Sign in to Scan2Tally</h2>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="form-group login-form-group">
            <label className="form-label">Email Address</label>
            <div className="login-input-wrap">
              <Mail size={17} />
              <input
                type="email"
                className="form-input login-input"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="username"
                placeholder="Enter your email address"
                disabled={busy}
                required
                autoFocus
              />
            </div>
          </div>

          <div className="form-group login-form-group">
            <label className="form-label">Password</label>
            <div className="login-input-wrap">
              <LockKeyhole size={17} />
              <input
                type={showPassword ? 'text' : 'password'}
                className="form-input login-input"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                placeholder="Enter your password"
                disabled={busy}
                required
              />
              <button
                type="button"
                className="login-password-toggle"
                onClick={() => setShowPassword(value => !value)}
                disabled={busy}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
                title={showPassword ? 'Hide password' : 'Show password'}
              >
                {showPassword ? <EyeOff size={17} /> : <Eye size={17} />}
              </button>
            </div>
          </div>

          <label className="remember-me">
            <input
              type="checkbox"
              checked={rememberMe}
              onChange={(e) => setRememberMe(e.target.checked)}
              disabled={busy}
            />
            <span>Remember me</span>
          </label>

          {error && (
            <div className="login-error">
              <AlertCircle size={15} style={{ flexShrink: 0, marginTop: '1px' }} />
              <span>{error}</span>
            </div>
          )}

          <button
            type="submit"
            className="btn btn-primary login-submit"
            disabled={busy}
          >
            {busy ? (
              <>
                <Loader2 size={18} className="animate-spin" />
                Signing in...
              </>
            ) : (
              <>
                <KeyRound size={18} />
                Sign In
              </>
            )}
          </button>
        </form>

      </div>
    </div>
  );
}
