import { describe, expect, it, vi } from 'vitest';

const prefs = new Map<string, string>();
vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    set: async ({ key, value }: { key: string; value: string }) => { prefs.set(key, value); },
    get: async ({ key }: { key: string }) => ({ value: prefs.get(key) ?? null }),
    remove: async ({ key }: { key: string }) => { prefs.delete(key); },
  },
}));

import { adoptBackground, localChanged, mirrorStrategies } from '../src/lib/mirror';
import { loadLog, loadRules } from '../src/lib/strategy';

describe('background strategy hand-off', () => {
  it('adopts only newer state written by the background job', async () => {
    const mem = new Map<string, string>();
    (globalThis as any).localStorage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v); }, removeItem: (k: string) => { mem.delete(k); } };
    (globalThis as any).window ??= { dispatchEvent: () => true };

    localChanged(); // rev 1
    await mirrorStrategies(true);
    const copy = JSON.parse(prefs.get('strategy.state')!);
    expect(copy).toMatchObject({ rev: 1, from: 'app', bg: true });
    expect(await adoptBackground()).toEqual([]); // the app's own copy is not adopted

    const bg = { ...copy, rev: 2, from: 'bg', rules: [{ id: 'p', kind: 'price', symbol: 'AAPL', takeProfit: 1, stopLoss: null, qty: null, on: false, created: 0 }],
      log: [{ ruleId: 'p', text: 'Sold 5 AAPL at 2.00: reached target 1.', time: 99, ok: true, bg: true }],
      paper: { ...copy.paper, cash: 123 } };
    prefs.set('strategy.state', JSON.stringify(bg));
    const fresh = await adoptBackground();
    expect(fresh.map((f) => f.text)).toEqual(['Sold 5 AAPL at 2.00: reached target 1.']);
    expect(JSON.parse(mem.get('ta.paper')!).cash).toBe(123);
    expect(loadRules()[0].on).toBe(false);
    expect(loadLog()).toHaveLength(1);
    expect(await adoptBackground()).toEqual([]); // only once

    localChanged(); // the app moved on (rev 3): an old background copy is ignored
    prefs.set('strategy.state', JSON.stringify({ ...bg, rev: 3, paper: { ...bg.paper, cash: 1 } }));
    expect(await adoptBackground()).toEqual([]);
    expect(JSON.parse(mem.get('ta.paper')!).cash).toBe(123);
  });
});
