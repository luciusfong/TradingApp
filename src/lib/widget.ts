import { Preferences } from '@capacitor/preferences';
import type { Account } from './paper';
import { holdingFor, labelOf, type Holding } from './store';

// The home-screen widgets are native Android code and cannot see the webview's
// storage, so the watchlist and paper account are mirrored into Capacitor
// Preferences, which the widgets read. Short keys: s symbol, l label, n name,
// q quantity (negative when short), c average cost, m contract multiplier, f futures.
const put = (key: string, value: unknown) => { Preferences.set({ key, value: JSON.stringify(value) }).catch(() => { /* widgets keep their last copy */ }); };

export function widgetWatchlist(list: Holding[]) {
  return list.map((h) => ({ s: h.symbol, l: labelOf(h), n: h.name ?? '' }));
}
export function widgetPaper(a: Account) {
  return {
    cash: a.cash,
    start: a.start,
    positions: Object.entries(a.positions).map(([s, p]) => ({ s, l: labelOf(holdingFor(s)), q: p.qty, c: p.avgCost, m: p.mult ?? 1, f: !!p.future })),
  };
}
export const syncWidgetWatchlist = (list: Holding[]) => put('widget.watchlist', widgetWatchlist(list));
export const syncWidgetPaper = (a: Account) => put('widget.paper', widgetPaper(a));
