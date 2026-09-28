import { useState, type FormEvent } from 'react';
import { instructorApi } from '../api/client';

export function LoginPage({ onSignedIn }: { onSignedIn: () => void }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await instructorApi.login(password);
      onSignedIn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <form className="login-card" onSubmit={(e) => void submit(e)}>
      <h2>Instructor sign-in</h2>
      <label htmlFor="instructor-password">Password</label>
      <input
        id="instructor-password"
        type="password"
        autoComplete="current-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        autoFocus
        required
      />
      {error && <p className="error-text">{error}</p>}
      <button type="submit" disabled={busy || password.length === 0}>
        {busy ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  );
}
