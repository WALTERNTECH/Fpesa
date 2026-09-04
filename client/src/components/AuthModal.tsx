import { useState, type FormEvent } from 'react';
import { useApp } from '../store/app';
import { ApiError } from '../lib/api';
import { ksh } from '../lib/format';
import { Modal } from './Modal';

type Mode = 'login' | 'register';

export function AuthModal({ mode }: { mode: Mode }): JSX.Element {
  const { closeModal, openModal, login, register, config } = useApp();

  const [username, setUsername] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isRegister = mode === 'register';

  // Mirrors the server rule so the user is told before a round trip.
  const phoneLooksValid = (value: string): boolean => {
    const digits = value.replace(/[^0-9]/g, '');
    const local = digits.startsWith('254')
      ? digits.slice(3)
      : digits.startsWith('0')
        ? digits.slice(1)
        : digits;
    return /^(7|1)[0-9]{8}$/.test(local);
  };

  const mismatch =
    isRegister && confirmPassword.length > 0 && password !== confirmPassword;

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (busy) return;
    setError(null);

    if (isRegister) {
      if (!phoneLooksValid(phone)) {
        setError('Enter a valid Safaricom number, for example 0712 345 678.');
        return;
      }
      if (password !== confirmPassword) {
        setError('The two passwords do not match.');
        return;
      }
    }

    setBusy(true);
    try {
      if (isRegister) {
        await register({ username, phone, password, confirmPassword });
      } else {
        await login(username, password);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={isRegister ? 'Create your Fpesa account' : 'Welcome back'}
      subtitle={
        isRegister
          ? 'Takes under a minute. Your demo account is funded instantly.'
          : 'Log in to trade, deposit and withdraw.'
      }
      onClose={closeModal}
    >
      {isRegister && (
        <div className="demo-banner">
          <span className="ico" aria-hidden="true">
            🎁
          </span>
          <div>
            <div className="t">{ksh(config.demoStartingBalance, true)} demo balance</div>
            <div className="d">
              Practise on live market prices with zero risk before funding a live account.
            </div>
          </div>
        </div>
      )}

      <form onSubmit={(e) => void submit(e)} noValidate>
        {error && <div className="form-error">{error}</div>}

        <div className="form-field">
          <label htmlFor="auth-username">
            {isRegister ? 'Username' : 'Username or phone number'}
          </label>
          <input
            id="auth-username"
            className="input"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete={isRegister ? 'username' : 'username'}
            placeholder={isRegister ? 'e.g. juma_trades' : 'Username or 0712 345 678'}
            maxLength={20}
            required
          />
        </div>

        {isRegister && (
          <div className="form-field">
            <label htmlFor="auth-phone">M-Pesa phone number</label>
            <div className="input-prefix">
              <span className="pfx">+254</span>
              <input
                id="auth-phone"
                className={
                  'input' + (phone.length > 8 && !phoneLooksValid(phone) ? ' invalid' : '')
                }
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                inputMode="tel"
                autoComplete="tel"
                placeholder="712 345 678"
                required
              />
            </div>
            <div className="field-error" style={{ color: 'var(--subtle)' }}>
              Deposits and withdrawals both use this number.
            </div>
          </div>
        )}

        <div className="form-field">
          <label htmlFor="auth-password">Password</label>
          <input
            id="auth-password"
            className="input"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={isRegister ? 'new-password' : 'current-password'}
            placeholder={isRegister ? 'At least 6 characters' : 'Your password'}
            minLength={6}
            required
          />
        </div>

        {isRegister && (
          <div className="form-field">
            <label htmlFor="auth-confirm">Confirm password</label>
            <input
              id="auth-confirm"
              className={'input' + (mismatch ? ' invalid' : '')}
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              autoComplete="new-password"
              placeholder="Re-enter your password"
              required
            />
            {mismatch && <div className="field-error">Passwords do not match.</div>}
          </div>
        )}

        <button
          className="btn btn-primary btn-lg btn-block"
          type="submit"
          disabled={busy}
          style={{ marginTop: 6 }}
        >
          {busy
            ? isRegister
              ? 'Creating account…'
              : 'Logging in…'
            : isRegister
              ? 'Create account'
              : 'Log in'}
        </button>
      </form>

      <p className="form-note">
        {isRegister ? 'Already have an account? ' : 'New to Fpesa? '}
        <button type="button" onClick={() => openModal(isRegister ? 'login' : 'register')}>
          {isRegister ? 'Log in' : 'Create a free account'}
        </button>
      </p>
    </Modal>
  );
}
