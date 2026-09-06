import { useApp } from '../store/app';
import { useInstall } from '../lib/pwa';

export function Footer(): JSX.Element {
  const { config } = useApp();
  const { available: canInstall, canPrompt, install } = useInstall();

  return (
    <footer className="footer">
      <p className="risk">
        Trading carries risk. You can lose the full amount you stake on a trade.
      </p>
      <div className="footer-row">
        <span>Fpesa · {config.symbol}</span>
        <a href={config.supportTelegram} target="_blank" rel="noopener noreferrer">
          Support
        </a>
        {config.provablyFair && (
          <a href="/api/fairness" target="_blank" rel="noopener noreferrer">
            Provably fair
          </a>
        )}
        {canInstall && (
          <button
            onClick={() => {
              if (canPrompt) void install();
              else document.querySelector('.install-sheet')?.scrollIntoView({ block: 'center' });
            }}
          >
            Install app
          </button>
        )}
      </div>
    </footer>
  );
}
