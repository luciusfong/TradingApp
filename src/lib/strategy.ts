// Paper-account strategies: sell at a target price (take profit / stop loss) and
// rebalance to target weights. Pure functions, so the maths can be unit-tested.
// They run inside the app (see useStrategies in src/App.tsx), never on a live account.
import { applyOrder, breakdown, type Account, type Order } from './paper';
import { localChanged } from './mirror';
import { read, write } from './store';

export interface PriceRule {
  id: string; kind: 'price'; symbol: string;
  takeProfit: number | null; // sell when the price is at or above this
  stopLoss: number | null; // sell when the price is at or below this
  qty: number | null; // shares to sell; null = the whole position
  on: boolean; created: number;
}
export interface Target { symbol: string; weight: number } // weight: % of account value
export interface RebalanceRule {
  id: string; kind: 'rebalance'; targets: Target[];
  drift: number; // percentage points a holding may stray from its target before an automatic rebalance
  auto: boolean; on: boolean; created: number; last?: number;
}
export type Rule = PriceRule | RebalanceRule;
export interface Fired { ruleId: string; text: string; time: number; ok: boolean; bg?: boolean } // bg: done by the background job

export const loadRules = (): Rule[] => read<Rule[]>('ta.rules', []);
export const saveRules = (r: Rule[]) => { write('ta.rules', r); localChanged(); };
export const loadLog = (): Fired[] => read<Fired[]>('ta.rulelog', []);
export const saveLog = (l: Fired[]) => { write('ta.rulelog', l.slice(0, 30)); localChanged(); };

export const ruleSymbols = (rules: Rule[]) =>
  [...new Set(rules.filter((r) => r.on).flatMap((r) => (r.kind === 'price' ? [r.symbol] : r.targets.map((t) => t.symbol))))];

// ---------- Target price ----------

/** The sell order a price rule calls for at this price, or null. Applies to long positions only. */
export function priceOrder(r: PriceRule, a: Account, price: number | undefined): { order: Order; why: string } | null {
  const held = a.positions[r.symbol];
  if (!r.on || !held || held.qty <= 0 || held.future || !(price && price > 0)) return null;
  const hitTp = r.takeProfit !== null && price >= r.takeProfit;
  const hitSl = r.stopLoss !== null && price <= r.stopLoss;
  if (!hitTp && !hitSl) return null;
  const qty = Math.min(held.qty, r.qty ?? held.qty);
  return { order: { symbol: r.symbol, side: 'sell', qty, price }, why: hitTp ? `reached target ${r.takeProfit}` : `fell to stop ${r.stopLoss}` };
}

// ---------- Rebalance ----------

export interface Plan { orders: Order[]; drift: number; missing: string[]; rows: { symbol: string; now: number; target: number }[] }

/**
 * Whole-share orders that bring the listed holdings to their target weights.
 * Holdings not listed are left alone. Sells come first so their cash pays for the buys;
 * buys are trimmed if cash still falls short.
 */
export function rebalancePlan(a: Account, targets: Target[], prices: Record<string, number | undefined>): Plan {
  const b = breakdown(a, prices);
  const missing = targets.filter((t) => !(prices[t.symbol] && prices[t.symbol]! > 0)).map((t) => t.symbol);
  const rows = targets.map((t) => {
    const p = a.positions[t.symbol];
    const price = prices[t.symbol] ?? 0;
    const value = p && !p.future && p.qty > 0 ? p.qty * price : 0;
    return { symbol: t.symbol, now: b.equity > 0 ? (value / b.equity) * 100 : 0, target: t.weight };
  });
  const drift = rows.reduce((m, r) => Math.max(m, Math.abs(r.now - r.target)), 0);
  if (missing.length || b.equity <= 0) return { orders: [], drift, missing, rows };

  const sells: Order[] = [];
  const buys: Order[] = [];
  for (const t of targets) {
    const price = prices[t.symbol]!;
    const held = a.positions[t.symbol];
    const have = held && !held.future && held.qty > 0 ? held.qty : 0;
    const want = Math.floor((b.equity * t.weight) / 100 / price);
    if (want < have) sells.push({ symbol: t.symbol, side: 'sell', qty: have - want, price });
    if (want > have) buys.push({ symbol: t.symbol, side: 'buy', qty: want - have, price });
  }
  let cash = a.cash + sells.reduce((s, o) => s + o.qty * o.price, 0);
  const fitted: Order[] = [];
  for (const o of buys) {
    const qty = Math.min(o.qty, Math.floor(cash / o.price));
    if (qty > 0) { fitted.push({ ...o, qty }); cash -= qty * o.price; }
  }
  return { orders: [...sells, ...fitted], drift, missing, rows };
}

// ---------- Running the rules ----------

/** Runs every active rule against the latest prices. Returns the new account, rules and log entries. */
export function runRules(a: Account, rules: Rule[], prices: Record<string, number | undefined>, now = Date.now(), manual?: string): { account: Account; rules: Rule[]; fired: Fired[] } {
  let account = a;
  const fired: Fired[] = [];
  const next = rules.map((r) => ({ ...r }));
  for (const r of next) {
    if (r.kind === 'price') {
      const hit = priceOrder(r, account, prices[r.symbol]);
      if (!hit) continue;
      try {
        account = applyOrder(account, { ...hit.order, time: now }, prices);
        fired.push({ ruleId: r.id, ok: true, time: now, text: `Sold ${hit.order.qty} ${r.symbol} at ${hit.order.price.toFixed(2)}: ${hit.why}.` });
        r.on = false; // a target fires once
      } catch (e) {
        fired.push({ ruleId: r.id, ok: false, time: now, text: `${r.symbol} ${hit.why}, but the sale failed: ${e instanceof Error ? e.message : e}` });
        r.on = false;
      }
    } else {
      if (!r.on) continue;
      const plan = rebalancePlan(account, r.targets, prices);
      const due = manual === r.id || (r.auto && plan.drift >= r.drift);
      if (!due) continue;
      if (plan.missing.length) {
        if (manual === r.id) fired.push({ ruleId: r.id, ok: false, time: now, text: `Rebalance skipped: no price for ${plan.missing.join(', ')}.` });
        continue;
      }
      let done = 0;
      for (const o of plan.orders) {
        try { account = applyOrder(account, { ...o, time: now }, prices); done++; } catch { /* the rest still runs */ }
      }
      r.last = now;
      fired.push({ ruleId: r.id, ok: true, time: now, text: done ? `Rebalanced with ${done} ${done === 1 ? 'order' : 'orders'} (largest drift was ${plan.drift.toFixed(1)} points).` : 'Rebalance checked: already on target.' });
    }
  }
  return { account, rules: next, fired };
}
