import { useApp } from '../store/app';

/**
 * Market switcher.
 *
 * The five indices differ in one property — how fast price moves — and the odds
 * are deliberately identical across them, because each one's multiplier scales
 * inversely with its volatility. So this shows tempo, not an edge: a trader
 * picks the pace they can actually read inside a five-second expiry, and the
 * label says exactly that rather than implying one market pays better.
 */
export function MarketPicker(): JSX.Element {
  const { instruments, symbol, setSymbol, price, config } = useApp();

  // Before the first poll lands, fall back to the config's list so the strip
  // renders its markets immediately rather than appearing a moment later.
  const markets = instruments.length
    ? instruments
    : config.instruments.map((i) => ({
        ...i, price: 0, change: 0, changePct: 0, dayOpen: 0,
      }));

  if (markets.length < 2) return <></>;

  return (
    <div className="markets" role="tablist" aria-label="Market">
      {markets.map((m) => {
        const active = m.symbol === symbol;
        // The selected market streams over the socket; the rest are polled, so
        // the live value is the fresher of the two for the one on screen.
        const shown = active && price > 0 ? price : m.price;
        const up = m.changePct >= 0;
        return (
          <button
            key={m.symbol}
            role="tab"
            aria-selected={active}
            className={'mk' + (active ? ' is-active' : '')}
            onClick={() => setSymbol(m.symbol)}
          >
            <span className="mk-top">
              <span className="mk-sym">{m.symbol}</span>
              <span className={'mk-chg tnum ' + (up ? 'up' : 'down')}>
                {up ? '+' : '−'}
                {Math.abs(m.changePct).toFixed(2)}%
              </span>
            </span>
            <span className="mk-px tnum">
              {shown > 0 ? shown.toFixed(m.precision) : '—'}
            </span>
            <span className="mk-name">Volatility {m.volatility}</span>
          </button>
        );
      })}
    </div>
  );
}
