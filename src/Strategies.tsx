import { useEffect, useMemo, useState } from 'react';
import { breakdown, type Account } from './lib/paper';
import { cleanSymbol, isFuture } from './lib/store';
import { loadLog, loadRules, rebalancePlan, saveRules, type PriceRule, type RebalanceRule, type Rule } from './lib/strategy';
import { checkStrategies, PAPER_EVENT } from './lib/strategyRun';

const fmt = (v: number) => v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const when = (t: number) => new Date(t).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const id = () => Math.random().toString(36).slice(2, 10);
const numOrNull = (s: string) => (s.trim() === '' ? null : Number(s));

export function Strategies({ acct, prices, finnhubKey, info }: { acct: Account; prices: Record<string, number>; finnhubKey: string; info: boolean }) {
  const [rules, setRules] = useState<Rule[]>(loadRules);
  const [log, setLog] = useState(loadLog);
  const [form, setForm] = useState<'' | 'price' | 'rebalance'>('');
  const [busy, setBusy] = useState('');
  useEffect(() => {
    const reload = () => { setRules(loadRules()); setLog(loadLog()); };
    window.addEventListener(PAPER_EVENT, reload);
    return () => window.removeEventListener(PAPER_EVENT, reload);
  }, []);
  const save = (r: Rule[]) => { setRules(r); saveRules(r); };
  const held = Object.entries(acct.positions).filter(([, p]) => p.qty > 0 && !p.future).map(([s]) => s);

  const runNow = async (ruleId?: string) => {
    setBusy(ruleId ?? 'all');
    await checkStrategies(finnhubKey, ruleId).catch(() => undefined);
    setRules(loadRules());
    setLog(loadLog());
    setBusy('');
  };

  return (
    <>
      <div className="section-h">
        <h2>Strategies</h2>
        {rules.some((r) => r.on) && <button onClick={() => runNow()}>{busy === 'all' ? 'Checking' : 'Check now'}</button>}
      </div>
      <div className="row2 pad">
        <button className="btn sell" aria-pressed={form === 'price'} onClick={() => setForm(form === 'price' ? '' : 'price')}>+ Target price</button>
        <button className="btn sell" aria-pressed={form === 'rebalance'} onClick={() => setForm(form === 'rebalance' ? '' : 'rebalance')}>+ Rebalance</button>
      </div>
      {form === 'price' && <PriceForm held={held} acct={acct} onCancel={() => setForm('')} onSave={(r) => { save([r, ...rules]); setForm(''); }} />}
      {form === 'rebalance' && <RebalanceForm acct={acct} prices={prices} onCancel={() => setForm('')} onSave={(r) => { save([r, ...rules.filter((x) => x.kind !== 'rebalance')]); setForm(''); }} />}

      {rules.length === 0 && !form && <p className="note">No strategies yet. A target price sells a holding when it reaches a price; a rebalance keeps holdings at set shares of the account.</p>}
      {rules.length > 0 && (
        <ul className="ledger">
          {rules.map((r) => (
            <li key={r.id} className="trade rule">
              <span>
                {r.kind === 'price' ? <PriceText r={r} /> : <RebalanceText r={r} acct={acct} prices={prices} />}
                <br />
                <span className={r.on ? 'pos' : 'flat'}>{r.on ? 'Active' : r.kind === 'price' ? 'Done or paused' : 'Paused'}</span>
              </span>
              <span className="acts">
                {r.kind === 'rebalance' && r.on && <button className="link" disabled={busy !== ''} onClick={() => runNow(r.id)}>{busy === r.id ? 'Working' : 'Rebalance now'}</button>}
                <button className="link" onClick={() => save(rules.map((x) => (x.id === r.id ? { ...x, on: !x.on } : x)))}>{r.on ? 'Pause' : 'Resume'}</button>
                <button className="link danger" onClick={() => save(rules.filter((x) => x.id !== r.id))}>Delete</button>
              </span>
            </li>
          ))}
        </ul>
      )}
      {log.length > 0 && (
        <>
          <div className="section-h"><h2>Strategy activity</h2></div>
          <ul className="ledger">
            {log.slice(0, 8).map((f, i) => (
              <li key={`${f.time}-${i}`} className="trade num"><span className={f.ok ? '' : 'neg'}>{f.text}</span><span className="flat">{when(f.time)}</span></li>
            ))}
          </ul>
        </>
      )}
      {info && (
        <p className="fine pad">
          Strategies act on the paper account only. They are checked when the app opens and every minute while it is open, and fill at the
          quote at that moment, which can be past your price if it moved quickly or the app was closed. For real money, set a limit or stop
          order with your broker instead: the broker watches the price even when your phone is off.
        </p>
      )}
    </>
  );
}

