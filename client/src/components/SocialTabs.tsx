import { useState } from 'react';
import { ChatRoom } from './ChatRoom';
import { ActivityFeed } from './ActivityFeed';
import { Leaderboard } from './Leaderboard';

type Tab = 'chat' | 'activity' | 'leaders';

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'chat', label: 'Chat' },
  { id: 'activity', label: 'Activity' },
  { id: 'leaders', label: 'Leaders' },
];

/**
 * On a phone these three panels stacked would be roughly three screens of
 * scrolling below the desk, so they share one pane behind a segmented control.
 * Wide screens get all three side by side instead.
 */
export function SocialTabs(): JSX.Element {
  const [tab, setTab] = useState<Tab>('chat');

  return (
    <section className="floor" id="floor">
      <div className="seg" role="tablist" aria-label="Trading floor">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            aria-controls={'panel-' + t.id}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="floor-panes">
        <div
          id="panel-chat"
          role="tabpanel"
          className={'floor-pane' + (tab === 'chat' ? ' is-active' : '')}
        >
          <ChatRoom />
        </div>
        <div
          id="panel-activity"
          role="tabpanel"
          className={'floor-pane' + (tab === 'activity' ? ' is-active' : '')}
        >
          <ActivityFeed />
        </div>
        <div
          id="panel-leaders"
          role="tabpanel"
          className={'floor-pane' + (tab === 'leaders' ? ' is-active' : '')}
        >
          <Leaderboard />
        </div>
      </div>
    </section>
  );
}
