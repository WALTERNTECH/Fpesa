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
        <span>Fpesa · XAU/USD</span>
        <a href={config.supportTelegram} target="_blank" rel="noopener noreferrer">
          Support
        </a>
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
