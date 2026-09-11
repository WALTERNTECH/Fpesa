import { useCallback, useEffect, useState } from 'react';

type Stress = {
  input: {
    cash: number;
    operatorFloat: number;
    owed: number;
    atRisk: number;
    positionShare: number;
    maxProfitMultiple: number;
    stake: number;
  };
  headroom: number;
  maxLiveStake: number;
  perPosition: { stake: number; maxProfit: number; headroomCost: number };
  sequence: Array<{
    n: number;
    headroomBefore: number;
    admitted: boolean;
    refusedBecause: string | null;
    headroomAfter: number;
  }>;
  capacity: { positions: number; totalStake: number; totalMaxPayout: number };
  correlatedWin: {
    positions: number;
    paidInProfit: number;
    stakesReturned: number;
    owedAfter: number;
    cashPlusFloat: number;
    headroomAfter: number;
    solvent: boolean;
    shortfall: number;
  };
};

const nf = new Intl.NumberFormat('en-KE', { maximumFractionDigits: 2 });
const ksh = (n: number): string => 'KSh ' + nf.format(Number.isFinite(n) ? n : 0);

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch('/api/sandbox' + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    credentials: 'same-origin',
  });
  const text = await res.text();
  const data = text ? (JSON.parse(text) as unknown) : null;
  if (!res.ok) throw new Error((data as { message?: string } | null)?.message ?? 'Request failed.');
  return data as T;
}

/**
 * What a large position actually competes for on this platform.
 *
 * There is no order book here, so nothing queues and no depth gets consumed.
 * The only scarce thing a position takes is the book's capacity to pay it, and
 * that capacity is exact arithmetic rather than something to sample from a live
 * feed — which is why this screen has numbers on it and no chart.
 */
