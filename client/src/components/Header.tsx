import { useEffect, useRef, useState } from 'react';
import { useApp } from '../store/app';
import { ksh, price as fmtPrice, displayPhone, initials } from '../lib/format';
import {
  BrandMark,
  IconArrowDown,
  IconArrowUp,
  IconChevron,
  IconLogout,
  IconRefresh,
} from './Icons';

export function Brand(): JSX.Element {
  return (
    <a className="brand" href="/" aria-label="Fpesa home">
      <span className="brand-mark">
        <BrandMark size={20} />
      </span>
      <span className="brand-word">
        <em>F</em>pesa
      </span>
    </a>
  );
}

export function Header(): JSX.Element {
  const {
    user, quote, price, tickDir, accountMode, setAccountMode,
    openModal, logout, resetDemo,
  } = useApp();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close the account menu on an outside click or Escape.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent): void => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  const change = quote ? price - quote.dayOpen : 0;
  const changePct = quote && quote.dayOpen ? (change / quote.dayOpen) * 100 : 0;
  const up = change >= 0;
  const balance = user ? (accountMode === 'demo' ? user.demoBalance : user.realBalance) : 0;

  return (
    <header className="header">
      <div className="container header-inner">
        <div className="header-left">
          <Brand />
          {quote && (
            <div className="header-quote" title="Gold spot against the US dollar">
              <span className="sym">XAU/USD</span>
              <span className={'px tnum' + (tickDir ? ' tick-' + tickDir : '')}>
                {fmtPrice(price)}
              </span>
              <span className={'chg tnum ' + (up ? 'up' : 'down')}>
                {up ? '+' : '−'}
                {Math.abs(changePct).toFixed(2)}%
              </span>
            </div>
          )}
        </div>

        <div className="header-actions">
          {!user ? (
            <>
              <button className="btn btn-ghost" onClick={() => openModal('login')}>
                Log in
              </button>
              <button className="btn btn-primary" onClick={() => openModal('register')}>
                Register
              </button>
            </>
          ) : (
            <>
              <button
                className="btn btn-soft btn-sm"
                onClick={() => openModal('deposit')}
                title="Deposit via M-Pesa"
              >
                <IconArrowDown size={15} />
                Deposit
              </button>
              <div className="pos-rel" ref={menuRef}>
                <button
                  className="acct-btn"
                  onClick={() => setMenuOpen((v) => !v)}
                  aria-expanded={menuOpen}
                  aria-haspopup="menu"
                >
                  <span className="avatar self">{initials(user.username)}</span>
                  <span>
                    <span className="bal tnum">{ksh(balance)}</span>
                    <span className="who" style={{ display: 'block' }}>
                      {accountMode === 'demo' ? 'Demo account' : 'Live account'}
                    </span>
                  </span>
                  <IconChevron size={14} />
                </button>

                {menuOpen && (
                  <div className="menu" role="menu">
                    <div className="menu-head">
                      <div className="n">{user.username}</div>
                      <div className="p">{displayPhone(user.phone)}</div>
                    </div>

                    <button
                      role="menuitem"
                      onClick={() => {
                        setAccountMode(accountMode === 'demo' ? 'real' : 'demo');
                        setMenuOpen(false);
                      }}
                    >
                      <IconRefresh size={15} />
                      Switch to {accountMode === 'demo' ? 'live' : 'demo'} account
                    </button>
                    <button
                      role="menuitem"
                      onClick={() => {
                        openModal('deposit');
                        setMenuOpen(false);
                      }}
                    >
                      <IconArrowDown size={15} />
                      Deposit
                    </button>
                    <button
                      role="menuitem"
                      onClick={() => {
                        openModal('withdraw');
                        setMenuOpen(false);
                      }}
                    >
                      <IconArrowUp size={15} />
                      Withdraw
                    </button>
                    <button
                      role="menuitem"
                      onClick={() => {
                        void resetDemo();
                        setMenuOpen(false);
                      }}
                    >
                      <IconRefresh size={15} />
                      Reset demo balance
                    </button>

                    <div className="menu-sep" />
                    <button
                      role="menuitem"
                      className="danger"
                      onClick={() => {
                        void logout();
                        setMenuOpen(false);
                      }}
                    >
                      <IconLogout size={15} />
                      Log out
                    </button>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </header>
  );
}
