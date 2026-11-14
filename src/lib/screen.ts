// Screens built from one year of daily closes. Pure functions, unit-tested.

export const last = (a: number[]) => a[a.length - 1];
export function sma(a: number[], n: number): number | null {
  if (a.length < n) return null;
  let s = 0;
  for (let i = a.length - n; i < a.length; i++) s += a[i];
  return s / n;
}
export function stdev(a: number[]): number {
  if (a.length < 2) return 0;
  const m = a.reduce((x, y) => x + y, 0) / a.length;
  return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1));
}
// Percent return over the last n sessions, optionally skipping the most recent `skip`.
export function ret(a: number[], n: number, skip = 0): number | null {
  const end = a.length - 1 - skip;
  const start = end - n;
  if (start < 0 || !a[start]) return null;
  return (a[end] / a[start] - 1) * 100;
}
export function zscore(a: number[], n = 20): number | null {
  if (a.length < n) return null;
  const w = a.slice(-n);
  const sd = stdev(w);
  if (!sd) return 0;
  return (last(a) - w.reduce((x, y) => x + y, 0) / n) / sd;
}
// Wilder RSI; period 2 is the classic short-term mean-reversion gauge.
export function rsi(a: number[], n = 2): number | null {
  if (a.length < n + 1) return null;
  let up = 0;
  let dn = 0;
  for (let i = 1; i <= n; i++) {
    const d = a[i] - a[i - 1];
    if (d >= 0) up += d; else dn -= d;
  }
  up /= n; dn /= n;
  for (let i = n + 1; i < a.length; i++) {
    const d = a[i] - a[i - 1];
    up = (up * (n - 1) + Math.max(d, 0)) / n;
    dn = (dn * (n - 1) + Math.max(-d, 0)) / n;
  }
  if (dn === 0) return up === 0 ? 50 : 100;
  return 100 - 100 / (1 + up / dn);
}
export function annualVol(a: number[], n = 20): number | null {
  if (a.length < n + 1) return null;
  const r: number[] = [];
  for (let i = a.length - n; i < a.length; i++) r.push(Math.log(a[i] / a[i - 1]));
  return stdev(r) * Math.sqrt(252) * 100;
}

export type Trend = 'up' | 'down' | 'mixed';
export function trendOf(a: number[]): Trend {
  const p = last(a);
  const m50 = sma(a, 50);
  const m200 = sma(a, Math.min(200, a.length));
  if (m50 === null || m200 === null) return 'mixed';
  if (p > m50 && m50 > m200) return 'up';
  if (p < m50 && m50 < m200) return 'down';
  return 'mixed';
}

export interface MacroRow {
  symbol: string;
  price: number;
  trend: Trend;
  r1m: number | null;
  r3m: number | null;
  vs200: number | null; // percent above/below the 200-day average
  spark: number[]; // last ~3 months
}
export function macroRow(symbol: string, closes: number[]): MacroRow {
  const m200 = sma(closes, Math.min(200, closes.length));
  return {
    symbol,
    price: last(closes),
    trend: trendOf(closes),
    r1m: ret(closes, 21),
    r3m: ret(closes, 63),
    vs200: m200 ? (last(closes) / m200 - 1) * 100 : null,
    spark: closes.slice(-63),
  };
}

export interface MacroRead { title: string; tone: 'pos' | 'neg' | 'flat'; text: string }

