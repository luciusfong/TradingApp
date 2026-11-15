// Paper trading account: whole shares or contracts, long and short, filled at the
// latest quote. Pure functions so the maths can be unit-tested.
//
// Stocks settle in cash: buying spends cash, selling short adds the proceeds and
// leaves a negative position. Futures exchange no cash when opened; profit or loss
// is counted in the account value while open and moves to cash when closed.
// Margin is simplified: 100% for long stock, 50% for short stock, 10% of contract
// value for futures. There are no margin calls or forced liquidations.

export interface Position { qty: number; avgCost: number; mult?: number; future?: boolean } // qty < 0 is short
export interface Trade { symbol: string; side: 'buy' | 'sell'; qty: number; price: number; time: number; pnl?: number }
export interface Account { start: number; cash: number; realized: number; positions: Record<string, Position>; trades: Trade[] }
export interface Order { symbol: string; side: 'buy' | 'sell'; qty: number; price: number; time?: number; mult?: number; future?: boolean }

export const START_CASH = 100_000;
export const MARGIN = { long: 1, short: 0.5, future: 0.1 };
export const newAccount = (): Account => ({ start: START_CASH, cash: START_CASH, realized: 0, positions: {}, trades: [] });
const cents = (v: number) => Math.round(v * 100) / 100;

export interface Row {
  symbol: string; qty: number; avgCost: number; price: number; priced: boolean; mult: number; future: boolean; short: boolean;
  exposure: number; // size of the position in dollars, always positive
  pnl: number; pnlPct: number; weight: number; // weight: exposure as % of account value
}
export interface Breakdown {
  rows: Row[]; cash: number; equity: number; longExp: number; shortExp: number; required: number; buyingPower: number;
  unrealized: number; realized: number; total: number; totalPct: number;
}

// Positions without a live price are valued at cost and flagged.
export function breakdown(a: Account, prices: Record<string, number | undefined>): Breakdown {
  let equity = a.cash;
  let required = 0;
  const rows: Row[] = Object.entries(a.positions).map(([symbol, p]) => {
    const live = prices[symbol];
    const priced = typeof live === 'number' && live > 0;
    const price = priced ? live : p.avgCost;
    const mult = p.mult ?? 1;
    const future = !!p.future;
    const short = p.qty < 0;
    const exposure = Math.abs(p.qty) * price * mult;
    const cost = Math.abs(p.qty) * p.avgCost * mult;
    const pnl = (price - p.avgCost) * p.qty * mult;
    equity += future ? pnl : p.qty * price;
    required += exposure * (future ? MARGIN.future : short ? MARGIN.short : MARGIN.long);
    return { symbol, qty: p.qty, avgCost: p.avgCost, price, priced, mult, future, short, exposure, pnl, pnlPct: cost ? (pnl / cost) * 100 : 0, weight: 0 };
  });
  for (const r of rows) r.weight = equity > 0 ? (r.exposure / equity) * 100 : 0;
  rows.sort((x, y) => y.exposure - x.exposure);
  const total = equity - a.start;
  return {
    rows, cash: a.cash, equity, required, buyingPower: equity - required,
    longExp: rows.reduce((s, r) => s + (r.short ? 0 : r.exposure), 0),
    shortExp: rows.reduce((s, r) => s + (r.short ? r.exposure : 0), 0),
    unrealized: rows.reduce((s, r) => s + r.pnl, 0), realized: a.realized, total, totalPct: a.start ? (total / a.start) * 100 : 0,
  };
}

// `prices` are the latest quotes for the other positions, used for the margin check.
export function applyOrder(a: Account, o: Order, prices: Record<string, number | undefined> = {}): Account {
  if (!Number.isInteger(o.qty) || o.qty <= 0) throw new Error(`Quantity must be a whole number of ${o.future ? 'contracts' : 'shares'}, 1 or more.`);
  if (!(o.price > 0)) throw new Error('No price available for this symbol.');
  const held = a.positions[o.symbol];
  const mult = held?.mult ?? o.mult ?? 1;
  const future = held?.future ?? !!o.future;
  const old = held?.qty ?? 0;
  const delta = o.side === 'buy' ? o.qty : -o.qty;
  const qty = old + delta;
  const positions = { ...a.positions };
  const trade: Trade = { symbol: o.symbol, side: o.side, qty: o.qty, price: o.price, time: o.time ?? Date.now() };
  let cash = a.cash;
  let realized = a.realized;
  let avgCost = o.price;

  if (old !== 0 && Math.sign(old) !== Math.sign(delta)) {
    // Closing all or part of the position; anything beyond that opens the other way at this price.
    const closed = Math.min(Math.abs(old), Math.abs(delta));
    trade.pnl = cents((o.price - held.avgCost) * closed * Math.sign(old) * mult);
    realized = cents(realized + trade.pnl);
    if (future) cash = cents(cash + trade.pnl);
    if (Math.abs(delta) <= Math.abs(old)) avgCost = held.avgCost;
  } else if (old !== 0) {
    avgCost = (Math.abs(old) * held.avgCost + Math.abs(delta) * o.price) / Math.abs(qty);
  }
  if (!future) cash = cents(cash - delta * o.price);
  if (qty === 0) delete positions[o.symbol];
  else positions[o.symbol] = { qty, avgCost, ...(mult !== 1 ? { mult } : {}), ...(future ? { future } : {}) };
  const next: Account = { ...a, cash, realized, positions, trades: [trade, ...a.trades].slice(0, 100) };

  // Orders that add risk must fit within buying power; orders that only reduce it always fill.
  const marks = { ...prices, [o.symbol]: o.price };
  const before = breakdown(a, marks);
  const after = breakdown(next, marks);
  if (after.required > before.required + 0.005 && after.buyingPower < -0.005) {
    const need = after.required - before.required;
    throw new Error(`Not enough buying power. This order needs $${need.toFixed(2)} of margin and you have $${Math.max(0, before.buyingPower).toFixed(2)} available.`);
  }
  return next;
}
