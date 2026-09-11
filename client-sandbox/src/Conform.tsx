import { useCallback, useEffect, useState } from 'react';

type Cmp = { production: number; sandbox: number; delta: number; match: boolean };

type Result = {
  source: string;
  symbol: string;
  stake: number;
  durationSec: number;
  live: {
    price: number;
    precision: number;
    multiplier: number;
    houseEdge: number;
    maxProfitMultiple: number;
    sigma: number;
  };
  parameters: Record<string, { production: number; sandbox: number; match: boolean }>;
  parametersMatch: boolean;
  proposal: {
    BUY: { entry: number; stopOut: number; takeProfit: number };
    SELL: { entry: number; stopOut: number; takeProfit: number };
    maxProfit: number;
    maxLoss: number;
  };
  margins: Record<string, Cmp>;
  arithmeticMatch: boolean;
};

const LABEL: Record<string, string> = {
  multiplier: 'Position multiplier',
  spreadCost: 'Spread cost',
  breakevenMovePct: 'Breakeven move %',
  typicalMovePct: 'Typical move %',
  stopOutMovePct: 'Stop-out move %',
  winProbability: 'Win probability %',
  stopOutProbability: 'Stop-out probability %',
  expectedResult: 'Expected result',
  maxProfit: 'Max profit',
  maxLoss: 'Max loss',
};

const nf = new Intl.NumberFormat('en-KE', { maximumFractionDigits: 6 });

async function get<T>(path: string): Promise<T> {
  const res = await fetch('/api/sandbox' + path, { credentials: 'same-origin' });
  const text = await res.text();
  const data = text ? (JSON.parse(text) as unknown) : null;
  if (!res.ok) throw new Error((data as { message?: string } | null)?.message ?? 'Request failed.');
  return data as T;
}

/**
 * Pre-flight: would this sandbox quote a different contract from production?
 *
 * Everything a contract proposal is made of is published — the mid, the
 * multiplier, the edge, sigma, the profit cap — so the check is a straight diff
 * against production's own published figures for the same ticket. The seed is
 * not one of those inputs: it decides which path is realised, while a margin is
 * a property of the distribution. Substituting one for the other would not make
 * this more accurate, it would answer a different question.
 */
