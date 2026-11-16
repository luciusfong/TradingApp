// Runs the paper strategies against fresh quotes and saves the result.
// Called when the app opens, every minute while it is open, and on demand.
import { getQuote } from './market';
import { syncWidgetPaper } from './native';
import { loadPaper, savePaper } from './store';
import { loadLog, loadRules, ruleSymbols, runRules, saveLog, saveRules, type Fired } from './strategy';

export const PAPER_EVENT = 'ta-paper-changed';
let running = false;

export async function checkStrategies(finnhubKey: string, manual?: string): Promise<Fired[]> {
  if (running) return [];
  running = true;
  try {
    const rules = loadRules();
    const symbols = ruleSymbols(rules);
    if (!symbols.length) return [];
    const prices: Record<string, number> = {};
    const res = await Promise.allSettled(symbols.map((s) => getQuote(s, finnhubKey)));
    res.forEach((r, i) => { if (r.status === 'fulfilled') prices[symbols[i]] = r.value.price; });
    // Other holdings are priced too, so margin checks see the whole account.
    const acct = loadPaper();
    const others = Object.keys(acct.positions).filter((s) => !(s in prices));
    const more = await Promise.allSettled(others.map((s) => getQuote(s, finnhubKey)));
    more.forEach((r, i) => { if (r.status === 'fulfilled') prices[others[i]] = r.value.price; });

    const out = runRules(acct, rules, prices, Date.now(), manual);
    if (!out.fired.length) return [];
    savePaper(out.account);
    syncWidgetPaper(out.account);
    saveRules(out.rules);
    saveLog([...out.fired, ...loadLog()]);
    window.dispatchEvent(new Event(PAPER_EVENT));
    return out.fired;
  } finally {
    running = false;
  }
}
