import { newAccount, type Account } from './paper';
export interface Holding { symbol: string; name?: string; label?: string; q?: string }

// Futures and indexes: the data symbol, the label shown in the app, and the
// news search used for headlines (a ticker search finds nothing for these).
export const CATALOG: Record<string, Holding> = {
  'CL=F': { symbol: 'CL=F', label: 'CLmain', name: 'Crude oil futures', q: '"crude oil" OR WTI OR OPEC when:3d' },
  'NQ=F': { symbol: 'NQ=F', label: 'NQmain', name: 'Nasdaq 100 futures', q: '"Nasdaq 100" OR "Nasdaq futures" OR "tech stocks" when:3d' },
  'UB=F': { symbol: 'UB=F', label: 'UBmain', name: 'Ultra T-Bond futures', q: '"Treasury yields" OR "Treasury bonds" OR "30-year yield" when:3d' },
  'GC=F': { symbol: 'GC=F', label: 'GCmain', name: 'Gold futures', q: '"gold prices" OR "gold futures" OR bullion when:3d' },
  'DX-Y.NYB': { symbol: 'DX-Y.NYB', label: 'USDindex', name: 'US Dollar Index', q: '"dollar index" OR DXY OR "US dollar" when:3d' },
  'ES=F': { symbol: 'ES=F', label: 'ESmain', name: 'S&P 500 futures', q: '"S&P 500" OR "stock futures" when:3d' },
  'ZN=F': { symbol: 'ZN=F', label: 'ZNmain', name: '10-year T-Note futures', q: '"10-year Treasury" OR "Treasury yields" when:3d' },
  'HG=F': { symbol: 'HG=F', label: 'HGmain', name: 'Copper futures', q: '"copper prices" OR "copper futures" when:3d' },
};
const ALIAS: Record<string, string> = {
  CLMAIN: 'CL=F', NQMAIN: 'NQ=F', UBMAIN: 'UB=F', GCMAIN: 'GC=F', ESMAIN: 'ES=F', ZNMAIN: 'ZN=F', HGMAIN: 'HG=F',
  USDINDEX: 'DX-Y.NYB', DXY: 'DX-Y.NYB', USDX: 'DX-Y.NYB', DOLLARINDEX: 'DX-Y.NYB',
};
export const MACRO_SET = ['NQ=F', 'ES=F', 'UB=F', 'ZN=F', 'DX-Y.NYB', 'GC=F', 'CL=F', 'HG=F'];
export const LARGE_CAPS = 'AAPL MSFT NVDA AMZN GOOGL META TSLA AVGO BRK-B JPM LLY V UNH XOM MA COST HD PG JNJ NFLX BAC CRM ORCL AMD KO PEP WMT DIS INTC BA'.split(' ');
// Futures, indexes and currencies have no company behind them.
export const isFuture = (symbol: string) => !!CATALOG[symbol] || /=F$|=X$|\.NYB$|^\^/.test(symbol);
export const labelOf = (h: Holding) => h.label ?? h.symbol;
export const holdingFor = (symbol: string): Holding => CATALOG[symbol] ?? { symbol };
export interface Settings { finnhubKey: string; hideLowValue: boolean; screenerInfo: boolean }

const DEFAULT_LIST: Holding[] = [
  { symbol: 'AAPL', name: 'Apple' },
  { symbol: 'MSFT', name: 'Microsoft' },
  { symbol: 'NVDA', name: 'Nvidia' },
  { symbol: 'TSLA', name: 'Tesla' },
  { symbol: 'SPY', name: 'S&P 500 ETF' },
];
const ADDED_V2 = ['CL=F', 'NQ=F', 'UB=F', 'GC=F', 'DX-Y.NYB'];

function read<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}
function write(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage full or blocked */ }
}

export function loadWatchlist(): Holding[] {
  let list = read<Holding[]>('ta.watchlist', DEFAULT_LIST);
  // One-time: add the futures and dollar index to lists saved by the first version.
  if (!read<boolean>('ta.v2', false)) {
    list = [...list, ...ADDED_V2.filter((s) => !list.some((h) => h.symbol === s)).map((s) => CATALOG[s])];
    write('ta.watchlist', list);
    write('ta.v2', true);
  }
  return list;
}
export const saveWatchlist = (w: Holding[]) => write('ta.watchlist', w);
export const loadSettings = () => ({ finnhubKey: '', hideLowValue: true, screenerInfo: true, ...read<Partial<Settings>>('ta.settings', {}) });
export const saveSettings = (s: Settings) => write('ta.settings', s);

export function cleanSymbol(input: string): string {
  const s = input.trim().toUpperCase().replace(/[^A-Z0-9.\-^=]/g, '').slice(0, 12);
  return ALIAS[s] ?? s;
}

export const loadPaper = (): Account => ({ ...newAccount(), ...read<Partial<Account>>('ta.paper', {}) });
export const savePaper = (a: Account) => write('ta.paper', a);
