import React, { useState, useEffect } from 'react';
import { Loader2 } from 'lucide-react';
import Navbar from './components/Navbar';
import LoginModal from './components/LoginModal';
import SuperAdminDashboard from './components/SuperAdminDashboard';
import UserManagement from './components/UserManagement';
import BatchWorkspace from './components/BatchWorkspace';
import SideBySideReviewer from './components/SideBySideReviewer';
import ExcelExporter from './components/ExcelExporter';
import { User, ScanBatch, Receipt, Transaction } from './types';
import { supabase } from './lib/supabase';
import { fetchCurrentUser, signOut } from './lib/db';

type AppView = 'batches' | 'reviewer' | 'exporter' | 'users';
const APP_VIEW_STORAGE_KEY = 'scan2tally-current-view';
const APP_STATE_STORAGE_KEY = 'scan2tally-current-state';

function readSavedAppState(): {
  view?: AppView;
  activeBatch?: ScanBatch | null;
  selectedReceipt?: Receipt | null;
  liveTransactions?: Transaction[];
  activeTransactions?: Transaction[];
  receiptTransactions?: Record<string, Transaction[]>;
} {
  try {
    const saved = sessionStorage.getItem(APP_STATE_STORAGE_KEY);
    return saved ? JSON.parse(saved) : {};
  } catch {
    return {};
  }
}

