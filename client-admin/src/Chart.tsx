import { useEffect, useRef } from 'react';
import {
  ColorType,
  CrosshairMode,
  LineStyle,
  createChart,
  type CandlestickData,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type UTCTimestamp,
} from 'lightweight-charts';

type Candle = { time: number; open: number; high: number; low: number; close: number };

export type Marker = {
  price: number;
  label: string;
  colour: string;
  dashed?: boolean;
};

/**
 * The same series the traders see, streamed from the trading service.
 *
 * The overlays are the operator's own book — where open positions sit and
 * where they get stopped out — not a forecast. Nothing drawn here says where
 * price is going, because on a driftless walk nothing knowable does.
 */
export function Chart({
  origin,
  markers,
}: {
  origin: string;
  markers: Marker[];
}): JSX.Element {
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const bar = useRef<Candle | null>(null);
  const lines = useRef<Map<string, IPriceLine>>(new Map());
  const socket = useRef<WebSocket | null>(null);

  useEffect(() => {
    const el = box.current;
    if (!el) return;

    const c = createChart(el, {
      layout: {
        background: { type: ColorType.Solid, color: '#ffffff' },
        textColor: '#5a6478',
        fontFamily: "'Inter', system-ui, sans-serif",
        fontSize: 11,
      },
      grid: {
        vertLines: { color: 'rgba(10,13,20,0.045)' },
        horzLines: { color: 'rgba(10,13,20,0.045)' },
      },
      rightPriceScale: { borderColor: 'rgba(10,13,20,0.08)' },
      timeScale: {
        borderColor: 'rgba(10,13,20,0.08)',
        timeVisible: true,
        secondsVisible: true,
        rightOffset: 5,
        barSpacing: 7,
      },
      crosshair: { mode: CrosshairMode.Normal },
      autoSize: true,
    });
    chart.current = c;
    series.current = c.addCandlestickSeries({
      upColor: '#00a870',
      downColor: '#e5384a',
      borderUpColor: '#00a870',
      borderDownColor: '#e5384a',
      wickUpColor: 'rgba(0,168,112,0.6)',
      wickDownColor: 'rgba(229,56,74,0.6)',
      priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
    });

    return () => {
      lines.current.clear();
      c.remove();
      chart.current = null;
      series.current = null;
    };
  }, []);

  // History, then the live tick stream, both from the trading service.
  useEffect(() => {
    if (!origin) return;
    let dead = false;

    void (async () => {
      try {
        const res = await fetch(origin + '/api/market/candles?tf=5s');
        if (!res.ok || dead) return;
        const body = (await res.json()) as { candles: Candle[] };
        series.current?.setData(
          body.candles.map((k) => ({
            time: k.time as UTCTimestamp,
            open: k.open, high: k.high, low: k.low, close: k.close,
          })) as CandlestickData[]
        );
        bar.current = body.candles[body.candles.length - 1] ?? null;
        chart.current?.timeScale().scrollToRealTime();
      } catch {
        // Leave the pane empty rather than throwing; the banner covers it.
      }
    })();

    const ws = new WebSocket(origin.replace(/^http/, 'ws') + '/ws');
    socket.current = ws;
    ws.onmessage = (ev) => {
      let msg: { type?: string; price?: number; ts?: number };
      try {
        msg = JSON.parse(ev.data as string) as typeof msg;
      } catch {
        return;
      }
      if (msg.type !== 'tick' || msg.price === undefined || msg.ts === undefined) return;

      const bucket = Math.floor(msg.ts / 1000 / 5) * 5;
      const prev = bar.current;
      const next: Candle =
        prev && prev.time === bucket
          ? {
              time: bucket,
              open: prev.open,
              high: Math.max(prev.high, msg.price),
              low: Math.min(prev.low, msg.price),
              close: msg.price,
            }
          : {
              time: bucket,
              open: prev ? prev.close : msg.price,
              high: msg.price, low: msg.price, close: msg.price,
            };
      bar.current = next;
      series.current?.update({
        time: next.time as UTCTimestamp,
        open: next.open, high: next.high, low: next.low, close: next.close,
      });
    };

    return () => {
      dead = true;
      ws.close();
      socket.current = null;
    };
  }, [origin]);

  // Book overlays — redrawn whenever the open positions change.
  useEffect(() => {
    const s = series.current;
    if (!s) return;
    for (const [, line] of lines.current) {
      try { s.removePriceLine(line); } catch { /* already gone */ }
    }
    lines.current.clear();
    for (const m of markers) {
      lines.current.set(
        m.label,
        s.createPriceLine({
          price: m.price,
          color: m.colour,
          lineWidth: 1,
          lineStyle: m.dashed ? LineStyle.Dotted : LineStyle.Dashed,
          axisLabelVisible: true,
          title: m.label,
        })
      );
    }
  }, [markers]);

  return <div className="chart" ref={box} />;
}
