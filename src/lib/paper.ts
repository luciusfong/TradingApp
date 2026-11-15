// Paper trading account: whole shares, long only, filled at the latest quote.
// Pure functions so the maths can be unit-tested.

export interface Position { qty: number; avgCost: number }
export interface Trade { symbol: string; side: 'buy' | 'sell'; qty: number; price: number; time: number; pnl?: number }
export interface Account { start: number; cash: number; realized: number; positions: Record<string, Position>; trades: Trade[] }
export interface Order { symbol: string; side: 'buy' | 'sell'; qty: number; price: number; time?: number }

export const START_CASH = 100_000;
export const newAccount = (): Account => ({ start: START_CASH, cash: START_CASH, realized: 0, positions: {}, trades: [] });
const cents = (v: number) => Math.round(v * 100) / 100;

export function applyOrder(a: Account, o: Order): Account {
  if (!Number.isInteger(o.qty) || o.qty <= 0) throw new Error('Quantity must be a whole number of shares, 1 or more.');
  if (!(o.price > 0)) throw new Error('No price available for this symbol.');
  const held = a.positions[o.symbol];
  const positions = { ...a.positions };
  const cost = cents(o.qty * o.price);
  const trade: Trade = { symbol: o.symbol, side: o.side, qty: o.qty, price: o.price, time: o.time ?? Date.now() };
  let cash = a.cash;
  let realized = a.realized;
  if (o.side === 'buy') {
    if (cost > a.cash + 1e-9) throw new Error(`Not enough cash. This order costs $${cost.toFixed(2)} and you have $${a.cash.toFixed(2)}.`);
    const qty = (held?.qty ?? 0) + o.qty;
    positions[o.symbol] = { qty, avgCost: ((held?.qty ?? 0) * (held?.avgCost ?? 0) + o.qty * o.price) / qty };
    cash = cents(cash - cost);
  } else {
    if (!held || held.qty < o.qty) throw new Error(held ? `You hold ${held.qty} shares of ${o.symbol}. Short selling is not supported.` : `You hold no ${o.symbol}. Short selling is not supported.`);
    trade.pnl = cents((o.price - held.avgCost) * o.qty);
    realized = cents(realized + trade.pnl);
    if (held.qty === o.qty) delete positions[o.symbol];
    else positions[o.symbol] = { qty: held.qty - o.qty, avgCost: held.avgCost };
    cash = cents(cash + cost);
  }
  return { ...a, cash, realized, positions, trades: [trade, ...a.trades].slice(0, 100) };
}

export interface Row {
  symbol: string; qty: number; avgCost: number; price: number; priced: boolean;
  value: number; cost: number; pnl: number; pnlPct: number; weight: number; // weight: % of account value
}
export interface Breakdown {
  rows: Row[]; invested: number; cash: number; equity: number; cashWeight: number;
  unrealized: number; realized: number; total: number; totalPct: number;
}

// Positions without a live price are valued at cost and flagged.
export function breakdown(a: Account, prices: Record<string, number | undefined>): Breakdown {
  const rows: Row[] = Object.entries(a.positions).map(([symbol, p]) => {
    const live = prices[symbol];
    const priced = typeof live === 'number' && live > 0;
    const price = priced ? live : p.avgCost;
    const value = p.qty * price;
    const cost = p.qty * p.avgCost;
    return { symbol, qty: p.qty, avgCost: p.avgCost, price, priced, value, cost, pnl: value - cost, pnlPct: cost ? ((value - cost) / cost) * 100 : 0, weight: 0 };
  });
  const invested = rows.reduce((s, r) => s + r.value, 0);
  const equity = a.cash + invested;
  for (const r of rows) r.weight = equity ? (r.value / equity) * 100 : 0;
  rows.sort((x, y) => y.value - x.value);
  const total = equity - a.start;
  return {
    rows, invested, cash: a.cash, equity, cashWeight: equity ? (a.cash / equity) * 100 : 0,
    unrealized: rows.reduce((s, r) => s + r.pnl, 0), realized: a.realized, total, totalPct: a.start ? (total / a.start) * 100 : 0,
  };
}
