import { httpGet } from './http';

export interface Quote {
  symbol: string;
  price: number;
  prevClose: number;
  change: number;
  changePct: number;
  time: number; // ms epoch of last trade
  name?: string;
  currency?: string; // the currency the price is quoted in, when the source says
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
    currency: typeof meta.currency === 'string' ? meta.currency : undefined,
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
    currency: 'USD', // Finnhub's quote feed is used for US listings only
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

// ---------- Local-currency view ----------

export interface Fx { rate: number; prev: number } // units of local currency per unit of the quote currency, now and at the previous close
export interface LocalPrice { price: number; change: number; changePct: number }

// A few exchanges quote in a hundredth of the currency (London in pence).
const MINOR: Record<string, [string, number]> = { GBp: ['GBP', 0.01], GBX: ['GBP', 0.01], ZAc: ['ZAR', 0.01], ILA: ['ILS', 0.01] };
export const majorCurrency = (c: string): [string, number] => MINOR[c] ?? [c, 1];
// Index levels are not prices, so they are never converted.
export const isIndexSymbol = (symbol: string) => /^\^|\.NYB$/.test(symbol);

const fxCache = new Map<string, { fx: Fx; at: number }>();
export async function getFx(from: string, to: string): Promise<Fx> {
  if (from === to) return { rate: 1, prev: 1 };
  const pair = `${from}${to}=X`;
  const hit = fxCache.get(pair);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.fx;
  const q = parseYahooQuote(pair, await httpGet(yahooUrl(pair, '1d', '5m'), 'json'));
  const fx = { rate: q.price, prev: q.prevClose };
  fxCache.set(pair, { fx, at: Date.now() });
  return fx;
}

// The price and today's change seen in the local currency: the move in the
// ticker combined with the move in the exchange rate.
export function toLocal(q: { price: number; prevClose: number }, fx: Fx, scale = 1): LocalPrice {
  const price = q.price * scale * fx.rate;
  const prev = q.prevClose * scale * fx.prev;
  return { price, change: price - prev, changePct: prev ? (price / prev - 1) * 100 : 0 };
}
