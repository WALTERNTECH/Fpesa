import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ColorType,
  CrosshairMode,
  LineStyle,
  createChart,
  type CandlestickData,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type LineData,
  type UTCTimestamp,
} from 'lightweight-charts';
import { api } from '../lib/api';
import { marketSocket } from '../lib/ws';
import { useApp } from '../store/app';
import { price as fmtPrice } from '../lib/format';
import type { Candle, Timeframe } from '../lib/types';

const TIMEFRAMES: Array<{ id: Timeframe; label: string; seconds: number }> = [
  { id: '1s', label: '1s', seconds: 1 },
  { id: '5s', label: '5s', seconds: 5 },
  { id: '15s', label: '15s', seconds: 15 },
  { id: '1m', label: '1m', seconds: 60 },
  { id: '5m', label: '5m', seconds: 300 },
];

type ViewMode = 'candles' | 'area';

export function PriceChart(): JSX.Element {
  const { price, tickDir, quote, openTrades, connected } = useApp();
  const [timeframe, setTimeframe] = useState<Timeframe>('5s');
  const [view, setView] = useState<ViewMode>('candles');

  const boxRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const areaRef = useRef<ISeriesApi<'Area'> | null>(null);
  const barRef = useRef<Candle | null>(null);
  const linesRef = useRef<Map<string, IPriceLine>>(new Map());

  const stepSeconds = useMemo(
    () => TIMEFRAMES.find((t) => t.id === timeframe)?.seconds ?? 5,
    [timeframe]
  );

  // ------------------------------------------------------------ create chart
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;

    const chart = createChart(box, {
      layout: {
        background: { type: ColorType.Solid, color: '#ffffff' },
        textColor: '#5a6478',
        fontFamily: "'Inter', system-ui, sans-serif",
        fontSize: 11,
      },
      grid: {
        vertLines: { color: 'rgba(10, 13, 20, 0.045)' },
        horzLines: { color: 'rgba(10, 13, 20, 0.045)' },
      },
      rightPriceScale: {
        borderColor: 'rgba(10, 13, 20, 0.08)',
        scaleMargins: { top: 0.12, bottom: 0.12 },
      },
      timeScale: {
        borderColor: 'rgba(10, 13, 20, 0.08)',
        timeVisible: true,
        secondsVisible: true,
        rightOffset: 6,
        barSpacing: 8,
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: {
          color: 'rgba(11, 79, 216, 0.4)',
          style: LineStyle.Dashed,
          labelBackgroundColor: '#0b4fd8',
        },
        horzLine: {
          color: 'rgba(11, 79, 216, 0.4)',
          style: LineStyle.Dashed,
          labelBackgroundColor: '#0b4fd8',
        },
      },
      handleScale: { axisPressedMouseMove: { time: true, price: false } },
      autoSize: true,
    });

    chartRef.current = chart;

    candleRef.current = chart.addCandlestickSeries({
      upColor: '#00a870',
      downColor: '#e5384a',
      borderUpColor: '#00a870',
      borderDownColor: '#e5384a',
      wickUpColor: 'rgba(0, 168, 112, 0.6)',
      wickDownColor: 'rgba(229, 56, 74, 0.6)',
      priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
    });

    areaRef.current = chart.addAreaSeries({
      lineColor: '#0b4fd8',
      lineWidth: 2,
      topColor: 'rgba(11, 79, 216, 0.22)',
      bottomColor: 'rgba(11, 79, 216, 0.01)',
      priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
      visible: false,
    });

    return () => {
      linesRef.current.clear();
      chart.remove();
      chartRef.current = null;
      candleRef.current = null;
      areaRef.current = null;
    };
  }, []);

  // ------------------------------------------------------------- swap views
  useEffect(() => {
    candleRef.current?.applyOptions({ visible: view === 'candles' });
    areaRef.current?.applyOptions({ visible: view === 'area' });
  }, [view]);

  // -------------------------------------------------------- load timeframe
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const res = await api.get<{ candles: Candle[] }>('/market/candles?tf=' + timeframe);
        if (cancelled) return;

        const bars: CandlestickData[] = res.candles.map((c) => ({
          time: c.time as UTCTimestamp,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
        }));
        const line: LineData[] = res.candles.map((c) => ({
          time: c.time as UTCTimestamp,
          value: c.close,
        }));

        candleRef.current?.setData(bars);
        areaRef.current?.setData(line);
        barRef.current = res.candles[res.candles.length - 1] ?? null;
        chartRef.current?.timeScale().scrollToRealTime();
      } catch {
        // Leave whatever is already plotted rather than blanking the chart.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [timeframe]);

  // ------------------------------------------------- fold ticks into the bar
  useEffect(() => {
    return marketSocket.on((msg) => {
      if (msg.type !== 'tick') return;
      const bucket = Math.floor(msg.ts / 1000 / stepSeconds) * stepSeconds;
      const current = barRef.current;

      const next: Candle =
        current && current.time === bucket
          ? {
              time: bucket,
              open: current.open,
              high: Math.max(current.high, msg.price),
              low: Math.min(current.low, msg.price),
              close: msg.price,
            }
          : {
              time: bucket,
              open: current ? current.close : msg.price,
              high: msg.price,
              low: msg.price,
              close: msg.price,
            };

      barRef.current = next;
      candleRef.current?.update({
        time: next.time as UTCTimestamp,
        open: next.open,
        high: next.high,
        low: next.low,
        close: next.close,
      });
      areaRef.current?.update({ time: next.time as UTCTimestamp, value: next.close });
    });
  }, [stepSeconds]);

  // ------------------------------------------- entry markers for live trades
  useEffect(() => {
    const series = view === 'candles' ? candleRef.current : areaRef.current;
    if (!series) return;
    const lines = linesRef.current;

    const wanted = new Set(openTrades.map((t) => t.id));
    for (const [id, line] of lines) {
      if (!wanted.has(id)) {
        try {
          series.removePriceLine(line);
        } catch {
          // Series may already have dropped it during a view swap.
        }
        lines.delete(id);
      }
    }

    for (const trade of openTrades) {
      if (lines.has(trade.id)) continue;
      const line = series.createPriceLine({
        price: trade.entryPrice,
        color: trade.direction === 'BUY' ? '#00a870' : '#e5384a',
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: trade.direction + ' ' + trade.stake,
      });
      lines.set(trade.id, line);
    }
  }, [openTrades, view]);

  const change = quote ? price - quote.dayOpen : 0;
  const changePct = quote && quote.dayOpen ? (change / quote.dayOpen) * 100 : 0;
  const up = change >= 0;

  return (
    <div className="card chart-card">
      <div className="chart-head">
        <div className="chart-ident">
          <span className="chart-badge" aria-hidden="true">
            🥇
          </span>
          <div>
            <div className="name">XAU/USD</div>
            <div className="desc">Gold Spot · US Dollar</div>
          </div>
        </div>

        <div className="chart-price">
          <span className={'live tnum' + (tickDir ? ' tick-' + tickDir : '')}>
            {fmtPrice(price)}
          </span>
          <span className={'chg tnum ' + (up ? 'up' : 'down')}>
            {up ? '+' : '−'}
            {Math.abs(change).toFixed(2)} ({up ? '+' : '−'}
            {Math.abs(changePct).toFixed(2)}%)
          </span>
        </div>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <div className="tf-switch" role="group" aria-label="Chart type">
            <button
              onClick={() => setView('candles')}
              aria-pressed={view === 'candles'}
            >
              Candles
            </button>
            <button onClick={() => setView('area')} aria-pressed={view === 'area'}>
              Area
            </button>
          </div>
          <div className="tf-switch" role="group" aria-label="Timeframe">
            {TIMEFRAMES.map((tf) => (
              <button
                key={tf.id}
                onClick={() => setTimeframe(tf.id)}
                aria-pressed={timeframe === tf.id}
              >
                {tf.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="chart-canvas" ref={boxRef} />

      <div className="feed-note">
        <span className={'feed-dot' + (connected ? '' : ' stale')} />
        {connected
          ? 'Live feed connected · streaming XAU/USD'
          : 'Reconnecting to the market feed…'}
      </div>
    </div>
  );
}
