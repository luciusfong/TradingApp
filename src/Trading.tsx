import { useCallback, useEffect, useRef, useState } from 'react';
import { errorText } from './lib/http';
import { gatewayBase, gatewayError, ibkrAccounts, ibkrPortfolio, type IbkrAccount, type LivePortfolio } from './lib/ibkr';
import { getQuote } from './lib/market';
import { applyOrder, breakdown, newAccount, START_CASH, type Account } from './lib/paper';
import { syncWidgetPaper } from './lib/native';
import { cleanSymbol, holdingFor, isFuture, labelOf, loadPaper, savePaper, type Holding } from './lib/store';
import { PAPER_EVENT } from './lib/strategyRun';
import { Strategies } from './Strategies';

type Book = 'paper' | 'live';
const money = (v: number) => v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const signed = (v: number, d = 2) => `${v > 0.004 ? '+' : v < -0.004 ? '−' : ''}${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}`;
const tone = (v: number) => (v > 0.004 ? 'pos' : v < -0.004 ? 'neg' : 'flat');
const when = (t: number) => new Date(t).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const clock = (t: number) => new Date(t).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
const ASSET: Record<string, string> = { STK: 'Stock', FUT: 'Future', OPT: 'Option', FOP: 'Futures option', CASH: 'Currency', CRYPTO: 'Crypto', BOND: 'Bond', FUND: 'Fund', CFD: 'CFD', WAR: 'Warrant' };

export function Trading({ list, finnhubKey, onOpen, info, onToggleInfo, gateway, onSettings }: {
  list: Holding[]; finnhubKey: string; onOpen: (symbol: string) => void; info: boolean; onToggleInfo: () => void;
  gateway: string; onSettings: () => void;
}) {
  const [book, setBook] = useState<Book>('paper');
  return (
    <>
      <div className="modes" role="group" aria-label="Account">
        <button aria-pressed={book === 'paper'} onClick={() => setBook('paper')}>Paper</button>
        <button aria-pressed={book === 'live'} onClick={() => setBook('live')}>Live</button>
        <button className="info" aria-pressed={info} aria-label={info ? 'Hide explanations' : 'Show explanations'} onClick={onToggleInfo}>Info</button>
      </div>
      {book === 'paper' && <Paper list={list} finnhubKey={finnhubKey} onOpen={onOpen} info={info} />}
      {book === 'live' && <Live gateway={gateway} onSettings={onSettings} info={info} />}
    </>
  );
}