function PriceText({ r }: { r: PriceRule }) {
  const parts = [r.takeProfit !== null && `sell at ${fmt(r.takeProfit)} or above`, r.stopLoss !== null && `stop at ${fmt(r.stopLoss)} or below`].filter(Boolean);
  return <><b>{r.symbol}</b>: {parts.join(', ')}; {r.qty === null ? 'whole position' : `${r.qty} shares`}</>;
}

function RebalanceText({ r, acct, prices }: { r: RebalanceRule; acct: Account; prices: Record<string, number> }) {
  const plan = useMemo(() => rebalancePlan(acct, r.targets, prices), [acct, r.targets, prices]);
  return (
    <>
      <b>Rebalance</b>: {r.targets.map((t) => `${t.symbol} ${t.weight}%`).join(', ')}
      {r.auto ? `; automatic beyond ${r.drift} points` : '; manual'}
      {!plan.missing.length && <span className="flat"> · drift now {plan.drift.toFixed(1)} points</span>}
    </>
  );
}

function PriceForm({ held, acct, onSave, onCancel }: { held: string[]; acct: Account; onSave: (r: PriceRule) => void; onCancel: () => void }) {
  const [symbol, setSymbol] = useState(held[0] ?? '');
  const [tp, setTp] = useState('');
  const [sl, setSl] = useState('');
  const [qty, setQty] = useState('');
  const [err, setErr] = useState('');
  const submit = () => {
    const sym = cleanSymbol(symbol);
    const takeProfit = numOrNull(tp);
    const stopLoss = numOrNull(sl);
    const q = numOrNull(qty);
    if (!sym) return setErr('Choose a holding.');
    if (isFuture(sym)) return setErr('Target prices cover stocks and ETFs.');
    if (takeProfit === null && stopLoss === null) return setErr('Enter a target price, a stop price, or both.');
    if ((takeProfit !== null && !(takeProfit > 0)) || (stopLoss !== null && !(stopLoss > 0))) return setErr('Prices must be above zero.');
    if (takeProfit !== null && stopLoss !== null && stopLoss >= takeProfit) return setErr('The stop must be below the target.');
    if (q !== null && !(Number.isInteger(q) && q > 0)) return setErr('Shares must be a whole number, or blank for the whole position.');
    onSave({ id: id(), kind: 'price', symbol: sym, takeProfit, stopLoss, qty: q, on: true, created: Date.now() });
  };
  return (
    <div className="wform card">
      <label>Holding
        {held.length ? (
          <select value={symbol} onChange={(e) => setSymbol(e.target.value)}>{held.map((s) => <option key={s} value={s}>{s}, {acct.positions[s].qty} shares, avg {fmt(acct.positions[s].avgCost)}</option>)}</select>
        ) : <input value={symbol} onChange={(e) => setSymbol(e.target.value)} placeholder="Ticker you will buy" autoCapitalize="characters" />}
      </label>
      <label>Sell when the price reaches (take profit)<input value={tp} onChange={(e) => setTp(e.target.value)} inputMode="decimal" placeholder="Optional" /></label>
      <label>Sell when the price falls to (stop loss)<input value={sl} onChange={(e) => setSl(e.target.value)} inputMode="decimal" placeholder="Optional" /></label>
      <label>Shares to sell<input value={qty} onChange={(e) => setQty(e.target.value.replace(/\D/g, ''))} inputMode="numeric" placeholder="Blank = whole position" /></label>
      {err && <div className="err flush">{err}</div>}
      <div className="row2"><button className="btn" onClick={submit}>Save strategy</button><button className="btn quiet" onClick={onCancel}>Cancel</button></div>
    </div>
  );
}

