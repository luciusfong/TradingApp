// The Screener's adjustable filters. Each tab has thresholds (defaults are the
// published rules) and a choice of which results to show. The same definitions
// drive the lists in the app and the background alerts.
import { FUNDA_DEFAULT, FUNDA_VERDICTS, type Fundamentals, type FundaParams, type Verdict } from './fundamentals';
import { MACRO_DEFAULT, QUANT_DEFAULT, QUANT_SIGNALS, TEMPLATE_DEFAULT, type MacroParams, type MacroRow, type QuantParams, type QuantRow, type QuantSignal, type TemplateParams, type Trend, type TurtleState } from './screen';
import { isFuture, LARGE_CAPS, MACRO_SET, read, write, type Holding } from './store';

export type Universe = 'watchlist' | 'large';
export type FilterTab = 'macro' | 'quant' | 'tech' | 'funda';
export interface MacroFilter extends MacroParams { trend: 'any' | Trend }
export interface QuantFilter extends QuantParams { signals: QuantSignal[] }
export interface TechFilter extends TemplateParams {
  checks: boolean[]; // which of the 8 trend-template checks a stock must pass
  enterN: number; // futures: breakout window to enter
  exitN: number; // futures: opposite window to exit
  pos: 'any' | 'open' | 'long' | 'short'; // futures to show
}
export interface FundaFilter extends FundaParams { verdicts: Verdict[] }
export interface Filters { universe: Universe; macro: MacroFilter; quant: QuantFilter; tech: TechFilter; funda: FundaFilter }

export const DEFAULT_FILTERS: Filters = {
  universe: 'watchlist',
  macro: { trend: 'any', fast: MACRO_DEFAULT.fast, slow: MACRO_DEFAULT.slow },
  quant: { z: QUANT_DEFAULT.z, rsiLow: QUANT_DEFAULT.rsiLow, rsiHigh: QUANT_DEFAULT.rsiHigh, mom: QUANT_DEFAULT.mom, signals: [...QUANT_SIGNALS] },
  tech: { checks: Array(8).fill(true), lowPct: TEMPLATE_DEFAULT.lowPct, highPct: TEMPLATE_DEFAULT.highPct, rsMin: TEMPLATE_DEFAULT.rsMin, enterN: 55, exitN: 20, pos: 'any' },
  funda: { pegCheap: FUNDA_DEFAULT.pegCheap, pegFair: FUNDA_DEFAULT.pegFair, pegPricey: FUNDA_DEFAULT.pegPricey, roeMin: FUNDA_DEFAULT.roeMin, marginMin: FUNDA_DEFAULT.marginMin, debtMax: FUNDA_DEFAULT.debtMax, verdicts: ['quality-fair', 'garp'] },
};

// Allowed range for each number, also used by the inputs.
export const LIMITS = {
  fast: [5, 150], slow: [20, 250],
  z: [0.5, 5], rsiLow: [0, 49], rsiHigh: [51, 100], mom: [0, 300],
  lowPct: [0, 300], highPct: [1, 95], rsMin: [1, 99], enterN: [10, 120], exitN: [5, 120],
  pegCheap: [0.1, 10], pegFair: [0.1, 10], pegPricey: [0.1, 10], roeMin: [0, 100], marginMin: [0, 100], debtMax: [0, 20],
} as const;

const num = (v: unknown, fallback: number, [lo, hi]: readonly [number, number]) =>
  (typeof v === 'number' && isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback);
const int = (v: unknown, fallback: number, range: readonly [number, number]) => Math.round(num(v, fallback, range));

