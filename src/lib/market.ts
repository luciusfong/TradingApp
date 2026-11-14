import { httpGet } from './http';

export interface Quote {
  symbol: string;
  price: number;
  prevClose: number;
  change: number;
  changePct: number;
  time: number; // ms epoch of last trade
  name?: string;
  source: 'finnhub' | 'yahoo';
}

export interface Series { t: number[]; c: number[]; prevClose?: number }

export type Range = '1D' | '5D' | '1M' | '6M' | '1Y';
const RANGE: Record<Range, { range: string; interval: string }> = {
  '1D': { range: '1d', interval: '5m' },
  '5D': { range: '5d', interval: '30m' },
  '1M': { range: '1mo', interval: '1d' },
  '6M': { range: '6mo', interval: '1d' },
  '1Y': { range: '1y', interval: '1d' },
};

const yahooUrl = (symbol: string, range: string, interval: string) =>
  `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}&includePrePost=false`;

// Pure parsers are exported so they can be unit-tested against sample payloads.
export function parseYahooChart(data: any): { series: Series; meta: any } {
  const r = data?.chart?.result?.[0];
  if (!r) throw new Error(data?.chart?.error?.description || 'No chart data for this symbol.');
  const ts: number[] = r.timestamp ?? [];
  const close: (number | null)[] = r.indicators?.quote?.[0]?.close ?? [];
  const t: number[] = [];
  const c: number[] = [];
  for (let i = 0; i < ts.length; i++) {
    const v = close[i];
    if (typeof v === 'number' && isFinite(v)) { t.push(ts[i] * 1000); c.push(v); }
  }
  return { series: { t, c, prevClose: r.meta?.chartPreviousClose ?? r.meta?.previousClose }, meta: r.meta ?? {} };
}

export function parseYahooQuote(symbol: string, data: any): Quote {
  const { series, meta } = parseYahooChart(data);
  const price = Number(meta.regularMarketPrice ?? series.c[series.c.length - 1]);
  const prevClose = Number(meta.chartPreviousClose ?? meta.previousClose ?? price);
  if (!isFinite(price)) throw new Error('No price for this symbol.');
  const change = price - prevClose;
  return {
    symbol,
    price,
    prevClose,
    change,
    changePct: prevClose ? (change / prevClose) * 100 : 0,
    time: (meta.regularMarketTime ? meta.regularMarketTime * 1000 : series.t[series.t.length - 1]) || Date.now(),
    name: meta.shortName || meta.longName,
    source: 'yahoo',
  };
}

export function parseFinnhubQuote(symbol: string, d: any): Quote {
  if (!d || typeof d.c !== 'number' || (d.c === 0 && d.pc === 0)) throw new Error('Not found. Check the ticker symbol.');
  return {
    symbol,
    price: d.c,
    prevClose: d.pc,
    change: d.d ?? d.c - d.pc,
    changePct: d.dp ?? (d.pc ? ((d.c - d.pc) / d.pc) * 100 : 0),
    time: (d.t || 0) * 1000 || Date.now(),
    source: 'finnhub',
  };
}

export async function getQuote(symbol: string, finnhubKey: string): Promise<Quote> {
  if (finnhubKey) {
    try {
      const d = await httpGet(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${encodeURIComponent(finnhubKey)}`, 'json');
      return parseFinnhubQuote(symbol, d);
    } catch {
      // fall through to the keyless source
    }
  }
  return parseYahooQuote(symbol, await httpGet(yahooUrl(symbol, '1d', '5m'), 'json'));
}

export async function getSeries(symbol: string, range: Range): Promise<Series> {
  const r = RANGE[range];
  const { series } = parseYahooChart(await httpGet(yahooUrl(symbol, r.range, r.interval), 'json'));
  if (series.c.length < 2) throw new Error('Not enough price history to draw a chart.');
  if (range !== '1D') delete series.prevClose;
  return series;
}

export async function lookupName(symbol: string, finnhubKey: string): Promise<string | undefined> {
  if (!finnhubKey) return undefined;
  try {
    const d = await httpGet(`https://finnhub.io/api/v1/stock/profile2?symbol=${encodeURIComponent(symbol)}&token=${encodeURIComponent(finnhubKey)}`, 'json');
    return d?.name || undefined;
  } catch {
    return undefined;
  }
}