export function Conform({ symbol }: { symbol: string | null }): JSX.Element {
  const [stake, setStake] = useState(1000);
  const [durationSec, setDurationSec] = useState(10);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = useCallback(() => {
    if (!symbol) return;
    setBusy(true);
    void get<Result>(
      '/conform?symbol=' + encodeURIComponent(symbol) +
      '&stake=' + stake + '&durationSec=' + durationSec
    )
      .then((r) => {
        setResult(r);
        setError(null);
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setBusy(false));
  }, [symbol, stake, durationSec]);

  useEffect(() => {
    run();
    // Re-checks when the market changes; the button covers the other inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol]);

  const ok = result?.arithmeticMatch && result?.parametersMatch;

  return (
    <>
      <section className="grid-sec">
        <h2>
          Contract conformance
          {result && (
            <span className={'chip ' + (ok ? 'ok' : 'off')}>
              {ok ? 'identical to production' : 'DIFFERS FROM PRODUCTION'}
            </span>
          )}
        </h2>
        <p className="note" style={{ marginTop: 0 }}>
          Takes production&rsquo;s live mid and its published parameters, prices
          the same ticket through this sandbox&rsquo;s own code, and diffs the
          result against the margin figures production publishes for that ticket
          on <code>/api/market/analyse</code>. Every input to a contract proposal
          — mid, multiplier, edge, σ, profit cap — is public, which is why this
          needs no seed: the seed decides which path is <em>realised</em>, and a
          margin is a property of the <em>distribution</em>.
        </p>

        <div className="knobs">
          <label>
            <span className="k">Stake</span>
            <input
              type="number" min={1} step={100}
              value={stake}
              onChange={(e) => setStake(Number(e.target.value))}
            />
            <small>the ticket being quoted</small>
          </label>
          <label>
            <span className="k">Duration</span>
            <div className="durs">
              {[5, 10, 15, 30, 60].map((d) => (
                <button key={d} aria-pressed={d === durationSec} onClick={() => setDurationSec(d)}>
                  {d}s
                </button>
              ))}
            </div>
          </label>
        </div>
        <button className="btn primary" onClick={run} disabled={busy || !symbol}>
          {busy ? 'Checking…' : 'Check against production'}
        </button>
        {error && <div className="err" style={{ marginTop: 10 }}>{error}</div>}
      </section>

      {result && (
        <>
          <section className="grid-sec">
            <h2>
              The contract this would quote
              <span className="tally">
                at production&rsquo;s live mid of {nf.format(result.live.price)}
              </span>
            </h2>
            <div className="scroll">
              <table className="plays">
                <thead>
                  <tr>
                    <th>Side</th>
                    <th>Entry</th>
                    <th>Stop-out</th>
                    <th>Take-profit</th>
                    <th>Max profit</th>
                    <th>Max loss</th>
                  </tr>
                </thead>
                <tbody>
                  {(['BUY', 'SELL'] as const).map((side) => (
                    <tr key={side}>
                      <td className={'side ' + side.toLowerCase()}>{side}</td>
                      <td>{nf.format(result.proposal[side].entry)}</td>
                      <td className="down">{nf.format(result.proposal[side].stopOut)}</td>
                      <td className="up">{nf.format(result.proposal[side].takeProfit)}</td>
                      <td>{nf.format(result.proposal.maxProfit)}</td>
                      <td>{nf.format(result.proposal.maxLoss)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {/* Two kinds of agreement, separated because they fail for different
              reasons: the code drifting, and the deployment drifting. */}
          <section className="grid-sec">
            <h2>
              Parameters
              <span className={'chip ' + (result.parametersMatch ? 'ok' : 'off')}>
                {result.parametersMatch ? 'same settings' : 'settings differ'}
              </span>
            </h2>
            <div className="scroll">
              <table className="plays">
                <thead>
                  <tr>
                    <th>Setting</th>
                    <th>Production</th>
                    <th>This sandbox</th>
                    <th>&nbsp;</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(result.parameters).map(([k, v]) => (
                    <tr key={k}>
                      <td>{k}</td>
                      <td>{nf.format(v.production)}</td>
                      <td>{nf.format(v.sandbox)}</td>
                      <td className={v.match ? 'up' : 'down'}>{v.match ? 'match' : 'differs'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="note">
              A mismatch here means the sandbox is faithfully pricing a different
              product — the deployment has drifted, not the code.
            </p>
          </section>

          <section className="grid-sec">
            <h2>
              Risk and reward, field by field
              <span className={'chip ' + (result.arithmeticMatch ? 'ok' : 'off')}>
                {result.arithmeticMatch ? 'exact to the last decimal' : 'arithmetic differs'}
              </span>
            </h2>
            <div className="scroll">
              <table className="plays">
                <thead>
                  <tr>
                    <th>Figure</th>
                    <th>Production says</th>
                    <th>Sandbox computes</th>
                    <th>Difference</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(result.margins).map(([k, v]) => (
                    <tr key={k}>
                      <td>{LABEL[k] ?? k}</td>
                      <td>{nf.format(v.production)}</td>
                      <td>{nf.format(v.sandbox)}</td>
                      <td className={v.match ? 'muted' : 'down'}>
                        {v.match ? '—' : nf.format(v.delta)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="note">
              Both columns are computed on production&rsquo;s parameters, so a
              difference here is the code, not the configuration. This is a
              stronger pre-flight check than comparing one realised outcome
              would be: it tests the arithmetic that prices every contract,
              rather than what happened to a single trade.
            </p>
          </section>
        </>
      )}
    </>
  );
}