// Fills gaps and clamps values, so saved filters from an older version (or a
// half-typed number) can never break a screen. Key order matches DEFAULT_FILTERS.
export function normalizeFilters(raw: any): Filters {
  const d = DEFAULT_FILTERS;
  const m = raw?.macro ?? {};
  const q = raw?.quant ?? {};
  const t = raw?.tech ?? {};
  const f = raw?.funda ?? {};
  const fast = int(m.fast, d.macro.fast, LIMITS.fast);
  const slow = Math.max(fast + 1, int(m.slow, d.macro.slow, LIMITS.slow));
  const enterN = int(t.enterN, d.tech.enterN, LIMITS.enterN);
  const exitN = Math.min(enterN, int(t.exitN, d.tech.exitN, LIMITS.exitN));
  const pegCheap = num(f.pegCheap, d.funda.pegCheap, LIMITS.pegCheap);
  const pegFair = Math.max(pegCheap, num(f.pegFair, d.funda.pegFair, LIMITS.pegFair));
  const pegPricey = Math.max(pegFair, num(f.pegPricey, d.funda.pegPricey, LIMITS.pegPricey));
  return {
    universe: raw?.universe === 'large' ? 'large' : 'watchlist',
    macro: { trend: m.trend === 'up' || m.trend === 'down' || m.trend === 'mixed' ? m.trend : 'any', fast, slow },
    quant: {
      z: num(q.z, d.quant.z, LIMITS.z),
      rsiLow: num(q.rsiLow, d.quant.rsiLow, LIMITS.rsiLow),
      rsiHigh: num(q.rsiHigh, d.quant.rsiHigh, LIMITS.rsiHigh),
      mom: num(q.mom, d.quant.mom, LIMITS.mom),
      signals: Array.isArray(q.signals) ? QUANT_SIGNALS.filter((x) => q.signals.includes(x)) : [...d.quant.signals],
    },
    tech: {
      checks: Array.from({ length: 8 }, (_, i) => !(Array.isArray(t.checks) && t.checks[i] === false)),
      lowPct: num(t.lowPct, d.tech.lowPct, LIMITS.lowPct),
      highPct: num(t.highPct, d.tech.highPct, LIMITS.highPct),
      rsMin: int(t.rsMin, d.tech.rsMin, LIMITS.rsMin),
      enterN,
      exitN,
      pos: t.pos === 'open' || t.pos === 'long' || t.pos === 'short' ? t.pos : 'any',
    },
    funda: {
      pegCheap, pegFair, pegPricey,
      roeMin: num(f.roeMin, d.funda.roeMin, LIMITS.roeMin),
      marginMin: num(f.marginMin, d.funda.marginMin, LIMITS.marginMin),
      debtMax: num(f.debtMax, d.funda.debtMax, LIMITS.debtMax),
      verdicts: Array.isArray(f.verdicts) ? FUNDA_VERDICTS.filter((x) => f.verdicts.includes(x)) : [...d.funda.verdicts],
    },
  };
}
export const isDefaultFilter = (f: Filters, tab: FilterTab) => JSON.stringify(f[tab]) === JSON.stringify(DEFAULT_FILTERS[tab]);
export const loadFilters = (): Filters => normalizeFilters(read<unknown>('ta.filters', {}));
export const saveFilters = (f: Filters) => write('ta.filters', f);

// Which symbols each tab screens.
export function screenSymbols(list: Holding[], universe: Universe) {
  const mine = list.map((h) => h.symbol);
  return {
    macro: MACRO_SET,
    quant: universe === 'large' ? LARGE_CAPS : mine,
    stocks: universe === 'large' ? LARGE_CAPS : mine.filter((s) => !isFuture(s)),
    futures: [...new Set([...MACRO_SET, ...mine.filter(isFuture)])],
  };
}

export const macroMatch = (r: MacroRow, f: MacroFilter) => f.trend === 'any' || r.trend === f.trend;
export const quantMatch = (r: QuantRow, f: QuantFilter) => r.signal !== 'none' && f.signals.includes(r.signal);
export const turtleMatch = (t: TurtleState, f: TechFilter) =>
  f.pos === 'any' || (f.pos === 'open' ? t.pos !== 0 : f.pos === 'long' ? t.pos === 1 : t.pos === -1);
export const fundaMatch = (x: Fundamentals, f: FundaFilter) => f.verdicts.includes(x.verdict);
