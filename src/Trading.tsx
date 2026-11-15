import { useCallback, useEffect, useRef, useState } from 'react';
import { errorText } from './lib/http';
import { getQuote } from './lib/market';
import { applyOrder, breakdown, newAccount, START_CASH, type Account } from './lib/paper';
import { syncWidgetPaper } from './lib/widget';
import { cleanSymbol, holdingFor, isFuture, labelOf, loadPaper, savePaper, type Holding } from './lib/store';

type Book = 'paper' | 'live';
const money = (v: number) => v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const signed = (v: number, d = 2) => `${v > 0.004 ? '+' : v < -0.004 ? '−' : ''}${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}`;
const tone = (v: number) => (v > 0.004 ? 'pos' : v < -0.004 ? 'neg' : 'flat');
const when = (t: number) => new Date(t).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

export function Trading({ list, finnhubKey, onOpen, info, onToggleInfo }: {
  list: Holding[]; finnhubKey: string; onOpen: (symbol: string) => void; info: boolean; onToggleInfo: () => void;
}) {
  const [book, setBook] = useState<Book>('paper');
  return (
    <>
      <div className="modes" role="group" aria-label="Account">
        <button aria-pressed={book === 'paper'} onClick={() => setBook('paper')}>Paper</button>
        <button aria-pressed={book === 'live'} onClick={() => setBook('live')}>Live</button>
        <button className="info" aria-pressed={info} aria-label={info ? 'Hide explanations' : 'Show explanations'} onClick={onToggleInfo}>Info</button>
      </div>
      {book === 'paper' ? <Paper list={list} finnhubKey={finnhubKey} onOpen={onOpen} info={info} /> : <Live />}
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

function Live() {
  return (
    <>
      <div className="empty-state">
        <b>No broker connected</b>
        <span>Live trading is not set up in this version. Once a broker account is linked, real orders and balances will show here.</span>
      </div>
      <div className="section-h"><h2>Position breakdown</h2></div>
      <p className="note">Your live positions, their value, profit or loss and share of the account will be listed here after a broker is connected.</p>
    </>
  );
}
