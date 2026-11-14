export interface Holding { symbol: string; name?: string }
export interface Settings { finnhubKey: string; hideLowValue: boolean }

const DEFAULT_LIST: Holding[] = [
  { symbol: 'AAPL', name: 'Apple' },
  { symbol: 'MSFT', name: 'Microsoft' },
  { symbol: 'NVDA', name: 'Nvidia' },
  { symbol: 'TSLA', name: 'Tesla' },
  { symbol: 'SPY', name: 'S&P 500 ETF' },
];

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

export const loadWatchlist = () => read<Holding[]>('ta.watchlist', DEFAULT_LIST);
export const saveWatchlist = (w: Holding[]) => write('ta.watchlist', w);
export const loadSettings = () => ({ finnhubKey: '', hideLowValue: true, ...read<Partial<Settings>>('ta.settings', {}) });
export const saveSettings = (s: Settings) => write('ta.settings', s);

export function cleanSymbol(input: string): string {
  return input.trim().toUpperCase().replace(/[^A-Z0-9.\-^=]/g, '').slice(0, 12);
}