export default function App() {
  const savedState = readSavedAppState();
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  // Distinguishes "still checking for a saved session" from "definitely signed
  // out", so a returning user is not flashed the login form before their
  // existing session is restored.
  const [authLoading, setAuthLoading] = useState(true);
  const [authError, setAuthError] = useState<string | null>(null);

  const [currentView, setCurrentView] = useState<AppView>(() => {
    const savedView = sessionStorage.getItem(APP_VIEW_STORAGE_KEY);
    return savedView === 'reviewer' || savedView === 'exporter' || savedView === 'users'
      ? savedView
      : 'batches';
  });
  const [activeBatch, setActiveBatch] = useState<ScanBatch | null>(savedState.activeBatch || null);
  const [selectedReceipt, setSelectedReceipt] = useState<Receipt | null>(savedState.selectedReceipt || null);
  const [liveExtractedTransactions, setLiveExtractedTransactions] = useState<Transaction[]>(savedState.liveTransactions || []);
  const [activeTransactions, setActiveTransactions] = useState<Transaction[]>(savedState.activeTransactions || []);
  const [allReceiptTransactions, setAllReceiptTransactions] = useState<Record<string, Transaction[]>>(savedState.receiptTransactions || {});
  const [isDark, setIsDark] = useState<boolean>(true);

  useEffect(() => {
    document.body.classList.toggle('light', !isDark);
  }, [isDark]);

  useEffect(() => {
    sessionStorage.setItem(APP_VIEW_STORAGE_KEY, currentView);
    sessionStorage.setItem(APP_STATE_STORAGE_KEY, JSON.stringify({
      activeBatch,
      selectedReceipt,
      liveTransactions: liveExtractedTransactions,
      activeTransactions,
      receiptTransactions: allReceiptTransactions,
    }));
  }, [currentView, activeBatch, selectedReceipt, liveExtractedTransactions, activeTransactions, allReceiptTransactions]);

  const loadProfile = async () => {
    try {
      const user = await fetchCurrentUser();
      setCurrentUser(user);
      setAuthError(user ? null : authError);
    } catch (err: any) {
      // A session with no usable profile: surface why rather than bouncing the
      // user back to a login form that will keep "succeeding".
      setAuthError(err?.message || 'Could not load your account.');
      setCurrentUser(null);
    } finally {
      setAuthLoading(false);
    }
  };

  // Restore an existing session on load, and react to sign-in/sign-out
  // (including expiry, or the user signing out in another tab).
  useEffect(() => {
    let cancelled = false;

    supabase.auth.getSession().then(({ data }) => {
      if (cancelled) return;
      if (data.session) {
        loadProfile();
      } else {
        setAuthLoading(false);
      }
    });

    const { data: sub } = supabase.auth.onAuthStateChange((event) => {
      if (cancelled) return;
      if (event === 'SIGNED_OUT') {
        setCurrentUser(null);
        setActiveBatch(null);
        setSelectedReceipt(null);
        setAllReceiptTransactions({});
        setCurrentView('batches');
        sessionStorage.removeItem(APP_VIEW_STORAGE_KEY);
        sessionStorage.removeItem(APP_STATE_STORAGE_KEY);
        setAuthLoading(false);
      } else if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
        loadProfile();
      }
    });

    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
    };
  }, []);

  const handleAuthenticated = () => {
    setAuthError(null);
    setAuthLoading(true);
    setCurrentView('batches');
    loadProfile();
  };

  const handleLogout = async () => {
    await signOut();
    setCurrentUser(null);
    setAuthError(null);
  };

  const handleSelectBatch = (batch: ScanBatch, receipt?: Receipt, extractedTx?: Transaction[], txMap?: Record<string, Transaction[]>) => {
    setActiveBatch(batch);
    if (receipt) {
      setSelectedReceipt(receipt);
    } else if (batch.receipts.length) {
      setSelectedReceipt(batch.receipts[0]);
    }

    if (extractedTx) {
      setLiveExtractedTransactions(extractedTx);
    } else {
      setLiveExtractedTransactions([]);
    }

    if (txMap) {
      setAllReceiptTransactions(txMap);
    }
    
    setCurrentView('reviewer');
  };

  const handleExportExcel = (transactions: Transaction[]) => {
    setActiveTransactions(transactions);
    setCurrentView('exporter');
  };

  return (
    <div className="app-container">
      <Navbar
        currentUser={currentUser}
        onLogout={handleLogout}
        isDark={isDark}
        onToggleTheme={() => setIsDark(d => !d)}
        // Operators have no staff-management rights, so they never see the control.
        onManageUsers={
          currentUser && currentUser.role !== 'Operator'
            ? () => setCurrentView('users')
            : undefined
        }
        onGoToWorkspace={() => setCurrentView('batches')}
        showingUsers={currentView === 'users'}
      />

      <main className="main-content">
        {authLoading ? (
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            gap: '10px', minHeight: 'calc(100vh - 160px)', color: 'var(--text-muted)'
          }}>
            <Loader2 size={18} className="animate-spin" />
            Loading your account...
          </div>
        ) : !currentUser ? (
          <>
            {authError && (
              <div style={{
                maxWidth: '440px', margin: '0 auto 12px auto',
                background: 'rgba(244, 63, 94, 0.12)',
                border: '1px solid rgba(244, 63, 94, 0.35)',
                color: '#f43f5e', borderRadius: 'var(--radius-md)',
                padding: '10px 12px', fontSize: '0.82rem'
              }}>
                {authError}
              </div>
            )}
            <LoginModal onAuthenticated={handleAuthenticated} />
          </>
        ) : currentView === 'users' ? (
          <UserManagement
            currentUser={currentUser}
            onBack={() => setCurrentView('batches')}
          />
        ) : currentUser.role === 'Super Admin' ? (
          <SuperAdminDashboard />
        ) : currentView === 'batches' ? (
          <BatchWorkspace
            userRole={currentUser.role}
            currentUser={currentUser}
            onSelectBatch={handleSelectBatch}
          />
        ) : currentView === 'reviewer' ? (
          <SideBySideReviewer
            batch={activeBatch}
            currentUser={currentUser}
            selectedReceipt={selectedReceipt}
            initialTransactions={liveExtractedTransactions}
            allReceiptTransactions={allReceiptTransactions}
            onBack={() => setCurrentView('batches')}
            onExportExcel={handleExportExcel}
          />
        ) : (
          <ExcelExporter 
            transactions={activeTransactions}
            receiptNames={Object.fromEntries((activeBatch?.receipts || []).map(receipt => [receipt.id, receipt.filename]))}
            onBack={() => setCurrentView('reviewer')} 
          />
        )}
      </main>
    </div>
  );
}
