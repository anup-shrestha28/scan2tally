import React, { useEffect, useState } from 'react';
import {
  BookOpen, Plus, Loader2, AlertCircle, Trash2, Edit2, Check, X, Upload, RotateCcw, Search,
} from 'lucide-react';
import { Ledger, User } from '../types';
import { fetchLedgers, createLedger, updateLedger, importLedgers } from '../lib/db';
import { parsePastedLedgers } from '../lib/ledgers';

/**
 * The organisation's chart of accounts.
 *
 * This list is what every extraction matches handwritten ledger names against,
 * so it is the difference between a spreadsheet Tally imports cleanly and one
 * that silently creates a second "Freight Outward" alongside the real account.
 *
 * Admin-only by policy as well as by routing: an entry here changes where every
 * future voucher gets posted, company-wide.
 */
interface LedgerManagerProps {
  currentUser: User;
  onBack: () => void;
}

export default function LedgerManager({ currentUser, onBack }: LedgerManagerProps) {
  const [ledgers, setLedgers] = useState<Ledger[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [name, setName] = useState('');
  const [parentGroup, setParentGroup] = useState('');

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editGroup, setEditGroup] = useState('');
  const [editAliases, setEditAliases] = useState('');

  const [showImport, setShowImport] = useState(false);
  const [pasted, setPasted] = useState('');
  const [filter, setFilter] = useState('');

  const load = async () => {
    try {
      // Inactive ledgers are shown here and nowhere else: this is where someone
      // comes to find out why a retired account stopped being matched.
      setLedgers(await fetchLedgers(true));
      setError(null);
    } catch (err: any) {
      setError(err?.message || 'Could not load your chart of accounts.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || !currentUser.organization_id) return;

    setBusy(true);
    try {
      const created = await createLedger({
        organizationId: currentUser.organization_id,
        userId: currentUser.id,
        name: trimmed,
        parentGroup: parentGroup,
      });
      setLedgers(prev => [...prev, created].sort((a, b) => a.name.localeCompare(b.name)));
      setName('');
      setParentGroup('');
      setError(null);
      setNotice(`Added "${created.name}".`);
    } catch (err: any) {
      setError(err?.message || 'Could not add that ledger.');
    } finally {
      setBusy(false);
    }
  };

  const startEditing = (ledger: Ledger) => {
    setEditingId(ledger.id);
    setEditName(ledger.name);
    setEditGroup(ledger.parent_group || '');
    setEditAliases(ledger.aliases.join(', '));
  };

  const handleSaveEdit = async (ledger: Ledger) => {
    const trimmed = editName.trim();
    if (!trimmed) return;

    const aliases = editAliases.split(',').map(a => a.trim()).filter(Boolean);
    const snapshot = ledgers;
    setLedgers(prev => prev.map(l =>
      l.id === ledger.id
        ? { ...l, name: trimmed, parent_group: editGroup.trim() || undefined, aliases }
        : l
    ));
    setEditingId(null);

    try {
      await updateLedger(ledger.id, { name: trimmed, parentGroup: editGroup, aliases });
      setError(null);
      setNotice(`Updated "${trimmed}".`);
    } catch (err: any) {
      // Put it back rather than leave the screen disagreeing with what is stored.
      setLedgers(snapshot);
      setError(err?.message || 'Could not save that ledger.');
    }
  };

  const toggleActive = async (ledger: Ledger) => {
    const next = !ledger.is_active;
    const snapshot = ledgers;
    setLedgers(prev => prev.map(l => (l.id === ledger.id ? { ...l, is_active: next } : l)));
    try {
      await updateLedger(ledger.id, { isActive: next });
      setError(null);
      setNotice(
        next
          ? `"${ledger.name}" is back in use.`
          : `"${ledger.name}" retired. Vouchers already posted to it are untouched.`
      );
    } catch (err: any) {
      setLedgers(snapshot);
      setError(err?.message || 'Could not update that ledger.');
    }
  };

  const handleImport = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentUser.organization_id) return;
    const entries = parsePastedLedgers(pasted);
    if (!entries.length) {
      setError('Nothing to import — paste one ledger name per line.');
      return;
    }

    setBusy(true);
    try {
      const { added, skipped } = await importLedgers(
        { organizationId: currentUser.organization_id, userId: currentUser.id },
        entries
      );
      await load();
      setPasted('');
      setShowImport(false);
      setError(null);
      setNotice(
        skipped.length
          ? `Added ${added}. Skipped ${skipped.length} already in your chart of accounts.`
          : `Added ${added} ${added === 1 ? 'ledger' : 'ledgers'}.`
      );
    } catch (err: any) {
      setError(err?.message || 'Could not import those ledgers.');
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="loading-state">
        <Loader2 size={18} className="animate-spin" /> Loading your chart of accounts...
      </div>
    );
  }

  const active = ledgers.filter(l => l.is_active).length;
  const normalizedFilter = filter.trim().toLocaleLowerCase();
  const filteredLedgers = normalizedFilter
    ? ledgers.filter(ledger =>
        [ledger.name, ledger.parent_group || '', ...ledger.aliases]
          .some(value => value.toLocaleLowerCase().includes(normalizedFilter))
      )
    : ledgers;

  return (
    <div className="page page-compact">
      <div className="page-header">
        <div>
          <h2 className="page-title">Chart of Accounts</h2>
          <p className="page-subtitle page-subtitle-wide">
            The ledgers that exist in your Tally company. Extracted vouchers are matched
            against this list, so a name here is a name Tally will accept on import.
          </p>
        </div>
        <div className="page-actions">
          <button className="btn btn-secondary" onClick={() => setShowImport(v => !v)}>
            <Upload size={16} /> Paste from Tally
          </button>
          <button className="btn btn-secondary" onClick={onBack}>Back to Workspace</button>
        </div>
      </div>

      {!active && (
        <div className="alert alert-warning alert-top" style={{ padding: '12px 14px' }}>
          <AlertCircle size={16} className="alert-icon" />
          <span>
            Your chart of accounts is empty, so extracted ledger names are exported exactly as
            they were written on the paper. Tally creates a new account for any name it does not
            recognise — add your ledgers here to have them checked before that happens.
          </span>
        </div>
      )}

      {error && (
        <div className="alert alert-error">
          <AlertCircle size={16} className="alert-icon" /> {error}
        </div>
      )}

      {notice && !error && (
        <div className="alert alert-success">
          <Check size={16} className="alert-icon" /> {notice}
        </div>
      )}

      {showImport && (
        <div className="card" style={{ borderColor: 'var(--primary)' }}>
          <h3 className="section-title" style={{ marginBottom: '6px' }}>
            Paste your ledger list
          </h3>
          <p className="text-muted text-2xs" style={{ marginBottom: '12px' }}>
            One per line. Add the Tally group after a comma or pipe if you have it —
            for example <code>Freight Outward | Indirect Expenses</code>. Names you already
            have are skipped, so re-pasting an updated list is safe.
          </p>
          <form onSubmit={handleImport} className="stack" style={{ gap: '12px' }}>
            <textarea
              className="form-input form-textarea-mono"
              rows={8}
              value={pasted}
              onChange={e => setPasted(e.target.value)}
              placeholder={'Freight Outward | Indirect Expenses\nTDS Payable | Duties & Taxes\nBank Account | Bank Accounts'}
              disabled={busy}
              autoFocus
            />
            <div className="form-actions">
              <button type="submit" className="btn btn-primary" disabled={busy}>
                {busy ? <><Loader2 size={16} className="animate-spin" /> Importing...</> : 'Import Ledgers'}
              </button>
              <button type="button" className="btn btn-secondary" disabled={busy}
                      onClick={() => { setShowImport(false); setPasted(''); }}>
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      <div className="card">
        <h3 className="section-title section-title-tight">Add a ledger</h3>
        <form onSubmit={handleAdd} className="inline-form">
          <div className="form-group field-grow">
            <label className="form-label">Ledger name (exactly as in Tally)</label>
            <input type="text" className="form-input" value={name} disabled={busy}
                   onChange={e => setName(e.target.value)}
                   placeholder="e.g. Carriage Outward - Labour" required />
          </div>
          <div className="form-group field-fixed">
            <label className="form-label">Under group (optional)</label>
            <input type="text" className="form-input" value={parentGroup} disabled={busy}
                   onChange={e => setParentGroup(e.target.value)}
                   placeholder="e.g. Indirect Expenses" />
          </div>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            <Plus size={16} /> Add
          </button>
        </form>
      </div>

      <div className="card">
        <div className="ledger-table-toolbar">
          <h3 className="section-title">
            <BookOpen size={18} />
            Ledgers ({active} in use{ledgers.length - active > 0 ? `, ${ledgers.length - active} retired` : ''})
          </h3>
          <label className="ledger-filter">
            <Search size={14} />
            <input
              className="form-input"
              value={filter}
              onChange={event => setFilter(event.target.value)}
              placeholder="Filter ledgers…"
              aria-label="Filter ledgers"
            />
          </label>
        </div>

        <div className="table-container">
          <table className="custom-table">
            <thead>
              <tr>
                <th>Ledger Name</th>
                <th>Under Group</th>
                <th>Also written as</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {!filteredLedgers.length ? (
                <tr>
                  <td colSpan={5} className="table-empty">
                    {ledgers.length ? 'No ledgers match that filter.' : 'No ledgers yet. Add them above, or paste your list from Tally.'}
                  </td>
                </tr>
              ) : filteredLedgers.map(ledger => (
                <tr key={ledger.id} className={ledger.is_active ? '' : 'ledger-row-retired'}>
                  {editingId === ledger.id ? (
                    <>
                      <td>
                        <input type="text" size={1} className="cell-input" value={editName}
                               onChange={e => setEditName(e.target.value)} autoFocus />
                      </td>
                      <td>
                        <input type="text" size={1} className="cell-input" value={editGroup}
                               onChange={e => setEditGroup(e.target.value)} />
                      </td>
                      <td>
                        <input type="text" size={1} className="cell-input" value={editAliases}
                               onChange={e => setEditAliases(e.target.value)}
                               title="Comma separated" placeholder="Bank A/c, bank ac" />
                      </td>
                      <td>{ledger.is_active ? 'In use' : 'Retired'}</td>
                      <td>
                        <div className="row-xs">
                          <button className="btn btn-primary btn-sm" title="Save"
                                  onClick={() => handleSaveEdit(ledger)}>
                            <Check size={13} />
                          </button>
                          <button className="btn btn-secondary btn-sm" title="Cancel"
                                  onClick={() => setEditingId(null)}>
                            <X size={13} />
                          </button>
                        </div>
                      </td>
                    </>
                  ) : (
                    <>
                      <td className="text-strong">{ledger.name}</td>
                      <td className="text-muted">{ledger.parent_group || '—'}</td>
                      <td className="text-muted text-xs">
                        {ledger.aliases.length ? ledger.aliases.join(', ') : '—'}
                      </td>
                      <td>
                        <span className={`status-pill ${ledger.is_active ? 'status-extracted' : 'status-pending'}`}>
                          {ledger.is_active ? '✓ In use' : '○ Retired'}
                        </span>
                      </td>
                      <td>
                        <div className="row-xs">
                          <button className="btn btn-secondary btn-sm" title="Edit name, group and spellings"
                                  onClick={() => startEditing(ledger)}>
                            <Edit2 size={13} />
                          </button>
                          {/* Retired rather than deleted: vouchers already posted
                              to this ledger keep pointing at it, and its history
                              stays readable. */}
                          <button
                            className={`btn btn-sm ${ledger.is_active ? 'btn-danger' : 'btn-secondary'}`}
                            title={ledger.is_active
                              ? 'Retire — stops new vouchers matching this ledger'
                              : 'Put back into use'}
                            onClick={() => toggleActive(ledger)}
                          >
                            {ledger.is_active ? <Trash2 size={13} /> : <RotateCcw size={13} />}
                          </button>
                        </div>
                      </td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
