import { useApp } from '../store/app';

/**
 * The three places a trader goes: the ticket, the scanner, and their record.
 *
 * Everything that used to sit under the buttons — the pass pitch, the scaled
 * product's terms, the auto-run strip — is gone from here. A trading screen
 * earns attention by being uncluttered, and none of it was needed to place a
 * trade.
 */
export function BottomNav(): JSX.Element {
  const { openModal, scanBusy } = useApp();

  const go = (id: string): void => {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <nav className="bnav" aria-label="Sections">
      <button onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}>
        <span className="bn-i" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M4 19V10M10 19V5M16 19v-7M22 19H2" strokeLinecap="round" />
          </svg>
        </span>
        Trade
      </button>

      <button className="bn-auto" onClick={() => openModal('auto')}>
        <span className="bn-spark" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" strokeLinejoin="round" />
          </svg>
        </span>
        {scanBusy ? 'Scanning…' : 'Fpesa Auto'}
      </button>

      <button onClick={() => go('history')}>
        <span className="bn-i" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 7v5l3 2" strokeLinecap="round" />
          </svg>
        </span>
        Positions
      </button>
    </nav>
  );
}
