import { useCallback, useEffect, useState } from 'react';

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
};

const DISMISS_KEY = 'fpesa.install.dismissed';

/** Captured before React mounts, so a prompt fired early is not lost. */
let deferred: BeforeInstallPromptEvent | null = null;
const listeners = new Set<() => void>();

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e as BeforeInstallPromptEvent;
    listeners.forEach((fn) => fn());
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    try {
      localStorage.removeItem(DISMISS_KEY);
    } catch {
      // Storage can throw in private modes; nothing here is essential.
    }
    listeners.forEach((fn) => fn());
  });
}

export function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return;

  const go = (): void => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // Only offline support is lost; the app itself still runs. Some embedded
      // and locked-down browsers refuse workers outright, which is not an error
      // worth surfacing to a trader.
    });
  };

  // Waiting on 'load' keeps registration off the critical path, but the event
  // has already fired if this module is evaluated late — register straight away
  // in that case rather than waiting for an event that will never come.
  if (document.readyState === 'complete') go();
  else window.addEventListener('load', go, { once: true });
}

function standalone(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (window.navigator as { standalone?: boolean }).standalone === true
  );
}

function isIOS(): boolean {
  const ua = window.navigator.userAgent;
  // iPadOS 13+ reports as Macintosh, so check for touch as well.
  return (
    /iPad|iPhone|iPod/.test(ua) ||
    (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)
  );
}

export type InstallState = {
  /** Chrome/Edge/Android: a real prompt is available. */
  canPrompt: boolean;
  /** iOS Safari: no prompt API, so we show Add to Home Screen steps instead. */
  needsManualSteps: boolean;
  /** Already running as an installed app. */
  installed: boolean;
  /** True when the install affordance is worth showing at all. */
  available: boolean;
  dismissed: boolean;
  install: () => Promise<'accepted' | 'dismissed' | 'unavailable'>;
  dismiss: () => void;
};

export function useInstall(): InstallState {
  const [hasPrompt, setHasPrompt] = useState(() => deferred !== null);
  const [installed, setInstalled] = useState(() => standalone());
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(DISMISS_KEY) === '1';
    } catch {
      return false;
    }
  });

  useEffect(() => {
    const sync = (): void => {
      setHasPrompt(deferred !== null);
      setInstalled(standalone());
    };
    listeners.add(sync);
    const mq = window.matchMedia('(display-mode: standalone)');
    mq.addEventListener?.('change', sync);
    return () => {
      listeners.delete(sync);
      mq.removeEventListener?.('change', sync);
    };
  }, []);

  const install = useCallback(async () => {
    if (!deferred) return 'unavailable' as const;
    await deferred.prompt();
    const { outcome } = await deferred.userChoice;
    // The event is single-use — Chrome will fire a fresh one if still eligible.
    deferred = null;
    listeners.forEach((fn) => fn());
    return outcome;
  }, []);

  const dismiss = useCallback(() => {
    setDismissed(true);
    try {
      localStorage.setItem(DISMISS_KEY, '1');
    } catch {
      // Non-fatal: the banner reappears next visit.
    }
  }, []);

  const needsManualSteps = !installed && !hasPrompt && isIOS();

  return {
    canPrompt: hasPrompt && !installed,
    needsManualSteps,
    installed,
    available: !installed && (hasPrompt || needsManualSteps),
    dismissed,
    install,
    dismiss,
  };
}