// Top-down read in the spirit of Druckenmiller: liquidity first (bonds, dollar),
// then what risk assets and commodities are doing with it.
export function macroRead(rows: Record<string, MacroRow | undefined>): MacroRead[] {
  const t = (s: string) => rows[s]?.trend;
  const out: MacroRead[] = [];
  const bonds = t('UB=F') ?? t('ZN=F');
  const dollar = t('DX-Y.NYB');
  const stocks = t('NQ=F') ?? t('ES=F');
  const gold = t('GC=F');
  const oil = t('CL=F');
  const copper = t('HG=F');

  if (bonds && dollar) {
    if (bonds === 'up' && dollar === 'down') out.push({ title: 'Liquidity is easing', tone: 'pos', text: 'Bonds are trending up (yields falling) and the dollar is trending down. Historically the friendliest backdrop for stocks, gold and emerging markets.' });
    else if (bonds === 'down' && dollar === 'up') out.push({ title: 'Liquidity is tightening', tone: 'neg', text: 'Bonds are trending down (yields rising) and the dollar is trending up. That drains liquidity and usually pressures growth stocks and commodities.' });
    else if (bonds === 'down' && dollar === 'down') out.push({ title: 'Yields up, dollar down', tone: 'flat', text: 'Bonds and the dollar are both falling. This mix often goes with inflation or fiscal worries and tends to favour hard assets over long-duration ones.' });
    else if (bonds === 'up' && dollar === 'up') out.push({ title: 'Flight to safety', tone: 'neg', text: 'Bonds and the dollar are both rising. Money is moving to safe assets, which usually signals growth fears.' });
    else out.push({ title: 'Liquidity picture is mixed', tone: 'flat', text: 'Bonds and the dollar are not both in clear trends. No strong liquidity signal right now.' });
  }
  if (stocks) {
    const agree = (stocks === 'up' && bonds === 'up' && dollar === 'down') || (stocks === 'down' && bonds === 'down' && dollar === 'up');
    out.push({
      title: stocks === 'up' ? 'Stocks are in an uptrend' : stocks === 'down' ? 'Stocks are in a downtrend' : 'Stocks have no clear trend',
      tone: stocks === 'up' ? 'pos' : stocks === 'down' ? 'neg' : 'flat',
      text: agree
        ? 'The equity trend agrees with the liquidity backdrop, the alignment this style looks for before sizing up.'
        : stocks === 'up' && (bonds === 'down' || dollar === 'up')
          ? 'The equity trend is running against liquidity. Rallies like this are more fragile.'
          : stocks === 'down' && bonds === 'up' && dollar === 'down'
            ? 'Stocks are weak even though liquidity is easing. Watch for a turn; this is where reversals often start.'
            : 'Nasdaq 100 futures versus their 50-day and 200-day averages.',
    });
  }
  if (oil && gold) {
    if (oil === 'up' && gold === 'up') out.push({ title: 'Inflation pressure building', tone: 'neg', text: 'Crude oil and gold are both trending up, a classic sign of rising inflation expectations.' });
    else if (oil === 'down' && gold !== 'up') out.push({ title: 'Inflation pressure easing', tone: 'pos', text: 'Crude oil is trending down and gold is not rising, which takes pressure off rates.' });
    else if (gold === 'up' && oil !== 'up') out.push({ title: 'Gold is leading', tone: 'flat', text: 'Gold is trending up without oil. That usually reflects falling real yields or demand for safety rather than inflation.' });
  }
  if (copper && copper !== 'mixed') {
    out.push({
      title: copper === 'up' ? 'Growth signal is positive' : 'Growth signal is negative',
      tone: copper === 'up' ? 'pos' : 'neg',
      text: copper === 'up' ? 'Copper is trending up, which tends to track improving industrial demand.' : 'Copper is trending down, which tends to track weakening industrial demand.',
    });
  }
  return out;
}

export type QuantSignal = 'dip-uptrend' | 'spike-downtrend' | 'stretched-down' | 'stretched-up' | 'momentum' | 'none';
export interface QuantRow {
  symbol: string;
  price: number;
  z: number | null;
  rsi2: number | null;
  mom: number | null; // 6-month return skipping the latest month
  vol: number | null;
  above200: boolean | null;
  signal: QuantSignal;
  strength: number; // for ranking
}

// Simple statistical screen: short-term mean reversion conditioned on the
// long-term trend, plus medium-term momentum.
export function quantRow(symbol: string, closes: number[]): QuantRow {
  const z = zscore(closes, 20);
  const r2 = rsi(closes, 2);
  const mom = ret(closes, 105, 21);
  const vol = annualVol(closes, 20);
  const m200 = sma(closes, Math.min(200, closes.length));
  const above200 = closes.length >= 120 && m200 ? last(closes) > m200 : null;
  const low = (z !== null && z <= -2) || (r2 !== null && r2 <= 5);
  const high = (z !== null && z >= 2) || (r2 !== null && r2 >= 95);
  let signal: QuantSignal = 'none';
  if (low && above200 === true) signal = 'dip-uptrend';
  else if (high && above200 === false) signal = 'spike-downtrend';
  else if (z !== null && z <= -2) signal = 'stretched-down';
  else if (z !== null && z >= 2) signal = 'stretched-up';
  else if (mom !== null && mom >= 20 && above200 === true && z !== null && Math.abs(z) < 1.5) signal = 'momentum';
  const strength = (signal === 'none' ? 0 : signal === 'momentum' ? 1 : 2) + Math.abs(z ?? 0) / 10;
  return { symbol, price: last(closes), z, rsi2: r2, mom, vol, above200, signal, strength };
}

export const SIGNAL_TEXT: Record<QuantSignal, { label: string; tone: 'pos' | 'neg' | 'flat'; why: string }> = {
  'dip-uptrend': { label: 'Dip in an uptrend', tone: 'pos', why: 'Sharply below its 20-day average while still above the 200-day. Short-term mean reversion has historically favoured a bounce.' },
  'spike-downtrend': { label: 'Spike in a downtrend', tone: 'neg', why: 'Sharply above its 20-day average while below the 200-day. Short-term mean reversion has historically favoured a fade.' },
  'stretched-down': { label: 'Stretched down', tone: 'flat', why: 'More than 2 standard deviations below its 20-day average, without a supporting long-term trend.' },
  'stretched-up': { label: 'Stretched up', tone: 'flat', why: 'More than 2 standard deviations above its 20-day average.' },
  momentum: { label: 'Steady momentum', tone: 'pos', why: 'Up 20% or more over six months, above the 200-day average and not stretched.' },
  none: { label: 'No signal', tone: 'flat', why: '' },
};
