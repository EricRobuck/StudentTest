import { useState, type FormEvent } from 'react';
import { ACCOUNT_LIMITS, type InstructorMe } from '@linuxlab/shared';
import { instructorApi } from '../api/client';

/** A professor's own name, username and password. */
export function AccountPage({ me, onChanged }: { me: InstructorMe; onChanged: () => void }) {
  const [name, setName] = useState(me.name);
  const [username, setUsername] = useState(me.username);
  const [profile, setProfile] = useState<{ ok: boolean; text: string } | null>(null);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [pw, setPw] = useState<{ ok: boolean; text: string } | null>(null);

  const saveProfile = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await instructorApi.updateMyAccount({ name, username });
      setProfile({ ok: true, text: 'Saved.' });
      onChanged();
    } catch (err) {
      setProfile({ ok: false, text: err instanceof Error ? err.message : String(err) });
    }
  };

  const savePassword = async (e: FormEvent) => {
    e.preventDefault();
    if (next !== repeat) {
      setPw({ ok: false, text: 'The two new passwords are different.' });
      return;
    }
    try {
      await instructorApi.changeMyPassword(current, next);
      setPw({ ok: true, text: 'Password changed.' });
      setCurrent('');
      setNext('');
      setRepeat('');
    } catch (err) {
      setPw({ ok: false, text: err instanceof Error ? err.message : String(err) });
    }
  };

  const message = (m: { ok: boolean; text: string } | null) =>
    m && (
      <p className={`result ${m.ok ? 'result-pass' : 'result-error'}`} role="status">
        {m.text}
      </p>
    );

  return (
    <section>
      <div className="section-head">
        <h2>My account</h2>
      </div>
      <form className="panel question-form" onSubmit={(e) => void saveProfile(e)}>
        <div className="form-grid">
          <label>
            Name (students see this next to your tests)
            <input maxLength={ACCOUNT_LIMITS.nameMax} value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label>
            Username (what you sign in with)
            <input maxLength={ACCOUNT_LIMITS.usernameMax} autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} />
          </label>
        </div>
        {message(profile)}
        <button type="submit">Save</button>
      </form>

      <form className="panel question-form" onSubmit={(e) => void savePassword(e)}>
        <h3>Change password</h3>
        <div className="form-grid">
          <label>
            Current password
            <input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
          </label>
          <label>
            New password (at least {ACCOUNT_LIMITS.passwordMin} characters)
            <input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
          </label>
          <label>
            New password again
            <input type="password" autoComplete="new-password" value={repeat} onChange={(e) => setRepeat(e.target.value)} />
          </label>
        </div>
        {message(pw)}
        <button type="submit" disabled={!current || !next}>
          Change password
        </button>
      </form>
    </section>
  );
}
