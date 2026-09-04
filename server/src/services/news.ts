import Parser from 'rss-parser';

export type NewsItem = {
  id: string;
  title: string;
  link: string;
  source: string;
  publishedAt: string;
};

const parser = new Parser({
  timeout: 8000,
  headers: {
    'User-Agent':
      'Mozilla/5.0 (compatible; FpesaNewsBot/1.0; +https://github.com/WALTERNTECH/Fpesa)',
  },
});

const FEEDS: Array<{ url: string; source: string }> = [
  { url: 'https://www.forexlive.com/feed/news', source: 'ForexLive' },
  { url: 'https://www.fxstreet.com/rss/news', source: 'FXStreet' },
  { url: 'https://www.investing.com/rss/news_1.rss', source: 'Investing.com' },
  { url: 'https://feeds.marketwatch.com/marketwatch/marketpulse/', source: 'MarketWatch' },
  { url: 'https://www.cnbc.com/id/20910258/device/rss/rss.html', source: 'CNBC FX' },
];

const CACHE_MS = 5 * 60 * 1000;
const MAX_ITEMS = 30;

let cache: NewsItem[] = [];
let cachedAt = 0;
let inFlight: Promise<NewsItem[]> | null = null;

/** Shown only if every upstream feed is unreachable, so the strip is never blank. */
const FALLBACK: NewsItem[] = [
  {
    id: 'fallback-1',
    title: 'Gold holds firm as traders weigh the next central bank move',
    link: 'https://www.forexlive.com/',
    source: 'Market Desk',
    publishedAt: new Date().toISOString(),
  },
  {
    id: 'fallback-2',
    title: 'Dollar steadies against majors ahead of key economic data',
    link: 'https://www.fxstreet.com/',
    source: 'Market Desk',
    publishedAt: new Date().toISOString(),
  },
  {
    id: 'fallback-3',
    title: 'XAU/USD volatility picks up through the London session',
    link: 'https://www.investing.com/',
    source: 'Market Desk',
    publishedAt: new Date().toISOString(),
  },
];

function slug(input: string): string {
  let h = 0;
  for (let i = 0; i < input.length; i++) {
    h = (h << 5) - h + input.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h).toString(36);
}

async function fetchFeed(feed: { url: string; source: string }): Promise<NewsItem[]> {
  try {
    const parsed = await parser.parseURL(feed.url);
    return (parsed.items ?? [])
      .filter((i) => i.title && i.link)
      .slice(0, 12)
      .map((i) => ({
        id: slug(feed.source + (i.link ?? i.title ?? '')),
        title: (i.title ?? '').replace(/\s+/g, ' ').trim(),
        link: i.link ?? '',
        source: feed.source,
        publishedAt: i.isoDate ?? i.pubDate ?? new Date().toISOString(),
      }));
  } catch {
    return [];
  }
}

async function refresh(): Promise<NewsItem[]> {
  const results = await Promise.all(FEEDS.map(fetchFeed));
  const merged = results.flat();

  const seen = new Set<string>();
  const deduped = merged.filter((item) => {
    const key = item.title.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  deduped.sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
  const items = deduped.slice(0, MAX_ITEMS);

  if (items.length > 0) {
    cache = items;
    cachedAt = Date.now();
  } else if (cache.length === 0) {
    cache = FALLBACK;
    cachedAt = Date.now();
  }
  return cache;
}

export async function getNews(): Promise<NewsItem[]> {
  if (cache.length > 0 && Date.now() - cachedAt < CACHE_MS) return cache;
  // Collapse concurrent misses into a single upstream pass.
  if (!inFlight) {
    inFlight = refresh().finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}

/** Warms the cache at boot so the first visitor does not wait on RSS. */
export function primeNews(): void {
  void getNews().then((items) => {
    console.log('[news] primed with ' + items.length + ' headline(s)');
  });
  setInterval(() => void refresh(), CACHE_MS);
}
