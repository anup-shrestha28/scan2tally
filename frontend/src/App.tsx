import React, { useState, useEffect } from 'react';
import Navbar from './components/Navbar';
import LoginModal from './components/LoginModal';
import SuperAdminDashboard from './components/SuperAdminDashboard';
import BatchWorkspace from './components/BatchWorkspace';
import SideBySideReviewer from './components/SideBySideReviewer';
import ExcelExporter from './components/ExcelExporter';
import { User, ScanBatch, Receipt, Transaction } from './types';

export default function App() {
  const [currentUser, setCurrentUser] = useState<User | null>({
    id: 'usr-operator',
    name: 'David Data Entry Specialist',
    email: 'operator@alpha-accounts.com',
    role: 'Operator',
    status: 'Active',
    orgId: '00000000-0000-0000-0000-000000000001',
    orgName: 'Alpha Accounts Pvt Ltd'
  });

  const [currentView, setCurrentView] = useState<'batches' | 'reviewer' | 'exporter'>('batches');
  const [activeBatch, setActiveBatch] = useState<ScanBatch | null>(null);
  const [selectedReceipt, setSelectedReceipt] = useState<Receipt | null>(null);
  const [liveExtractedTransactions, setLiveExtractedTransactions] = useState<Transaction[]>([]);
  const [activeTransactions, setActiveTransactions] = useState<Transaction[]>([]);
  const [isDark, setIsDark] = useState<boolean>(true);

  useEffect(() => {
    document.body.classList.toggle('light', !isDark);
  }, [isDark]);

  const handleLogin = (user: User) => {
    setCurrentUser(user);
    setCurrentView('batches');
  };

  const handleLogout = () => {
    setCurrentUser(null);
  };

  const handleSelectBatch = (batch: ScanBatch, receipt?: Receipt, extractedTx?: Transaction[]) => {
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
    
    setCurrentView('reviewer');
  };

  const handleExportExcel = (transactions: Transaction[]) => {
    setActiveTransactions(transactions);
    setCurrentView('exporter');
  };

  return (
    <div className="app-container">
      <Navbar currentUser={currentUser} onLogout={handleLogout} isDark={isDark} onToggleTheme={() => setIsDark(d => !d)} />

      <main className="main-content">
        {!currentUser ? (
          <LoginModal onLogin={handleLogin} />
        ) : currentUser.role === 'Super Admin' ? (
          <SuperAdminDashboard />
        ) : currentView === 'batches' ? (
          <BatchWorkspace 
            userRole={currentUser.role} 
            onSelectBatch={handleSelectBatch} 
          />
        ) : currentView === 'reviewer' ? (
          <SideBySideReviewer 
            batch={activeBatch} 
            selectedReceipt={selectedReceipt}
            initialTransactions={liveExtractedTransactions}
            onBack={() => setCurrentView('batches')} 
            onExportExcel={handleExportExcel} 
          />
        ) : (
          <ExcelExporter 
            transactions={activeTransactions} 
            onBack={() => setCurrentView('reviewer')} 
          />
        )}
      </main>
    </div>
  );
}
