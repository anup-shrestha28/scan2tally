import React, { useState, useEffect } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import Navbar from './components/Navbar';
import LoginModal from './components/LoginModal';
import SuperAdminDashboard from './components/SuperAdminDashboard';
import AdminDashboard from './components/AdminDashboard';
import LedgerManager from './components/LedgerManager';
import UserManagement from './components/UserManagement';
import BatchWorkspace from './components/BatchWorkspace';
import SideBySideReviewer from './components/SideBySideReviewer';
import ExcelExporter from './components/ExcelExporter';
import {
  User, ScanBatch, Receipt, Transaction, PlatformUsage, CapacityConnectionState,
  CapacityAlert,
} from './types';
import { supabase } from './lib/supabase';
import {
  fetchCapacityAlerts, fetchCurrentUser, fetchPlatformUsage, parseCapacityAlertRow, signOut,
} from './lib/db';
import { LEDGER_MATCHING } from './lib/features';
import { usePolling } from './lib/usePolling';

type AppView = 'batches' | 'reviewer' | 'exporter' | 'users' | 'overview' | 'ledgers';
const APP_VIEW_STORAGE_KEY = 'scan2tally-current-view';
const APP_STATE_STORAGE_KEY = 'scan2tally-current-state';
const CAPACITY_SEVERITY: Record<CapacityAlert['level'], number> = {
  healthy: 0,
  warning: 1,
  critical: 2,
  full: 3,
};

/**
 * Realtime and the reconnect snapshot can arrive in either order. A resource's
 * revision is assigned in Postgres, so an older bootstrap response can never
 * replace a newer WebSocket event.
 */
