import { useEffect, useMemo, useState } from 'react';
import { errorText } from './lib/http';
import { getSeries } from './lib/market';
import { getFundamentals, isCached, QUALITY_CHECKS, rankFundamentals, VERDICT_TEXT, type Fundamentals } from './lib/fundamentals';
import { macroRead, macroRow, quantRow, rankTemplate, SIGNAL_TEXT, TEMPLATE_SHORT, trendTemplate, turtle, type MacroRow, type QuantRow, type TemplateRow, type Trend, type TurtleState } from './lib/screen';
import { CATALOG, holdingFor, isFuture, labelOf, LARGE_CAPS, MACRO_SET, type Holding } from './lib/store';

type Mode = 'macro' | 'quant' | 'tech' | 'funda';
const MODE_NAME: Record<Mode, string> = { macro: 'Macro', quant: 'Quant', tech: 'Technical', funda: 'Fundamental' };
type Universe = 'watchlist' | 'large';

// One year of daily closes per symbol, kept for 15 minutes so switching views is instant.
const cache = new Map<string, { closes: number[]; at: number }>();
const TTL = 15 * 60_000;
let handledNonce = 0;
let fundaNonce = 0;

async function closesFor(symbol: string, force: boolean): Promise<number[]> {
  const hit = cache.get(symbol);
  if (hit && !force && Date.now() - hit.at < TTL) return hit.closes;
  const s = await getSeries(symbol, '1Y');
  cache.set(symbol, { closes: s.c, at: Date.now() });
  return s.c;
}

function useCloses(symbols: string[], nonce: number) {
  const [state, setState] = useState<{ data: Record<string, number[]>; done: number; failed: number; error?: string; loading: boolean }>({ data: {}, done: 0, failed: 0, loading: true });
  const keyStr = symbols.join(',');
  useEffect(() => {
    let live = true;
    const data: Record<string, number[]> = {};
    let failed = 0;
    let firstError: string | undefined;
    // Refetch only when Refresh was pressed, not when switching views afterwards.
    const force = nonce !== handledNonce;
    handledNonce = nonce;
    setState({ data: {}, done: 0, failed: 0, loading: symbols.length > 0 });
    (async () => {
      for (let i = 0; i < symbols.length; i++) {
        const cached = cache.get(symbols[i]);
        const fresh = !force && !!cached && Date.now() - cached.at < TTL;
        try {
          data[symbols[i]] = await closesFor(symbols[i], force);
        } catch (e) {
          failed++;
          firstError ??= errorText(e);
        }
        if (!live) return;
        setState({ data: { ...data }, done: i + 1, failed, loading: i + 1 < symbols.length, error: failed === i + 1 ? firstError : undefined });
        if (!fresh) await new Promise((r) => setTimeout(r, 120));
      }
    })();
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyStr, nonce]);
  return state;
}

const pct = (v: number | null, d = 1) => {
  if (v === null) return '—';
  const body = Math.abs(v).toFixed(d);
  return `${Number(body) === 0 ? '' : v > 0 ? '+' : '−'}${body}%`;
};
const tone = (v: number | null) => (v === null || Math.abs(v) < 0.05 ? 'flat' : v > 0 ? 'pos' : 'neg');
const TREND: Record<Trend, { mark: string; text: string; cls: string }> = {
  up: { mark: '▲', text: 'Uptrend', cls: 'pos' },
  down: { mark: '▼', text: 'Downtrend', cls: 'neg' },
  mixed: { mark: '◆', text: 'Mixed', cls: 'flat' },
};

