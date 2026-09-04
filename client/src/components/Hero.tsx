import { useEffect, useState } from 'react';
import { useApp } from '../store/app';
import { api } from '../lib/api';
import { ksh, kshShort } from '../lib/format';
import { IconBolt, IconCheck, IconShield } from './Icons';

type Stats = { online: number; tradesToday: number; volumeToday: number };

export function Hero(): JSX.Element {
  const { user, openModal, config, online } = useApp();
  const [stats, setStats] = useState<Stats>({ online: 0, tradesToday: 0, volumeToday: 0 });

  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        const res = await api.get<Stats>('/social/stats');
        if (!cancelled) setStats(res);
      } catch {
        // Tiles fall back to zeros.
      }
    };
    void load();
    const id = window.setInterval(() => void load(), 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  return (
    <section className="hero">
      <div className="container hero-grid">
        <div>
          <div className="eyebrow" style={{ marginBottom: 14 }}>
            Gold · Forex · Kenya
          </div>
          <h1>
            Trade <em>gold</em> on live prices, straight from M-Pesa.
          </h1>
          <p className="hero-sub">
            Pick a direction, pick a duration, and see the result in seconds. Deposit and
            withdraw instantly with the M-Pesa number you signed up with — from{' '}
            {ksh(config.minStake, true)}.
          </p>

          <div className="hero-cta">
            {user ? (
              <>
                <a className="btn btn-primary btn-lg" href="#desk">
                  Go to trading desk
                </a>
                <button className="btn btn-ghost btn-lg" onClick={() => openModal('deposit')}>
                  Deposit funds
                </button>
              </>
            ) : (
              <>
                <button
                  className="btn btn-primary btn-lg"
                  onClick={() => openModal('register')}
                >
                  Create free account
                </button>
                <a className="btn btn-ghost btn-lg" href="#desk">
                  View live markets
                </a>
              </>
            )}
          </div>

          <div className="hero-points">
            <span className="hero-point">
              <IconCheck size={15} />
              {ksh(config.demoStartingBalance, true)} demo account on sign-up
            </span>
            <span className="hero-point">
              <IconBolt size={15} />
              Instant M-Pesa deposits
            </span>
            <span className="hero-point">
              <IconShield size={15} />
              Browse the markets without an account
            </span>
          </div>
        </div>

        <div className="hero-stats">
          <div className="stat-tile">
            <div className="label">Payout</div>
            <div className="value tnum">{Math.round(config.payoutRate * 100)}%</div>
          </div>
          <div className="stat-tile">
            <div className="label">Fastest trade</div>
            <div className="value tnum">{config.durations[0] ?? 5}s</div>
          </div>
          <div className="stat-tile">
            <div className="label">Traders online</div>
            <div className="value tnum">{Math.max(online, stats.online)}</div>
          </div>
          <div className="stat-tile">
            <div className="label">Volume today</div>
            <div className="value tnum">{kshShort(stats.volumeToday)}</div>
          </div>
        </div>
      </div>
    </section>
  );
}
