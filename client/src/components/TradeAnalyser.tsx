import { useEffect, useState } from 'react';
import { useApp } from '../store/app';
import { api } from '../lib/api';
import { ksh } from '../lib/format';
import { IconChart } from './Icons';

type Analysis = {
  stake: number;
  durationSec: number;
  multiplier: number;
  spreadCost: number;
  breakevenMovePct: number;
  typicalMovePct: number;
  stopOutMovePct: number;
  winProbability: number;
  stopOutProbability: number;
  expectedResult: number;
  maxProfit: number;
  maxLoss: number;
  edge: 'none';
  notes: string[];
};

/**
 * Reads the trader's current ticket and reports the exact odds and costs of it.
 *
 * Everything shown is closed-form, not estimated, because the instrument is a
 * driftless walk with known volatility. That is also why there is no Buy/Sell
 * call: on this series direction is a coin flip, and printing one next to a
 * confidence figure would be inventing a reason to trade.
 */
export function TradeAnalyser(): JSX.Element {
  const { stake, duration, config } = useApp();
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<Analysis | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const amount = Number(stake);
  const usable =
    Number.isFinite(amount) && amount >= config.minStake && amount <= config.maxStake;

  // Re-run whenever the ticket changes, so an open panel never describes a
  // trade the trader has already moved away from.
  useEffect(() => {
    if (!open || !usable) return;
    let cancelled = false;
    setBusy(true);
    void (async () => {
      try {
        const res = await api.get<Analysis>(
          '/market/analyse?stake=' + amount + '&durationSec=' + duration
        );
        if (!cancelled) {
          setData(res);
          setError(null);
        }
      } catch {
        if (!cancelled) setError('Could not analyse that ticket.');
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, usable, amount, duration]);

  return (
    <div className="analyser">
      <button
        className="analyser-btn"
        onClick={() => setOpen((v) => !v)}
        disabled={!usable}
        aria-expanded={open}
      >
        <IconChart size={15} />
        {open ? 'Hide analysis' : 'Analyse this trade'}
      </button>

      {open && (
        <div className="analyser-body">
          {error && <div className="panel-error" style={{ marginTop: 0 }}>{error}</div>}
          {busy && !data && <div className="analyser-note">Working…</div>}

          {data && (
            <>
              <div className="analyser-verdict">
                <span className="k">Direction</span>
                <span className="v">No edge either way</span>
              </div>

              <div className="analyser-rows">
                <div className="ar">
                  <span>Chance this finishes in profit</span>
                  <b className={data.winProbability >= 50 ? 'up' : 'down'}>
                    {data.winProbability.toFixed(1)}%
                  </b>
                </div>
                <div className="ar">
                  <span>Chance of being wiped out early</span>
                  <b className="down">{data.stopOutProbability.toFixed(2)}%</b>
                </div>
                <div className="ar">
                  <span>Cost to open (spread)</span>
                  <b className="down">−{ksh(data.spreadCost)}</b>
                </div>
                <div className="ar">
                  <span>Average result over many trades</span>
                  <b className={data.expectedResult >= 0 ? 'up' : 'down'}>
                    {data.expectedResult >= 0 ? '+' : '−'}
                    {ksh(Math.abs(data.expectedResult))}
                  </b>
                </div>
                <div className="ar">
                  <span>Move needed just to break even</span>
                  <b>{data.breakevenMovePct.toFixed(4)}%</b>
                </div>
                <div className="ar">
                  <span>Typical move over {data.durationSec}s</span>
                  <b>{data.typicalMovePct.toFixed(4)}%</b>
                </div>
                <div className="ar">
                  <span>Most you can win / lose</span>
                  <b>
                    {ksh(data.maxProfit, true)} / {ksh(data.maxLoss, true)}
                  </b>
                </div>
              </div>

              {data.notes.map((n, i) => (
                <p className="analyser-note" key={i}>
                  {n}
                </p>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}