function Spark({ data, label }: { data: number[]; label: string }) {
  if (data.length < 2) return null;
  const lo = Math.min(...data);
  const hi = Math.max(...data);
  const span = hi - lo || 1;
  const d = data.map((v, i) => `${i ? 'L' : 'M'}${((i / (data.length - 1)) * 68 + 2).toFixed(1)},${(22 - ((v - lo) / span) * 20).toFixed(1)}`).join('');
  return (
    <svg className="spark" viewBox="0 0 72 24" role="img" aria-label={label}>
      <path d={d} fill="none" stroke="var(--line)" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

export function Screener({ list, onOpen, finnhubKey, onSettings, info, onToggleInfo }: {
  list: Holding[]; onOpen: (symbol: string) => void; finnhubKey: string; onSettings: () => void; info: boolean; onToggleInfo: () => void;
}) {
  const [mode, setMode] = useState<Mode>('macro');
  const [universe, setUniverse] = useState<Universe>('watchlist');
  const [nonce, setNonce] = useState(0);

  const stocks = useMemo(
    () => (universe === 'large' ? LARGE_CAPS : list.map((h) => h.symbol).filter((s) => !isFuture(s))),
    [universe, list],
  );
  const futures = useMemo(() => [...new Set([...MACRO_SET, ...list.map((h) => h.symbol).filter(isFuture)])], [list]);
  const symbols = useMemo(() => {
    if (mode === 'macro') return MACRO_SET;
    if (mode === 'quant') return universe === 'large' ? LARGE_CAPS : list.map((h) => h.symbol);
    if (mode === 'tech') return [...stocks, ...futures];
    return [];
  }, [mode, universe, list, stocks, futures]);
  const st = useCloses(symbols, nonce);
  const name = (s: string) => list.find((h) => h.symbol === s) ?? holdingFor(s);
  const pick = (
    <div className="ranges" role="group" aria-label="Stocks to screen">
      <button aria-pressed={universe === 'watchlist'} onClick={() => setUniverse('watchlist')}>My watchlist</button>
      <button aria-pressed={universe === 'large'} onClick={() => setUniverse('large')}>30 large caps</button>
    </div>
  );

  return (
    <>
      <div className="modes" role="group" aria-label="Screen type">
        {(Object.keys(MODE_NAME) as Mode[]).map((m) => (
          <button key={m} aria-pressed={mode === m} onClick={() => setMode(m)}>{MODE_NAME[m]}</button>
        ))}
        <button className="info" aria-pressed={info} aria-label={info ? 'Hide descriptions' : 'Show descriptions'} onClick={onToggleInfo}>Info</button>
      </div>
      {mode !== 'funda' && (
        <div className="refresh">
          <button className="link" onClick={() => setNonce((n) => n + 1)}>{st.loading ? `Loading ${st.done} of ${symbols.length}` : 'Refresh prices'}</button>
        </div>
      )}
      {mode !== 'funda' && st.error && <div className="err">{st.error}</div>}
      {mode !== 'funda' && !st.error && st.failed > 0 && !st.loading && <p className="note">{st.failed} of {symbols.length} symbols could not be loaded.</p>}
      {mode === 'macro' && <Macro data={st.data} onOpen={onOpen} loading={st.loading} info={info} />}
      {mode === 'quant' && <Quant data={st.data} symbols={symbols} name={name} onOpen={onOpen} pick={pick} loading={st.loading} info={info} />}
      {mode === 'tech' && <Technical data={st.data} stocks={stocks} futures={futures} name={name} onOpen={onOpen} pick={pick} loading={st.loading} info={info} />}
      {mode === 'funda' && <Fundamental stocks={stocks} name={name} onOpen={onOpen} pick={pick} finnhubKey={finnhubKey} onSettings={onSettings} info={info} />}
    </>
  );
}

function Macro({ data, onOpen, loading, info }: { data: Record<string, number[]>; onOpen: (s: string) => void; loading: boolean; info: boolean }) {
  const rows = useMemo(() => {
    const r: Record<string, MacroRow> = {};
    for (const s of MACRO_SET) if (data[s]?.length > 60) r[s] = macroRow(s, data[s]);
    return r;
  }, [data]);
  const reads = useMemo(() => (loading ? [] : macroRead(rows)), [rows, loading]);
  const aligned = Object.values(rows).filter((r) => r.trend !== 'mixed').sort((a, b) => Math.abs(b.r3m ?? 0) - Math.abs(a.r3m ?? 0));

  return (
    <>
      {info && <p className="note">Top-down view in the style of Stanley Druckenmiller: read liquidity from bonds and the dollar first, then follow the strongest trends that agree with it.</p>}
      {reads.length > 0 && (
        <ul className="reads">
          {reads.map((r) => (
            <li key={r.title} className={r.tone}>
              <b>{r.title}</b>
              <span>{r.text}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="section-h"><h2>Cross-asset trends</h2><span className="hint">1 month, 3 months</span></div>
      <ul className="ledger">
        {MACRO_SET.map((s) => {
          const r = rows[s];
          const h = CATALOG[s];
          return (
            <li key={s}>
              <button className="srow" onClick={() => onOpen(s)}>
                <span className="who"><span className="sym">{labelOf(h)}</span><span className="name">{h.name}</span></span>
                {r ? (
                  <>
                    <Spark data={r.spark} label={`${h.name}, last 3 months`} />
                    <span className={`tr ${TREND[r.trend].cls}`}>{TREND[r.trend].mark} {TREND[r.trend].text}</span>
                    <span className="nums num"><span className={tone(r.r1m)}>{pct(r.r1m)}</span><span className={tone(r.r3m)}>{pct(r.r3m)}</span></span>
                  </>
                ) : <span className="skel">{loading ? 'Loading' : 'No data'}</span>}
              </button>
            </li>
          );
        })}
      </ul>
      {aligned.length > 0 && !loading && (
        <p className="note">
          Clearest trends now: {aligned.slice(0, 4).map((r) => `${labelOf(CATALOG[r.symbol])} ${r.trend === 'up' ? 'up' : 'down'} ${pct(r.r3m)} in 3 months`).join('; ')}.
        </p>
      )}
      {info && <p className="fine pad">Uptrend means price is above its 50-day average and the 50-day is above the 200-day. Downtrend is the reverse. This is a rules-based summary of price trends, not investment advice.</p>}
    </>
  );
}

function Quant(p: {
  data: Record<string, number[]>; symbols: string[]; name: (s: string) => Holding; onOpen: (s: string) => void;
  pick: React.ReactNode; loading: boolean; info: boolean;
}) {
  const rows = useMemo(() => {
    const out: QuantRow[] = [];
    for (const s of p.symbols) if (p.data[s]?.length > 25) out.push(quantRow(s, p.data[s]));
    return out.sort((a, b) => b.strength - a.strength);
  }, [p.data, p.symbols]);
  const hits = rows.filter((r) => r.signal !== 'none');
  const rest = rows.filter((r) => r.signal === 'none');

  return (
    <>
      {p.info && <p className="note">Statistical screen in the spirit of Jim Simons: ignore the story, rank by numbers. Short-term stretch (z-score, RSI) checked against the long-term trend, plus 6-month momentum.</p>}
      {p.pick}
      <div className="section-h"><h2>Signals</h2><span className="hint">{hits.length} of {rows.length}</span></div>
      {hits.length === 0 && <p className="note">{p.loading ? 'Scanning' : 'Nothing is statistically stretched right now. That is the normal state on most days.'}</p>}
      <ul className="ledger">
        {hits.map((r) => {
          const h = p.name(r.symbol);
          const sig = SIGNAL_TEXT[r.signal];
          return (
            <li key={r.symbol}>
              <button className="qrow" onClick={() => p.onOpen(r.symbol)}>
                <span className="who"><span className="sym">{labelOf(h)}</span><span className="name">{h.name}</span></span>
                <span className={`tr ${sig.tone}`}>{sig.label}</span>
                <span className="why">{sig.why}</span>
                <Stats r={r} />
              </button>
            </li>
          );
        })}
      </ul>
      {rest.length > 0 && (
        <>
          <div className="section-h"><h2>No signal</h2><span className="hint">z-score, RSI(2), 6-month</span></div>
          <ul className="ledger">
            {rest.map((r) => (
              <li key={r.symbol}>
                <button className="qrow slim" onClick={() => p.onOpen(r.symbol)}>
                  <span className="who"><span className="sym">{labelOf(p.name(r.symbol))}</span></span>
                  <Stats r={r} short />
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {p.info && <p className="fine pad">
        z-score is how many standard deviations the price sits from its 20-day average. RSI(2) below 5 or above 95 marks a short-term extreme.
        Renaissance's real models are secret and far more complex; this is a simple, transparent screen built on the same idea of trading statistics rather than opinions. Not investment advice.
      </p>}
    </>
  );
}

function Stats({ r, short }: { r: QuantRow; short?: boolean }) {
  return (
    <span className="stats num">
      <span>z {r.z === null ? '—' : `${r.z > 0 ? '+' : r.z < 0 ? '−' : ''}${Math.abs(r.z).toFixed(1)}`}</span>
      <span>RSI {r.rsi2 === null ? '—' : r.rsi2.toFixed(0)}</span>
      <span className={tone(r.mom)}>{pct(r.mom, 0)}{short ? '' : ' 6-mo'}</span>
      {!short && <span>Vol {r.vol === null ? '—' : `${r.vol.toFixed(0)}%`}</span>}
    </span>
  );
}

const px = (v: number) => {
  const d = Math.abs(v) >= 1000 ? 0 : 2;
  return v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
};

function Technical(p: {
  data: Record<string, number[]>; stocks: string[]; futures: string[]; name: (s: string) => Holding;
  onOpen: (s: string) => void; pick: React.ReactNode; loading: boolean; info: boolean;
}) {
  const template = useMemo(() => {
    const rows: TemplateRow[] = [];
    for (const s of p.stocks) { const r = p.data[s] && trendTemplate(s, p.data[s]); if (r) rows.push(r); }
    return rankTemplate(rows);
  }, [p.data, p.stocks]);
  const trends = useMemo(() => {
    const rows: TurtleState[] = [];
    for (const s of p.futures) { const r = p.data[s] && turtle(s, p.data[s]); if (r) rows.push(r); }
    return rows.sort((a, b) => Math.abs(b.pos) - Math.abs(a.pos) || b.days - a.days);
  }, [p.data, p.futures]);
  const total = template[0]?.checks.length ?? 7;
  const full = template.filter((r) => r.passed === total).length;

  return (
    <>
      {p.info && <p className="note">Two rule sets: Mark Minervini's trend template to find stocks in a confirmed uptrend, and a Turtle-style breakout rule (Richard Dennis) for futures.</p>}
      {p.pick}
      <div className="section-h"><h2>Stocks: trend template</h2><span className="hint">{full} of {template.length} pass all {total}</span></div>
      {template.length === 0 && <p className="note">{p.loading ? 'Scanning' : p.stocks.length ? 'Needs about a year of price history per stock.' : 'No stocks on your watchlist. Switch to 30 large caps.'}</p>}
      <ul className="ledger">
        {template.map((r) => {
          const h = p.name(r.symbol);
          const fails = r.checks.map((ok, i) => (ok ? null : TEMPLATE_SHORT[i])).filter(Boolean);
          const all = r.passed === total;
          return (
            <li key={r.symbol}>
              <button className="qrow" onClick={() => p.onOpen(r.symbol)}>
                <span className="who"><span className="sym">{labelOf(h)}</span><span className="name">{h.name}</span></span>
                <span className={`tr ${all ? 'pos' : r.passed <= total / 2 ? 'neg' : 'flat'}`}>{all ? '▲ ' : ''}{r.passed} of {total} checks</span>
                {fails.length > 0 && <span className="why">Fails: {fails.join(', ')}.</span>}
                <span className="stats num">
                  {r.rs !== null && <span>RS {r.rs}</span>}
                  <span>{r.fromHigh < 0.05 ? 'At 52-week high' : `${r.fromHigh.toFixed(0)}% below high`}</span>
                  <span>{r.fromLow.toFixed(0)}% above low</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {template.length > 0 && template[0].rs === null && <p className="note">Relative strength is skipped with fewer than 8 stocks, so 7 checks apply. Use 30 large caps for the full 8.</p>}

      <div className="section-h"><h2>Futures: trend following</h2><span className="hint">55-day entry, 20-day exit</span></div>
      <ul className="ledger">
        {trends.map((t) => {
          const h = p.name(t.symbol);
          return (
            <li key={t.symbol}>
              <button className="qrow" onClick={() => p.onOpen(t.symbol)}>
                <span className="who"><span className="sym">{labelOf(h)}</span><span className="name">{h.name}</span></span>
                <span className={`tr ${t.pos === 1 ? 'pos' : t.pos === -1 ? 'neg' : 'flat'}`}>
                  {t.pos === 1 ? `▲ Long, ${t.days} days` : t.pos === -1 ? `▼ Short, ${t.days} days` : '◆ No position'}
                </span>
                <span className="why num">
                  {t.pos !== 0
                    ? `Entered at ${px(t.entry!)}, now ${px(t.price)} (${pct(t.pnl)}). Exits on a close ${t.pos === 1 ? 'below' : 'above'} ${px(t.exit!)}.`
                    : `Now ${px(t.price)}. Goes long on a close above ${px(t.breakUp)}, short below ${px(t.breakDown)}.`}
                </span>
                <span className="stats num"><span>Average daily move {t.dayMove.toFixed(1)}%</span></span>
              </button>
            </li>
          );
        })}
      </ul>
      {trends.length === 0 && <p className="note">{p.loading ? 'Scanning' : 'No futures data.'}</p>}
      {p.info && <p className="fine pad">
        The trend template is from Minervini's published criteria; relative strength here is ranked only within the list being screened.
        The futures rule uses closing prices and no position sizing, and simple breakout rules have earned far less since the 1990s than they did for the original Turtles. Neither is backtested in this app. Not investment advice.
      </p>}
    </>
  );
}

function Fundamental(p: {
  stocks: string[]; name: (s: string) => Holding; onOpen: (s: string) => void; pick: React.ReactNode;
  finnhubKey: string; onSettings: () => void; info: boolean;
}) {
  const [state, setState] = useState<{ rows: Fundamentals[]; done: number; failed: number; error?: string; loading: boolean }>({ rows: [], done: 0, failed: 0, loading: false });
  const [nonce, setNonce] = useState(0);
  const keyStr = p.stocks.join(',');
  useEffect(() => {
    if (!p.finnhubKey) return;
    let live = true;
    const rows: Fundamentals[] = [];
    let failed = 0;
    let firstError: string | undefined;
    const force = nonce !== fundaNonce;
    fundaNonce = nonce;
    setState({ rows: [], done: 0, failed: 0, loading: p.stocks.length > 0 });
    (async () => {
      for (let i = 0; i < p.stocks.length; i++) {
        const wait = force || !isCached(p.stocks[i]);
        try { rows.push(await getFundamentals(p.stocks[i], p.finnhubKey, force)); }
        catch (e) { failed++; firstError ??= errorText(e); }
        if (!live) return;
        setState({ rows: [...rows], done: i + 1, failed, loading: i + 1 < p.stocks.length, error: failed === i + 1 ? firstError : undefined });
        if (wait) await new Promise((r) => setTimeout(r, 250));
      }
    })();
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyStr, p.finnhubKey, nonce]);

  const intro = p.info && <p className="note">Peter Lynch's test (is the P/E justified by growth?) combined with Warren Buffett's (is it a high-quality business with little debt?).</p>;
  if (!p.finnhubKey) {
    return (
      <>
        {intro}
        <div className="empty-state">
          <b>Add a Finnhub key to load company financials</b>
          <span>Earnings, margins and debt come from Finnhub. The key is free at finnhub.io and stays on this phone.</span>
          <button className="btn" onClick={p.onSettings}>Open Settings</button>
        </div>
      </>
    );
  }
  const ranked = rankFundamentals(state.rows);
  const f1 = (v: number | null, suffix = '') => (v === null ? '—' : `${v.toFixed(Math.abs(v) >= 100 ? 0 : 1)}${suffix}`);
  return (
    <>
      {intro}
      {p.pick}
      <div className="refresh">
        <button className="link" onClick={() => setNonce((n) => n + 1)}>{state.loading ? `Loading ${state.done} of ${p.stocks.length}` : 'Refresh financials'}</button>
      </div>
      {state.error && <div className="err">{state.error}</div>}
      {!state.error && state.failed > 0 && !state.loading && <p className="note">{state.failed} of {p.stocks.length} stocks could not be loaded.</p>}
      {p.stocks.length === 0 && <p className="note">No stocks on your watchlist. Switch to 30 large caps.</p>}
      <ul className="ledger">
        {ranked.map((f) => {
          const h = p.name(f.symbol);
          const v = VERDICT_TEXT[f.verdict];
          const fails = f.quality.map((ok, i) => (ok ? null : QUALITY_CHECKS[i])).filter(Boolean);
          return (
            <li key={f.symbol}>
              <button className="qrow" onClick={() => p.onOpen(f.symbol)}>
                <span className="who"><span className="sym">{labelOf(h)}</span><span className="name">{h.name}</span></span>
                <span className={`tr ${v.tone}`}>{v.label}</span>
                <span className="why">{v.why}{f.verdict !== 'no-data' && f.qualityKnown > 0 && fails.length > 0 && fails.length < 4 ? ` Not met: ${fails.join('; ').toLowerCase()}.` : ''}</span>
                {f.verdict !== 'no-data' && (
                  <span className="stats num wrap">
                    <span>P/E {f1(f.pe)}</span>
                    <span>Growth {f1(f.growth, '%')}</span>
                    <span>PEG {f.peg === null ? '—' : f.peg.toFixed(2)}</span>
                    <span>ROE {f1(f.roe, '%')}</span>
                    <span>Margin {f1(f.margin, '%')}</span>
                    <span>Debt/equity {f.debtEquity === null ? '—' : f.debtEquity.toFixed(2)}</span>
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
      {p.info && <p className="fine pad">
        PEG is the P/E divided by yearly earnings growth (5-year where available). Quality checks: return on equity 15% or more, net margin 10% or more,
        debt no more than equity, earnings growing. These ratios mislead for banks and insurers, where debt is the business, and for companies with large buybacks, which inflate return on equity. Not investment advice.
      </p>}
    </>
  );
}
