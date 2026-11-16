import { Preferences } from '@capacitor/preferences';
import type { AlertConfig } from './alerts';
import { screenSymbols, type Filters } from './filters';
import type { Account } from './paper';
import { holdingFor, labelOf, type Holding } from './store';

// The home-screen widgets and the background alert job are native Android code
// and cannot see the webview's storage, so what they need is mirrored into
// Capacitor Preferences, which they read. Short keys: s symbol, l label, n name,
// q quantity (negative when short), c average cost, m contract multiplier, f futures.
const put = (key: string, value: unknown) => { Preferences.set({ key, value: JSON.stringify(value) }).catch(() => { /* native side keeps its last copy */ }); };

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

// Everything the alert job needs: whether alerts are on, the symbols each tab
// screens, display names, and the filters.
export function alertConfig(on: boolean, list: Holding[], f: Filters): AlertConfig & { on: boolean; labels: Record<string, string> } {
  const s = screenSymbols(list, f.universe);
  const labels: Record<string, string> = {};
  for (const sym of new Set([...s.macro, ...s.quant, ...s.stocks, ...s.futures])) {
    const label = labelOf(list.find((h) => h.symbol === sym) ?? holdingFor(sym));
    if (label !== sym) labels[sym] = label;
  }
  return { on, macro: s.macro, quant: s.quant, stocks: s.stocks, futures: s.futures, labels, f: { macro: f.macro, quant: f.quant, tech: f.tech } };
}
export const syncAlerts = (on: boolean, list: Holding[], f: Filters) => put('alerts.config', alertConfig(on, list, f));

// A tapped notification asks the app to open on a given tab; the native side
// leaves the name here and the app picks it up once.
export async function takeNavTab(): Promise<string | null> {
  try {
    const { value } = await Preferences.get({ key: 'nav.tab' });
    if (value) await Preferences.remove({ key: 'nav.tab' });
    return value || null;
  } catch {
    return null;
  }
}

// Secrets (the Wise token) are kept apart from everything else: not in the
// webview's storage, not in the settings object, and so never in a backup file.
// On Android this store is also excluded from cloud backup and phone-to-phone
// transfer (native/res/xml/backup_rules.xml and data_extraction_rules.xml).
export async function loadSecret<T>(name: string): Promise<T | null> {
  try {
    const { value } = await Preferences.get({ key: `secret.${name}` });
    return value ? (JSON.parse(value) as T) : null;
  } catch {
    return null;
  }
}
export const saveSecret = (name: string, value: unknown) => Preferences.set({ key: `secret.${name}`, value: JSON.stringify(value) });
export const removeSecret = (name: string) => Preferences.remove({ key: `secret.${name}` });
