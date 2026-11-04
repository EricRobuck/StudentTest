import { useState, type FormEvent } from 'react';
import { instructorApi } from '../api/client';

export function LoginPage({ onSignedIn }: { onSignedIn: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await instructorApi.login(username, password);
      onSignedIn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <form className="login-card" onSubmit={(e) => void submit(e)}>
      <h2>Instructor sign-in</h2>
      <label htmlFor="instructor-username">Username</label>
      <input
        id="instructor-username"
        autoComplete="username"
        autoCapitalize="none"
        spellCheck={false}
        value={username}
        onChange={(e) => setUsername(e.target.value)}
        autoFocus
        required
      />
      <label htmlFor="instructor-password">Password</label>
      <input
        id="instructor-password"
        type="password"
        autoComplete="current-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        required
      />
      {error && <p className="error-text">{error}</p>}
      <button type="submit" disabled={busy || username.trim().length === 0 || password.length === 0}>
        {busy ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  );
}
