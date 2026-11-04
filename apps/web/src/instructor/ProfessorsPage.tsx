import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ACCOUNT_LIMITS, type InstructorAccountSummary } from '@linuxlab/shared';
import { instructorApi } from '../api/client';

/** Administrator only: add professors, reset their passwords, disable accounts. */
export function ProfessorsPage({ myId }: { myId: string }) {
  const [accounts, setAccounts] = useState<InstructorAccountSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [resetting, setResetting] = useState<string | null>(null);
  const [newPassword, setNewPassword] = useState('');

  const load = useCallback(async () => {
    try {
      setAccounts(await instructorApi.accounts());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  /** Runs an action, then reloads; errors and the result are shown at the top. */
  const act = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await fn();
      setNotice(done);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      await load();
      setBusy(false);
    }
  };

  const add = async (e: FormEvent) => {
    e.preventDefault();
    const created = username.trim();
    const ok = await act(
      () => instructorApi.createAccount({ name, username, password }),
      `Added ${name.trim()}. Give them the username "${created}" and the password you chose. They can change it under My account.`,
    );
    if (ok) {
      setName('');
      setUsername('');
      setPassword('');
    }
  };

  const reset = async (e: FormEvent, account: InstructorAccountSummary) => {
    e.preventDefault();
    const ok = await act(() => instructorApi.resetAccountPassword(account.id, newPassword), `New password set for ${account.name}.`);
    if (ok) {
      setResetting(null);
      setNewPassword('');
    }
  };

  const toggle = (account: InstructorAccountSummary) => {
    if (account.active && !window.confirm(`Disable ${account.name}? They can't sign in, and their tests close to new students. Their tests and student records are kept.`)) return;
    void act(() => instructorApi.setAccountActive(account.id, !account.active), `${account.name} is now ${account.active ? 'disabled' : 'enabled'}.`);
  };

  return (
    <section>
      <div className="section-head">
        <h2>Professors</h2>
      </div>
      <p className="muted">Each professor signs in with their own username and only sees their own tests and students.</p>
      {error && <p className="result result-error">{error}</p>}
      {notice && (
        <p className="result result-pass" role="status">
          {notice}
        </p>
      )}
      {!accounts ? (
        <p className="muted">Loading…</p>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Username</th>
              <th scope="col" className="num">Tests</th>
              <th scope="col">Status</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {accounts.map((a) => (
              <tr key={a.id}>
                <td>
                  {a.name} {a.isAdmin && <span className="badge badge-live">Administrator</span>}
                </td>
                <td className="mono">{a.username}</td>
                <td className="num">{a.testCount}</td>
                <td>{a.active ? <span className="badge badge-done">Active</span> : <span className="badge">Disabled</span>}</td>
                <td>
                  {resetting === a.id ? (
                    <form className="action-row" onSubmit={(e) => void reset(e, a)}>
                      <input
                        type="text"
                        autoComplete="off"
                        aria-label={`New password for ${a.name}`}
                        placeholder={`At least ${ACCOUNT_LIMITS.passwordMin} characters`}
                        value={newPassword}
                        onChange={(e) => setNewPassword(e.target.value)}
                      />
                      <button type="submit" className="small-button" disabled={busy}>
                        Save
                      </button>
                      <button type="button" className="link-button" onClick={() => setResetting(null)}>
                        Cancel
                      </button>
                    </form>
                  ) : (
                    <span className="action-row">
                      <button
                        type="button"
                        className="secondary small-button"
                        onClick={() => {
                          setResetting(a.id);
                          setNewPassword('');
                        }}
                      >
                        Reset password
                      </button>
                      {a.id !== myId && (
                        <button type="button" className="secondary small-button" disabled={busy} onClick={() => toggle(a)}>
                          {a.active ? 'Disable' : 'Enable'}
                        </button>
                      )}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <form className="panel question-form" onSubmit={(e) => void add(e)}>
        <h3>Add a professor</h3>
        <div className="form-grid">
          <label>
            Name (students see this)
            <input placeholder="e.g. Dr. Rivera" maxLength={ACCOUNT_LIMITS.nameMax} value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label>
            Username
            <input placeholder="e.g. rrivera" autoComplete="off" maxLength={ACCOUNT_LIMITS.usernameMax} value={username} onChange={(e) => setUsername(e.target.value)} />
          </label>
          <label>
            Starting password
            <input
              type="text"
              autoComplete="off"
              placeholder={`At least ${ACCOUNT_LIMITS.passwordMin} characters`}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
        </div>
        <button type="submit" disabled={busy}>
          Add professor
        </button>
      </form>
    </section>
  );
}
