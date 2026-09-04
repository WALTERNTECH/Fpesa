import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { marketSocket } from '../lib/ws';
import { ksh, timeAgo } from '../lib/format';
import type { FeedItem } from '../lib/types';

const STYLES: Record<string, { cls: string; icon: string; verb: string }> = {
  DEPOSIT: { cls: 'dep', icon: '↓', verb: 'deposited' },
  WITHDRAWAL: { cls: 'wit', icon: '↑', verb: 'withdrew' },
  BIG_WIN: { cls: 'win', icon: '★', verb: 'won' },
};

export function ActivityFeed(): JSX.Element {
  const [items, setItems] = useState<FeedItem[]>([]);
  // Re-render on a slow interval so the "2m ago" labels stay honest.
  const [, setClock] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await api.get<{ items: FeedItem[] }>('/social/feed');
        if (!cancelled) setItems(res.items);
      } catch {
        // A quiet feed is fine.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    return marketSocket.on((msg) => {
      if (msg.type !== 'feed') return;
      setItems((prev) =>
        [
          {
            id: msg.kind + msg.createdAt + msg.username,
            kind: msg.kind,
            username: msg.username,
            amount: msg.amount,
            createdAt: msg.createdAt,
          },
          ...prev,
        ].slice(0, 40)
      );
    });
  }, []);

  useEffect(() => {
    const id = window.setInterval(() => setClock((n) => n + 1), 30_000);
    return () => window.clearInterval(id);
  }, []);

  return (
    <div className="card">
      <div className="card-head">
        <div className="section-title">
          <span className="dot" />
          Live activity
        </div>
        <span className="eyebrow">Deposits &amp; payouts</span>
      </div>

      <div className="scroll-area">
        {items.length === 0 ? (
          <div className="empty">Nothing yet today. Activity appears here in real time.</div>
        ) : (
          <div className="feed-list">
            {items.map((item) => {
              const style = STYLES[item.kind] ?? STYLES.DEPOSIT!;
              return (
                <div className="feed-item" key={item.id}>
                  <span className={'feed-icon ' + style.cls} aria-hidden="true">
                    {style.icon}
                  </span>
                  <div className="txt">
                    <b>{item.username}</b> {style.verb}
                    <div className="when">{timeAgo(item.createdAt)}</div>
                  </div>
                  <span className={'amt tnum ' + style.cls}>{ksh(item.amount, true)}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