export function Book(): JSX.Element {
  // Illustrative, not live. The sandbox has no database and cannot read the real
  // book; take the true figures off the console's float panel and type them in.
  const [cash, setCash] = useState(150000);
  const [operatorFloat, setOperatorFloat] = useState(50000);
  const [owed, setOwed] = useState(120000);
  const [atRisk, setAtRisk] = useState(0);
  const [positionShare, setPositionShare] = useState(0.25);
  const [maxProfitMultiple, setMaxProfitMultiple] = useState(3);
  const [stake, setStake] = useState(1000);

  const [result, setResult] = useState<Stress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = useCallback(() => {
    setBusy(true);
    void post<Stress>('/book', {
      cash, operatorFloat, owed, atRisk, positionShare, maxProfitMultiple, stake,
    })
      .then((r) => {
        setResult(r);
        setError(null);
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setBusy(false));
  }, [cash, operatorFloat, owed, atRisk, positionShare, maxProfitMultiple, stake]);

  useEffect(() => {
    run();
    // First load only; after that the button drives it, so typing a figure does
    // not fire a request per keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const field = (
    label: string,
    value: number,
    set: (n: number) => void,
    hint: string,
    step = 1000
  ): JSX.Element => (
    <label key={label}>
      <span className="k">{label}</span>
      <input
        type="number"
        value={value}
        step={step}
        onChange={(e) => set(Number(e.target.value))}
      />
      <small>{hint}</small>
    </label>
  );

  const refusal = result?.sequence.find((s) => !s.admitted) ?? null;
  const shown = result?.sequence.filter((s) => s.admitted).slice(0, 6) ?? [];

  return (
    <>
      <section className="grid-sec">
        <h2>Book stress</h2>
        <p className="note" style={{ marginTop: 0 }}>
          Fpesa has no order book, so a large position does not slice through
          liquidity — there is none to slice. What it competes for is the
          book&rsquo;s capacity to pay it, which{' '}
          <code>fpesa_book_float</code> defines exactly:
          <br />
          <code>headroom = cash + operatorFloat − owed − atRisk</code>, where{' '}
          <code>atRisk</code> is the sum of <code>stake + max_profit</code> over
          every open real position, and <code>fpesa_place_trade</code> admits a
          position only when <code>headroom × share ≥ maxProfit</code>.
        </p>

        <div className="knobs">
          {field('Cash', cash, setCash, 'deposits − withdrawals ± adjustments')}
          {field('Operator float', operatorFloat, setOperatorFloat, 'the B2C payout wallet')}
          {field('Owed to users', owed, setOwed, 'every real balance, summed')}
          {field('Already at risk', atRisk, setAtRisk, 'open positions: stake + max profit')}
          {field('Position share', positionShare, setPositionShare, 'MAX_POSITION_SHARE', 0.05)}
          {field('Profit cap ×', maxProfitMultiple, setMaxProfitMultiple, 'TRADE_MAX_PROFIT_MULTIPLE', 0.5)}
          {field('Stake per position', stake, setStake, 'the ticket being tested', 100)}
        </div>
        <button className="btn primary" onClick={run} disabled={busy}>
          {busy ? 'Working…' : 'Stress the book'}
        </button>
        {error && <div className="err" style={{ marginTop: 10 }}>{error}</div>}
      </section>

      {result && (
        <>
          <section className="grid-sec">
            <div className="book-top">
              <div>
                <div className="k">Headroom</div>
                <div className="book-v">{ksh(result.headroom)}</div>
              </div>
              <div>
                <div className="k">Largest single position</div>
                <div className="book-v">{ksh(result.maxLiveStake)}</div>
              </div>
              <div>
                <div className="k">This ticket costs</div>
                <div className="book-v">{ksh(result.perPosition.headroomCost)}</div>
                <small className="muted">of headroom, per position</small>
              </div>
            </div>
            {/* The cancellation that makes the guard sound, spelled out: the
                stake leaves the trader's balance as it enters the book, so only
                the profit ceiling is genuinely new exposure. */}
            <p className="note">
              Opening this position debits {ksh(result.perPosition.stake)} from
              the trader — so <code>owed</code> falls by that much — while{' '}
              <code>atRisk</code> rises by stake plus{' '}
              {ksh(result.perPosition.maxProfit)} of possible profit. The stakes
              cancel, and headroom falls by exactly the profit ceiling:{' '}
              {ksh(result.perPosition.headroomCost)}.
            </p>
          </section>

          <section className="grid-sec">
            <h2>
              How many of these the book carries
              <span className="tally">
                {result.capacity.positions} concurrent ·{' '}
                {ksh(result.capacity.totalMaxPayout)} of exposure
              </span>
            </h2>
            <div className="scroll">
              <table className="plays">
                <thead>
                  <tr>
                    <th>Position</th>
                    <th>Headroom before</th>
                    <th>Admitted?</th>
                    <th>Headroom after</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((s) => (
                    <tr key={s.n}>
                      <td>#{s.n}</td>
                      <td>{ksh(s.headroomBefore)}</td>
                      <td className="up">yes</td>
                      <td>{ksh(s.headroomAfter)}</td>
                    </tr>
                  ))}
                  {result.capacity.positions > shown.length && (
                    <tr>
                      <td colSpan={4} className="muted">
                        … {result.capacity.positions - shown.length} more admitted
                      </td>
                    </tr>
                  )}
                  {refusal && (
                    <tr>
                      <td>#{result.capacity.positions + 1}</td>
                      <td>{ksh(refusal.headroomBefore)}</td>
                      <td className="down">refused</td>
                      <td className="reason">{refusal.refusedBecause}</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>

          {/* Scenario 3, answered by arithmetic rather than by watching a crisis. */}
          <section className="grid-sec">
            <h2>
              The black swan: every open position wins at its cap, at once
              <span className={'chip ' + (result.correlatedWin.solvent ? 'ok' : 'off')}>
                {result.correlatedWin.solvent ? 'solvent' : 'SHORTFALL ' + ksh(result.correlatedWin.shortfall)}
              </span>
            </h2>
            <div className="scroll">
              <table className="plays cmp">
                <tbody>
                  <tr>
                    <th scope="row">Positions open</th>
                    <td>{result.correlatedWin.positions}</td>
                  </tr>
                  <tr>
                    <th scope="row">Profit paid out</th>
                    <td className="down">{ksh(result.correlatedWin.paidInProfit)}</td>
                  </tr>
                  <tr>
                    <th scope="row">Stakes returned</th>
                    <td>{ksh(result.correlatedWin.stakesReturned)}</td>
                  </tr>
                  <tr>
                    <th scope="row">Owed to users afterwards</th>
                    <td>{ksh(result.correlatedWin.owedAfter)}</td>
                  </tr>
                  <tr>
                    <th scope="row">Cash + float available</th>
                    <td>{ksh(result.correlatedWin.cashPlusFloat)}</td>
                  </tr>
                  <tr className="worst-row">
                    <th scope="row">Headroom left standing</th>
                    <td className={result.correlatedWin.solvent ? 'up' : 'down'}>
                      {ksh(result.correlatedWin.headroomAfter)}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p className="note">
              This comes out solvent for every book you can type in here, and that
              is not luck. Each admitted position reserves its own worst case in
              full before it opens, so the total that could ever be paid is a sum
              the guard has already subtracted from headroom. A correlated
              blow-up is survivable by construction — there is no market
              condition, however extreme, that makes these positions cost more
              than their caps. What the guard cannot protect against is money
              that was never there: if <code>cash + float</code> is overstated
              because the payout wallet is emptier than the figure says, every
              number above is overstated with it.
            </p>
          </section>
        </>
      )}
    </>
  );
}