function RebalanceForm({ acct, prices, onSave, onCancel }: { acct: Account; prices: Record<string, number>; onSave: (r: RebalanceRule) => void; onCancel: () => void }) {
  // Starts from the current holdings and their weights.
  const start = breakdown(acct, prices).rows.filter((r) => !r.future && !r.short).map((r) => ({ symbol: r.symbol, weight: String(Math.round(r.weight)) }));
  const [rows, setRows] = useState(start.length ? start : [{ symbol: '', weight: '' }]);
  const [drift, setDrift] = useState('5');
  const [auto, setAuto] = useState(true);
  const [err, setErr] = useState('');
  const total = rows.reduce((s, r) => s + (Number(r.weight) || 0), 0);
  const set = (i: number, k: 'symbol' | 'weight', v: string) => setRows(rows.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  const submit = () => {
    const targets = rows.filter((r) => r.symbol.trim()).map((r) => ({ symbol: cleanSymbol(r.symbol), weight: Number(r.weight) }));
    const d = Number(drift);
    if (!targets.length) return setErr('Add at least one holding.');
    if (targets.some((t) => !t.symbol || !(t.weight > 0))) return setErr('Each line needs a ticker and a weight above 0.');
    if (targets.some((t) => isFuture(t.symbol))) return setErr('Rebalancing covers stocks and ETFs, not futures.');
    if (new Set(targets.map((t) => t.symbol)).size !== targets.length) return setErr('Each ticker can appear once.');
    if (targets.reduce((s, t) => s + t.weight, 0) > 100) return setErr('Weights add up to more than 100%.');
    if (!(d >= 1 && d <= 50)) return setErr('The drift limit must be between 1 and 50 points.');
    onSave({ id: id(), kind: 'rebalance', targets, drift: d, auto, on: true, created: Date.now() });
  };
  return (
    <div className="wform card">
      <span className="flat">Target share of the account for each holding. What is not allocated stays in cash. Holdings not listed are left alone.</span>
      {rows.map((r, i) => (
        <div key={i} className="row2">
          <input value={r.symbol} onChange={(e) => set(i, 'symbol', e.target.value)} placeholder="Ticker" autoCapitalize="characters" aria-label="Ticker" />
          <input value={r.weight} onChange={(e) => set(i, 'weight', e.target.value.replace(/[^\d.]/g, ''))} inputMode="decimal" placeholder="%" aria-label="Weight in percent" />
          <button className="link danger" onClick={() => setRows(rows.filter((_, j) => j !== i))}>Remove</button>
        </div>
      ))}
      <button className="link" onClick={() => setRows([...rows, { symbol: '', weight: '' }])}>+ Add holding</button>
      <span className={total > 100 ? 'neg' : 'flat'}>Allocated {total.toFixed(0)}%, cash {Math.max(0, 100 - total).toFixed(0)}%</span>
      <label>Rebalance automatically when a holding strays this many points<input value={drift} onChange={(e) => setDrift(e.target.value.replace(/[^\d.]/g, ''))} inputMode="decimal" /></label>
      <label className="check"><input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> Automatic (otherwise only when you tap Rebalance now)</label>
      {err && <div className="err flush">{err}</div>}
      <div className="row2"><button className="btn" onClick={submit}>Save strategy</button><button className="btn quiet" onClick={onCancel}>Cancel</button></div>
    </div>
  );
}
