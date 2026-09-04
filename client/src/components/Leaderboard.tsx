import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { marketSocket } from '../lib/ws';
import { ksh } from '../lib/format';
import type { LeaderRow } from '../lib/types';

const RANK_CLASS = ['top', 'second', 'third', '', ''];

export function Leaderboard(): JSX.Element {
  const [rows, setRows] = useState<LeaderRow[]>([]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await api.get<{ rows: LeaderRow[] }>('/social/leaderboard');
        if (!cancelled) setRows(res.rows);
      } catch {
        // Board stays empty until the first settled trade of the day.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    return marketSocket.on((msg) => {
      if (msg.type === 'leaderboard') setRows(msg.rows as LeaderRow[]);
    });
  }, []);

  const champion = rows[0];

  return (
    <div className="card">
      <div className="card-head">
        <div className="section-title">
          <span className="dot" />
          Today&rsquo;s top traders
        </div>
        <span className="eyebrow">Resets daily</span>
      </div>

      {champion && (
        <div className="top-trader">
          <span className="crown" aria-hidden="true">
            👑
          </span>
          <div>
            <div className="k">Top profit today</div>
            <div className="n">{champion.username}</div>
          </div>
          <span className="p tnum">+{ksh(champion.profit, true)}</span>
        </div>
      )}

      <div className="lb-list">
        {rows.length === 0 ? (
          <div className="empty">
            No profitable traders yet today. The board fills as live trades settle.
          </div>
        ) : (
          rows.map((row, i) => (
            <div className={'lb-row ' + (RANK_CLASS[i] ?? '')} key={row.username + i}>
              <span className="lb-rank">{i + 1}</span>
              <div className="lb-name">
                {row.username}
                <div className="lb-sub">
                  {row.wins}/{row.trades} won
                </div>
              </div>
              <span className="lb-profit tnum">+{ksh(row.profit, true)}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