function Paper({ list, finnhubKey, onOpen, info }: { list: Holding[]; finnhubKey: string; onOpen: (symbol: string) => void; info: boolean }) {
  const [acct, setAcct] = useState<Account>(loadPaper);
  const [prices, setPrices] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(false);
  const [symbol, setSymbol] = useState('');
  const [qty, setQty] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const acctRef = useRef(acct);
  acctRef.current = acct;
  const pricesRef = useRef(prices);
  pricesRef.current = prices;
  const commit = (a: Account) => { acctRef.current = a; setAcct(a); savePaper(a); syncWidgetPaper(a); };

  const held = Object.keys(acct.positions).join(',');
  const refresh = useCallback(async () => {
    const symbols = held ? held.split(',') : [];
    if (!symbols.length) return;
    setLoading(true);
    const res = await Promise.allSettled(symbols.map((s) => getQuote(s, finnhubKey)));
    setPrices((p) => {
      const next = { ...p };
      res.forEach((r, i) => { if (r.status === 'fulfilled') next[symbols[i]] = r.value.price; });
      return next;
    });
    setLoading(false);
  }, [held, finnhubKey]);
  useEffect(() => { refresh(); }, [refresh]);
  // Strategies can change the account while this screen is open.
  useEffect(() => {
    const reload = () => { const a = loadPaper(); acctRef.current = a; setAcct(a); };
    window.addEventListener(PAPER_EVENT, reload);
    return () => window.removeEventListener(PAPER_EVENT, reload);
  }, []);

  const place = async (side: 'buy' | 'sell') => {
    const sym = cleanSymbol(symbol);
    const n = Number(qty);
    if (!sym) return setMsg({ ok: false, text: 'Type a ticker symbol, like AMD.' });
    const future = isFuture(sym);
    const mult = holdingFor(sym).mult;
    if (future && !mult) return setMsg({ ok: false, text: `${labelOf(holdingFor(sym))} cannot be paper traded: it is an index or a contract whose size this app does not know. Try CLmain, NQmain, ESmain, GCmain, HGmain, ZNmain or UBmain.` });
    const unit = future ? (n === 1 ? 'contract' : 'contracts') : n === 1 ? 'share' : 'shares';
    if (!Number.isInteger(n) || n <= 0) return setMsg({ ok: false, text: `Quantity must be a whole number of ${future ? 'contracts' : 'shares'}, 1 or more.` });
    setBusy(true);
    try {
      const q = await getQuote(sym, finnhubKey);
      const before = acctRef.current.positions[sym]?.qty ?? 0;
      commit(applyOrder(acctRef.current, { symbol: sym, side, qty: n, price: q.price, mult, future }, pricesRef.current));
      setPrices((p) => ({ ...p, [sym]: q.price }));
      const verb = side === 'buy' ? (before < 0 ? 'Bought to cover' : 'Bought') : before <= 0 ? 'Sold short' : n > before ? 'Sold and went short' : 'Sold';
      setMsg({ ok: true, text: `${verb} ${n} ${labelOf(holdingFor(sym))} ${unit} at ${money(q.price)}.` });
      setQty('');
    } catch (e) {
      setMsg({ ok: false, text: errorText(e) });
    }
    setBusy(false);
  };

  const b = breakdown(acct, prices);
  const name = (s: string) => list.find((h) => h.symbol === s) ?? holdingFor(s);
  const unpriced = b.rows.filter((r) => !r.priced).length;
  const ofEquity = (v: number) => (b.equity > 0 ? `${((v / b.equity) * 100).toFixed(0)}%` : '—');
  return (
    <>
      <section className="acct">
        <div className="lbl">Paper account value</div>
        <div className="px num">${money(b.equity)}</div>
        <div className={`chg num ${tone(b.total)}`}>{signed(b.total)} ({signed(b.totalPct)}%) since start</div>
        <dl className="kv num">
          <div><dt>Cash</dt><dd>${money(b.cash)}</dd></div>
          <div><dt>Buying power</dt><dd>${money(Math.max(0, b.buyingPower))}</dd></div>
          <div><dt>Open P/L</dt><dd className={tone(b.unrealized)}>{signed(b.unrealized)}</dd></div>
          <div><dt>Closed P/L</dt><dd className={tone(b.realized)}>{signed(b.realized)}</dd></div>
        </dl>
      </section>

      <div className="section-h">
        <h2>Position breakdown</h2>
        {b.rows.length > 0 && <button onClick={refresh}>{loading ? 'Loading' : 'Refresh prices'}</button>}
      </div>
      {b.rows.length === 0 ? (
        <p className="note">No positions yet.{info ? ' Place a paper order below; it fills at the latest quote using pretend money. Selling something you do not hold opens a short.' : ''}</p>
      ) : (
        <>
          <div className="alloc" role="img" aria-label={`Long ${ofEquity(b.longExp)} of account value, short ${ofEquity(b.shortExp)}`}>
            {b.rows.map((r) => <i key={r.symbol} className={r.short ? 'short' : ''} style={{ flexGrow: Math.max(r.exposure, 1) }} />)}
          </div>
          <div className="alloc-key num"><span>Long ${money(b.longExp)} ({ofEquity(b.longExp)})</span><span>Short ${money(b.shortExp)} ({ofEquity(b.shortExp)})</span></div>
          <ul className="ledger">
            {b.rows.map((r) => {
              const h = name(r.symbol);
              return (
                <li key={r.symbol}>
                  <button className="qrow" onClick={() => onOpen(r.symbol)}>
                    <span className="who"><span className="sym">{labelOf(h)}</span><span className="name">{h.name}</span></span>
                    <span className="tr num">${money(r.exposure)}</span>
                    <span className="why num">
                      <b className={r.short ? 'neg' : 'pos'}>{r.short ? 'Short' : 'Long'}</b> {Math.abs(r.qty)} {r.future ? (Math.abs(r.qty) === 1 ? 'contract' : 'contracts') : Math.abs(r.qty) === 1 ? 'share' : 'shares'}
                      {r.future ? ` × ${r.mult.toLocaleString('en-US')}` : ''}, average {money(r.avgCost)}, {r.priced ? `now ${money(r.price)}` : 'price unavailable'}
                    </span>
                    <span className="stats num">
                      <span className={tone(r.pnl)}>P/L {signed(r.pnl)} ({signed(r.pnlPct, 1)}%)</span>
                      <span>{r.weight.toFixed(1)}% of account</span>
                    </span>
                    <span className="wbar"><i className={r.short ? 'short' : ''} style={{ width: `${Math.min(100, r.weight)}%` }} /></span>
                  </button>
                </li>
              );
            })}
          </ul>
          {unpriced > 0 && !loading && <p className="note">{unpriced} {unpriced === 1 ? 'position has' : 'positions have'} no live price and {unpriced === 1 ? 'is' : 'are'} shown at cost.</p>}
        </>
      )}

      <div className="section-h"><h2>Paper order</h2><span className="hint">Fills at the latest quote</span></div>
      <div className="order">
        <input value={symbol} onChange={(e) => setSymbol(e.target.value)} placeholder="Ticker" aria-label="Ticker symbol" autoCapitalize="characters" autoCorrect="off" spellCheck={false} />
        <input value={qty} onChange={(e) => setQty(e.target.value.replace(/\D/g, ''))} placeholder="Qty" aria-label="Number of shares or contracts" inputMode="numeric" />
        <button className="btn" disabled={busy || !symbol.trim() || !qty} onClick={() => place('buy')}>Buy</button>
        <button className="btn sell" disabled={busy || !symbol.trim() || !qty} onClick={() => place('sell')}>Sell</button>
      </div>
      {msg && (msg.ok ? <p className="note">{msg.text}</p> : <div className="err">{msg.text}</div>)}

      <Strategies acct={acct} prices={prices} finnhubKey={finnhubKey} info={info} />

      {acct.trades.length > 0 && (
        <>
          <div className="section-h"><h2>Recent paper trades</h2></div>
          <ul className="ledger">
            {acct.trades.slice(0, 10).map((t, i) => (
              <li key={`${t.time}-${i}`} className="trade num">
                <span><b className={t.side === 'buy' ? 'pos' : 'neg'}>{t.side === 'buy' ? 'Buy' : 'Sell'}</b> {t.qty} {labelOf(name(t.symbol))} at {money(t.price)}</span>
                <span className="flat">{t.pnl !== undefined && <span className={tone(t.pnl)}>{signed(t.pnl)} </span>}{when(t.time)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      <button
        className="remove"
        onClick={() => {
          if (!confirmReset) return setConfirmReset(true);
          commit(newAccount()); setPrices({}); setMsg(null); setConfirmReset(false);
        }}
      >
        {confirmReset ? 'Tap again to erase all paper positions and trades' : `Reset paper account to $${START_CASH.toLocaleString('en-US')}`}
      </button>
      {info && <p className="fine pad">Paper trading uses pretend money, filled instantly at the last quote, which can be delayed, with no fees, borrow costs or dividends. Margin is simplified: long stock is paid in full, a short needs 50% of its value, and futures need 10% of contract value. Real brokers set different margins per contract and will close positions that run out of margin; this account does not. Not investment advice.</p>}
    </>
  );
}

// Read-only view of an IBKR account through the Client Portal Gateway. Nothing here can place an order.
function Live({ gateway, onSettings, info }: { gateway: string; onSettings: () => void; info: boolean }) {
  const base = gatewayBase(gateway);
  const [accounts, setAccounts] = useState<IbkrAccount[]>([]);
  const [account, setAccount] = useState('');
  const [data, setData] = useState<LivePortfolio | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [at, setAt] = useState(0);

  const load = useCallback(async (pick?: string) => {
    if (!base) return;
    setLoading(true);
    setError('');
    try {
      const list = await ibkrAccounts(base);
      const id = pick && list.some((a) => a.id === pick) ? pick : list[0].id;
      setAccounts(list);
      setAccount(id);
      setData(await ibkrPortfolio(base, id));
      setAt(Date.now());
    } catch (e) {
      setError(gatewayError(e));
    }
    setLoading(false);
  }, [base]);
  useEffect(() => { load(); }, [load]);

  if (!base) {
    return (
      <>
        <div className="empty-state">
          <b>No broker connected</b>
          <span>Enter the address of your IBKR Client Portal Gateway in Settings to see your live account and positions here. The view is read-only.</span>
          <button className="btn" onClick={onSettings}>Open Settings</button>
        </div>
      </>
    );
  }
  const s = data?.summary;
  const cur = s?.currency ?? '';
  const amount = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${money(v)}${cur ? ` ${cur}` : ''}`);
  return (
    <>
      <section className="acct">
        <div className="lbl">
          IBKR net liquidation
          {accounts.length > 1 ? (
            <select className="acct-pick" value={account} aria-label="Account" onChange={(e) => load(e.target.value)}>
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.id}</option>)}
            </select>
          ) : account ? `, ${account}` : ''}
        </div>
        <div className="px num">{s ? amount(s.netLiq) : loading ? <span className="spin">…</span> : '—'}</div>
        {s && (
          <dl className="kv num">
            <div><dt>Cash</dt><dd>{amount(s.cash)}</dd></div>
            <div><dt>Buying power</dt><dd>{amount(s.buyingPower)}</dd></div>
            <div><dt>Available funds</dt><dd>{amount(s.available)}</dd></div>
            <div><dt>Positions</dt><dd>{data.positions.length}</dd></div>
          </dl>
        )}
      </section>
      {error && <div className="err">{error}</div>}

      <div className="section-h">
        <h2>Position breakdown</h2>
        <button onClick={() => load(account)}>{loading ? 'Loading' : at ? `${clock(at)} · Refresh` : 'Refresh'}</button>
      </div>
      {data && data.positions.length === 0 && <p className="note">No open positions in this account.</p>}
      {data && data.positions.length > 0 && (
        <ul className="ledger">
          {data.positions.map((r) => {
            const short = r.qty < 0;
            // A share of the account only makes sense when the position is in the account's currency.
            const weight = s?.netLiq && r.currency === cur ? (Math.abs(r.value) / s.netLiq) * 100 : null;
            return (
              <li key={r.key}>
                <div className="qrow">
                  <span className="who"><span className="sym">{r.symbol}</span><span className="name">{r.desc !== r.symbol ? r.desc : ASSET[r.assetClass] ?? r.assetClass}</span></span>
                  <span className="tr num">{money(Math.abs(r.value))} {r.currency}</span>
                  <span className="why num">
                    <b className={short ? 'neg' : 'pos'}>{short ? 'Short' : 'Long'}</b> {Math.abs(r.qty).toLocaleString('en-US')}, average cost {money(r.avgCost)}, now {money(r.price)}
                  </span>
                  <span className="stats num">
                    <span className={tone(r.pnl)}>P/L {signed(r.pnl)}{r.pnlPct === null ? '' : ` (${signed(r.pnlPct, 1)}%)`}</span>
                    {weight !== null && <span>{weight.toFixed(1)}% of account</span>}
                  </span>
                  {weight !== null && <span className="wbar"><i className={short ? 'short' : ''} style={{ width: `${Math.min(100, weight)}%` }} /></span>}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {info && (
        <p className="fine pad">
          Read-only figures from your IBKR Client Portal Gateway; they are IBKR's own values and can lag the market. The gateway must be
          running and logged in on your computer, and IBKR asks for a fresh login about once a day. This app cannot place live orders.
        </p>
      )}
    </>
  );
}
