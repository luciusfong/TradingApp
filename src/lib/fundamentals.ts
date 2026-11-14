import { httpGet } from './http';

export interface Fundamentals {
  symbol: string;
  pe: number | null;
  growth: number | null; // EPS growth, percent a year
  growthBasis: string;
  peg: number | null;
  roe: number | null; // percent
  margin: number | null; // net margin, percent
  debtEquity: number | null; // ratio
  yieldPct: number | null;
  quality: boolean[]; // Buffett-style checks
  qualityKnown: number; // how many checks had data
  verdict: Verdict;
}
export type Verdict = 'quality-fair' | 'garp' | 'quality-pricey' | 'cheap-weak' | 'pricey' | 'no-earnings' | 'mixed' | 'no-data';

export const QUALITY_CHECKS = ['Return on equity 15% or more', 'Net margin 10% or more', 'Debt no more than equity', 'Earnings grew over 5 years'];
export const VERDICT_TEXT: Record<Verdict, { label: string; tone: 'pos' | 'neg' | 'flat'; why: string }> = {
  'quality-fair': { label: 'Quality at a fair price', tone: 'pos', why: 'Passes the quality checks and the price is reasonable for its growth (PEG 1.5 or lower).' },
  garp: { label: 'Growth at a reasonable price', tone: 'pos', why: 'PEG of 1 or lower: the P/E is no higher than the growth rate, the level Lynch looked for.' },
  'quality-pricey': { label: 'Quality, but expensive', tone: 'flat', why: 'Passes the quality checks, but the P/E is more than twice the growth rate.' },
  'cheap-weak': { label: 'Cheap, but weak quality', tone: 'flat', why: 'Low PEG, but it fails most quality checks. Cheap stocks are often cheap for a reason.' },
  pricey: { label: 'Expensive for its growth', tone: 'neg', why: 'P/E is more than twice the growth rate and quality does not make up for it.' },
  'no-earnings': { label: 'No earnings or growth to value', tone: 'neg', why: 'Losses or shrinking earnings, so a P/E-to-growth comparison does not apply.' },
  mixed: { label: 'Mixed', tone: 'flat', why: 'Neither clearly cheap nor clearly expensive for its growth.' },
  'no-data': { label: 'No fundamentals available', tone: 'flat', why: 'Funds, ETFs and some foreign listings have no company financials.' },
};

const num = (m: any, ...keys: string[]): number | null => {
  for (const k of keys) {
    const v = m?.[k];
    if (typeof v === 'number' && isFinite(v)) return v;
  }
  return null;
};

// Finnhub "basic financials". Field names vary by listing, so each value tries
// several keys. Growth, ROE and margins arrive as percentages.
export function parseMetrics(symbol: string, m: any): Fundamentals {
  const pe = num(m, 'peTTM', 'peBasicExclExtraTTM', 'peExclExtraTTM', 'peNormalizedAnnual', 'peAnnual');
  let growth = num(m, 'epsGrowth5Y');
  let growthBasis = '5-year';
  if (growth === null) { growth = num(m, 'epsGrowth3Y'); growthBasis = '3-year'; }
  if (growth === null) { growth = num(m, 'epsGrowthTTMYoy'); growthBasis = '1-year'; }
  const roe = num(m, 'roeTTM', 'roe5Y', 'roeRfy');
  const margin = num(m, 'netProfitMarginTTM', 'netProfitMargin5Y', 'netProfitMarginAnnual');
  let de = num(m, 'totalDebt/totalEquityQuarterly', 'totalDebt/totalEquityAnnual', 'longTermDebt/equityQuarterly', 'longTermDebt/equityAnnual');
  if (de !== null && de > 20) de = de / 100; // some listings report it as a percentage
  const yieldPct = num(m, 'dividendYieldIndicatedAnnual', 'currentDividendYieldTTM');
  const peg = pe !== null && pe > 0 && growth !== null && growth > 0 ? pe / growth : null;

  const raw: (boolean | null)[] = [
    roe === null ? null : roe >= 15,
    margin === null ? null : margin >= 10,
    de === null ? null : de <= 1,
    growth === null ? null : growth > 0,
  ];
  const quality = raw.map((x) => x === true);
  const qualityKnown = raw.filter((x) => x !== null).length;
  const q = quality.filter(Boolean).length;

  let verdict: Verdict;
  if (pe === null && roe === null && margin === null && growth === null) verdict = 'no-data';
  else if (peg === null) verdict = 'no-earnings';
  else if (q >= 3 && peg <= 1.5) verdict = 'quality-fair';
  else if (peg <= 1 && q >= 2) verdict = 'garp';
  else if (peg <= 1) verdict = 'cheap-weak';
  else if (q >= 3 && peg > 2) verdict = 'quality-pricey';
  else if (peg > 2) verdict = 'pricey';
  else verdict = 'mixed';
  return { symbol, pe, growth, growthBasis, peg, roe, margin, debtEquity: de, yieldPct, quality, qualityKnown, verdict };
}

const ORDER: Verdict[] = ['quality-fair', 'garp', 'quality-pricey', 'mixed', 'cheap-weak', 'pricey', 'no-earnings', 'no-data'];
export function rankFundamentals(rows: Fundamentals[]): Fundamentals[] {
  return [...rows].sort((a, b) => ORDER.indexOf(a.verdict) - ORDER.indexOf(b.verdict) || (a.peg ?? 99) - (b.peg ?? 99));
}

const cache = new Map<string, { data: Fundamentals; at: number }>();
export async function getFundamentals(symbol: string, key: string, force = false): Promise<Fundamentals> {
  const hit = cache.get(symbol);
  if (hit && !force && Date.now() - hit.at < 6 * 3600e3) return hit.data;
  const d = await httpGet(`https://finnhub.io/api/v1/stock/metric?symbol=${encodeURIComponent(symbol)}&metric=all&token=${encodeURIComponent(key)}`, 'json');
  const data = parseMetrics(symbol, d?.metric ?? {});
  cache.set(symbol, { data, at: Date.now() });
  return data;
}
export const isCached = (symbol: string) => { const h = cache.get(symbol); return !!h && Date.now() - h.at < 6 * 3600e3; };
