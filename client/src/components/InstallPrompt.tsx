import { useEffect, useState } from 'react';
import { useInstall } from '../lib/pwa';
import { IconClose } from './Icons';

/**
 * Install affordance shown once the browser says the app is installable.
 * Held back a few seconds so it does not cover the chart the moment the app
 * opens, and dismissible — a rejected banner does not come back this session.
 */
export function InstallPrompt(): JSX.Element | null {
  const { available, canPrompt, needsManualSteps, dismissed, install, dismiss } = useInstall();
  const [visible, setVisible] = useState(false);
  const [showSteps, setShowSteps] = useState(false);

  useEffect(() => {
    if (!available || dismissed) {
      setVisible(false);
      return;
    }
    const t = window.setTimeout(() => setVisible(true), 2500);
    return () => window.clearTimeout(t);
  }, [available, dismissed]);

  if (!visible) return null;

  const onInstall = async (): Promise<void> => {
    if (canPrompt) {
      const outcome = await install();
      if (outcome !== 'unavailable') setVisible(false);
      return;
    }
    setShowSteps((v) => !v);
  };

  return (
    <div className="install-sheet" role="dialog" aria-label="Install Fpesa">
      <div className="install-row">
        <img className="install-icon" src="/icon-192.png" alt="" width={44} height={44} />
        <div className="install-copy">
          <div className="t">Install Fpesa</div>
          <div className="d">Full screen, opens straight to the desk.</div>
        </div>
        <button className="btn btn-primary btn-sm" onClick={() => void onInstall()}>
          {canPrompt ? 'Install' : 'How'}
        </button>
        <button
          className="install-close"
          onClick={() => {
            dismiss();
            setVisible(false);
          }}
          aria-label="Dismiss"
        >
          <IconClose size={16} />
        </button>
      </div>

      {showSteps && needsManualSteps && (
        <ol className="install-steps">
          <li>
            Tap <b>Share</b> in the Safari toolbar
          </li>
          <li>
            Choose <b>Add to Home Screen</b>
          </li>
          <li>
            Tap <b>Add</b>
          </li>
        </ol>
      )}
    </div>
  );
}