function mergeCapacityAlerts(current: CapacityAlert[], incoming: CapacityAlert[]): CapacityAlert[] {
  const byResource = new Map(current.map(alert => [alert.resource, alert]));
  for (const alert of incoming) {
    const existing = byResource.get(alert.resource);
    if (!existing || alert.revision > existing.revision) {
      byResource.set(alert.resource, alert);
    }
  }
  return Array.from(byResource.values()).sort((left, right) => {
    const severityDifference = CAPACITY_SEVERITY[right.level] - CAPACITY_SEVERITY[left.level];
    if (severityDifference !== 0) return severityDifference;
    return left.resource.localeCompare(right.resource);
  });
}

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
  const [platformUsage, setPlatformUsage] = useState<PlatformUsage | null>(null);
  const [capacityConnection, setCapacityConnection] = useState<CapacityConnectionState>('connecting');
  const [capacityAlerts, setCapacityAlerts] = useState<CapacityAlert[]>([]);

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

  const refreshPlatformUsage = async (signal: AbortSignal) => {
    try {
      const usage = await fetchPlatformUsage();
      if (signal.aborted) return;
      setPlatformUsage(usage);
      setCapacityConnection('live');
    } catch (err) {
      if (signal.aborted) return;
      setCapacityConnection('retrying');
      throw err;
    }
  };

  // Exact metrics are operational Super Admin data. Admins and Operators never
  // call this endpoint; their sanitized warnings arrive through Realtime below.
  useEffect(() => {
    if (currentUser?.role !== 'Super Admin') {
      setPlatformUsage(null);
      setCapacityConnection('connecting');
      return;
    }

    setPlatformUsage(null);
    setCapacityConnection('connecting');
    const controller = new AbortController();
    refreshPlatformUsage(controller.signal).catch(() => {
      // Monitoring is supplemental. Polling retries in the background, while a
      // deployment/configuration problem stays out of the user-facing dashboard.
    });
    return () => controller.abort();
  }, [currentUser?.id, currentUser?.role]);

  // A 30-second snapshot is near-real-time for an aggregate capacity metric.
  // The polling hook prevents overlap and backs off while Supabase is unavailable.
  usePolling(async ({ signal }) => refreshPlatformUsage(signal), {
    enabled: currentUser?.role === 'Super Admin',
    intervalMs: 30000,
    maxIntervalMs: 120000,
    resetKey: currentUser?.id || '',
  });

  // Admins and Operators receive capacity transitions over Supabase Realtime.
  // Subscribe first, then read the persisted snapshot: this closes the gap for
  // alerts raised before sign-in and re-hydrates after every reconnect.
  useEffect(() => {
    if (!currentUser || currentUser.role === 'Super Admin') {
      setCapacityAlerts([]);
      return;
    }

    let cancelled = false;
    setCapacityAlerts([]);

    const hydrate = async () => {
      try {
        const alerts = await fetchCapacityAlerts();
        if (!cancelled) {
          setCapacityAlerts(current => mergeCapacityAlerts(current, alerts));
        }
      } catch {
        // Realtime is supplemental to the rest of the workspace. The channel
        // will retry and hydrate again when it reconnects, without displaying a
        // technical database/setup error to staff.
      }
    };

    const channel = supabase
      .channel(`platform-capacity-alerts-${currentUser.id}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'platform_capacity_alerts' },
        payload => {
          const alert = parseCapacityAlertRow(payload.new);
          if (!cancelled && alert) {
            setCapacityAlerts(current => mergeCapacityAlerts(current, [alert]));
          }
        }
      )
      .subscribe(status => {
        if (status === 'SUBSCRIBED') void hydrate();
      });

    // Do not make the persisted warning depend on the WebSocket handshake.
    // The second read on SUBSCRIBED closes the small query/subscribe race, and
    // the revision merge makes both reads safe in either arrival order.
    void hydrate();

    return () => {
      cancelled = true;
      void supabase.removeChannel(channel);
    };
  }, [currentUser?.id, currentUser?.role]);

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
        // Everyone may open Team. Operators get a deliberately read-only,
        // same-organisation directory; management controls remain Admin-only.
        onManageUsers={currentUser ? () => setCurrentView('users') : undefined}
        // The chart of accounts and the organisation overview are an Admin's
        // responsibility; an Operator has no use for either and cannot write to
        // the first, so neither control is shown to them at all.
        onManageLedgers={
          LEDGER_MATCHING && currentUser?.role === 'Admin'
            ? () => setCurrentView('ledgers')
            : undefined
        }
        onViewOverview={
          currentUser?.role === 'Admin' ? () => setCurrentView('overview') : undefined
        }
        onGoToWorkspace={() => setCurrentView('batches')}
        currentView={currentView}
      />

      <main className="main-content">
        {currentUser?.role === 'Super Admin' && platformUsage && platformUsage.level !== 'healthy' && (
          <div
            className={`capacity-alert capacity-alert-${platformUsage.level}`}
            role={platformUsage.level === 'warning' ? 'status' : 'alert'}
            aria-live={platformUsage.level === 'warning' ? 'polite' : 'assertive'}
          >
            <AlertTriangle size={18} />
            <div className="capacity-alert-copy">
              <strong>
                {platformUsage.level === 'full'
                  ? 'Supabase capacity reached'
                  : platformUsage.level === 'critical'
                    ? 'Supabase capacity critical'
                    : 'Supabase capacity warning'}
              </strong>
              <span>{platformUsage.message}</span>
            </div>
            <span className="capacity-alert-percent">{platformUsage.percent.toFixed(1)}%</span>
          </div>
        )}
        {currentUser && currentUser.role !== 'Super Admin' && (
          <div className="capacity-alert-stack" aria-label="Platform capacity notifications">
            {capacityAlerts
              .filter(alert => alert.level !== 'healthy')
              .map(alert => (
                <div
                  key={alert.resource}
                  className={`capacity-alert capacity-alert-${alert.level}`}
                  role={alert.level === 'warning' ? 'status' : 'alert'}
                  aria-live={alert.level === 'warning' ? 'polite' : 'assertive'}
                >
                  <AlertTriangle size={18} />
                  <div className="capacity-alert-copy">
                    <strong>{alert.title}</strong>
                    <span>{alert.message}</span>
                  </div>
                  <span className="capacity-alert-percent">{alert.percent.toFixed(1)}%</span>
                </div>
              ))}
          </div>
        )}
        {authLoading ? (
          <div className="loading-state loading-state-page">
            <Loader2 size={18} className="animate-spin" />
            Loading your account...
          </div>
        ) : !currentUser ? (
          <>
            {authError && (
              <div className="alert alert-error" style={{ maxWidth: '440px', margin: '0 auto 12px auto' }}>
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
          <SuperAdminDashboard usage={platformUsage} connectionState={capacityConnection} />
        ) : currentView === 'ledgers' && LEDGER_MATCHING ? (
          <LedgerManager
            currentUser={currentUser}
            onBack={() => setCurrentView('batches')}
          />
        ) : currentView === 'overview' ? (
          <AdminDashboard
            currentUser={currentUser}
            onOpenWorkspace={() => setCurrentView('batches')}
            onOpenLedgers={() => setCurrentView('ledgers')}
            onOpenTeam={() => setCurrentView('users')}
          />
        ) : currentView === 'batches' ? (
          <BatchWorkspace
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
            batch={activeBatch}
            currentUser={currentUser}
            onBack={() => setCurrentView('reviewer')}
          />
        )}
      </main>
    </div>
  );
}
