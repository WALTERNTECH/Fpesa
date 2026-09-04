import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import type { NewsItem } from '../lib/types';

export function NewsTicker(): JSX.Element | null {
  const [items, setItems] = useState<NewsItem[]>([]);

  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        const res = await api.get<{ items: NewsItem[] }>('/market/news');
        if (!cancelled) setItems(res.items);
      } catch {
        // Ticker simply stays hidden if headlines cannot be reached.
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 5 * 60 * 1000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  // The track is rendered twice and translated by -50%, which makes the loop
  // seamless. Duration scales with headline count so the speed stays readable.
  const duration = useMemo(() => Math.max(items.length * 6, 40) + 's', [items.length]);

  if (items.length === 0) return null;

  const row = (keyPrefix: string, ariaHidden: boolean): JSX.Element[] =>
    items.map((item, i) => (
      <a
        key={keyPrefix + item.id + i}
        className="ticker-item"
        href={item.link}
        target="_blank"
        rel="noopener noreferrer"
        aria-hidden={ariaHidden || undefined}
        tabIndex={ariaHidden ? -1 : undefined}
      >
        <span className="src">{item.source}</span>
        <span className="ticker-sep" />
        <span>{item.title}</span>
      </a>
    ));

  return (
    <div className="ticker">
      <div className="ticker-label">
        <span className="ticker-live" />
        Live FX News
      </div>
      <div className="ticker-viewport">
        <div
          className="ticker-track"
          style={{ '--ticker-duration': duration } as React.CSSProperties}
        >
          {row('a-', false)}
          {row('b-', true)}
        </div>
      </div>
    </div>
  );
}
