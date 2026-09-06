import { useEffect, useRef, useState } from 'react';
import { useApp } from '../store/app';
import { useInstall } from '../lib/pwa';
import { ksh, price as fmtPrice, displayPhone, initials } from '../lib/format';
import {
  BrandMark,
  IconArrowDown,
  IconArrowUp,
  IconChevron,
  IconDownload,
  IconLogout,
  IconRefresh,
} from './Icons';

export function Brand(): JSX.Element {
  return (
    <a className="brand" href="/" aria-label="Fpesa">
      <span className="brand-mark">
        <BrandMark size={18} />
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
    openModal, logout, resetDemo, config,
  } = useApp();
  const { available: canInstall, canPrompt, install } = useInstall();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

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

  const onInstall = async (): Promise<void> => {
    setMenuOpen(false);
    if (canPrompt) {
      await install();
      return;
    }
    // iOS has no prompt API; scroll the sheet with the manual steps into view.
    document.querySelector('.install-sheet')?.scrollIntoView({ block: 'center' });
  };

  return (
    <header className="header">
      <div className="header-inner">
        <Brand />

        {quote && (
          <div className="header-quote" title={config.symbolName}>
            <span className="sym">{config.symbol}</span>
            <span className={'px tnum' + (tickDir ? ' tick-' + tickDir : '')}>
              {fmtPrice(price)}
            </span>
            <span className={'chg tnum ' + (up ? 'up' : 'down')}>
              {up ? '+' : '−'}
              {Math.abs(changePct).toFixed(2)}%
            </span>
          </div>
        )}

        <div className="header-actions">
          {!user ? (
            <>
              <button className="btn btn-ghost btn-sm" onClick={() => openModal('login')}>
                Log in
              </button>
              <button className="btn btn-primary btn-sm" onClick={() => openModal('register')}>
                Register
              </button>
            </>
          ) : (
            <div className="pos-rel" ref={menuRef}>
              <button
                className="acct-btn"
                onClick={() => setMenuOpen((v) => !v)}
                aria-expanded={menuOpen}
                aria-haspopup="menu"
              >
                <span className="avatar self">{initials(user.username)}</span>
                <span className="acct-meta">
                  <span className="bal tnum">{ksh(balance)}</span>
                  <span className="who">{accountMode === 'demo' ? 'Demo' : 'Live'}</span>
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
                    Switch to {accountMode === 'demo' ? 'live' : 'demo'}
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

                  {canInstall && (
                    <>
                      <div className="menu-sep" />
                      <button
                        role="menuitem"
                        className="accent"
                        onClick={() => void onInstall()}
                      >
                        <IconDownload size={15} />
                        Install app
                      </button>
                    </>
                  )}

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
          )}
        </div>
      </div>
    </header>
  );
}
