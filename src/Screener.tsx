import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { errorText } from './lib/http';
import { getSeries } from './lib/market';
import { FUNDA_VERDICTS, getFundamentals, isCached, judge, qualityLabels, rankFundamentals, VERDICT_TEXT, verdictWhy, type Fundamentals } from './lib/fundamentals';
import {
  DEFAULT_FILTERS, fundaMatch, isDefaultFilter, LIMITS, macroMatch, normalizeFilters, quantMatch, screenSymbols, turtleMatch,
  type Filters, type FilterTab, type FundaFilter, type MacroFilter, type QuantFilter, type TechFilter,
} from './lib/filters';
import {
  macroRead, macroRow, QUANT_SIGNALS, quantRow, rankTemplate, SIGNAL_TEXT, signalWhy, templateScore, templateShort, trendTemplate, turtle,
  type MacroRow, type QuantRow, type TemplateRow, type Trend, type TurtleState,
} from './lib/screen';
import { CATALOG, holdingFor, labelOf, MACRO_SET, type Holding } from './lib/store';

const MODE_NAME: Record<FilterTab, string> = { macro: 'Macro', quant: 'Quant', tech: 'Technical', funda: 'Fundamental' };

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

// ---------- Filter controls ----------

// Bumped on every filter change so number boxes re-read their value even when
// a typed number was clamped back to what was already there.
const Rev = createContext(0);

function Num({ label, unit, value, range, step = 1, onChange }: {
  label: string; unit?: string; value: number; range: readonly [number, number]; step?: number; onChange: (v: number) => void;
}) {
  const rev = useContext(Rev);
  const [draft, setDraft] = useState(String(value));
  useEffect(() => { setDraft(String(value)); }, [value, rev]);
  // Typing is free; the number is checked and applied when the box loses focus.
  const commit = () => {
    const n = Number(draft);
    if (draft.trim() === '' || !isFinite(n)) { setDraft(String(value)); return; }
    onChange(Math.min(range[1], Math.max(range[0], n)));
  };
  return (
    <label className="fnum">
      <span>{label}</span>
      <span className="box">
        <input
          type="number" inputMode="decimal" step={step} min={range[0]} max={range[1]} value={draft}
          onChange={(e) => setDraft(e.target.value)} onBlur={commit}
          onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
        />
        {unit && <i>{unit}</i>}
      </span>
    </label>
  );
}

function Chips<T extends string>({ label, options, on, onToggle }: { label: string; options: [T, string][]; on: (v: T) => boolean; onToggle: (v: T) => void }) {
  return (
    <div className="fchips" role="group" aria-label={label}>
      <span className="flabel">{label}</span>
      <div>
        {options.map(([v, text]) => <button key={v} aria-pressed={on(v)} onClick={() => onToggle(v)}>{text}</button>)}
      </div>
    </div>
  );
}

const flip = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

function FilterPanel({ mode, f, set, reset }: {
  mode: FilterTab; f: Filters; set: <K extends FilterTab>(tab: K, patch: Partial<Filters[K]>) => void; reset: () => void;
}) {
  return (
    <div className="filters">
      {mode === 'macro' && (
        <>
          <Chips
            label="Show"
            options={[['any', 'Any trend'], ['up', 'Uptrend'], ['down', 'Downtrend'], ['mixed', 'Mixed']]}
            on={(v) => f.macro.trend === v} onToggle={(trend) => set('macro', { trend })}
          />
          <div className="fgrid">
            <Num label="Fast average" unit="days" value={f.macro.fast} range={LIMITS.fast} onChange={(fast) => set('macro', { fast })} />
            <Num label="Slow average" unit="days" value={f.macro.slow} range={LIMITS.slow} onChange={(slow) => set('macro', { slow })} />
          </div>
        </>
      )}
      {mode === 'quant' && (
        <>
          <Chips
            label="Show signals"
            options={QUANT_SIGNALS.map((s) => [s, SIGNAL_TEXT[s].label])}
            on={(v) => f.quant.signals.includes(v)} onToggle={(v) => set('quant', { signals: flip(f.quant.signals, v) })}
          />
          <div className="fgrid">
            <Num label="z-score beyond ±" step={0.1} value={f.quant.z} range={LIMITS.z} onChange={(z) => set('quant', { z })} />
            <Num label="6-month gain at least" unit="%" value={f.quant.mom} range={LIMITS.mom} onChange={(mom) => set('quant', { mom })} />
            <Num label="RSI(2) low, at or below" value={f.quant.rsiLow} range={LIMITS.rsiLow} onChange={(rsiLow) => set('quant', { rsiLow })} />
            <Num label="RSI(2) high, at or above" value={f.quant.rsiHigh} range={LIMITS.rsiHigh} onChange={(rsiHigh) => set('quant', { rsiHigh })} />
          </div>
        </>
      )}
      {mode === 'tech' && (
        <>
          <Chips
            label="Stocks must pass"
            options={templateShort(f.tech).map((text, i) => [String(i), text])}
            on={(v) => f.tech.checks[Number(v)]}
            onToggle={(v) => set('tech', { checks: f.tech.checks.map((c, i) => (i === Number(v) ? !c : c)) })}
          />
          <div className="fgrid">
            <Num label="Above 52-week low by" unit="%" value={f.tech.lowPct} range={LIMITS.lowPct} onChange={(lowPct) => set('tech', { lowPct })} />
            <Num label="Below 52-week high by at most" unit="%" value={f.tech.highPct} range={LIMITS.highPct} onChange={(highPct) => set('tech', { highPct })} />
            <Num label="Relative strength at least" value={f.tech.rsMin} range={LIMITS.rsMin} onChange={(rsMin) => set('tech', { rsMin })} />
          </div>
          <Chips
            label="Futures to show"
            options={[['any', 'All'], ['open', 'In a trend'], ['long', 'Long'], ['short', 'Short']]}
            on={(v) => f.tech.pos === v} onToggle={(pos) => set('tech', { pos })}
          />
          <div className="fgrid">
            <Num label="Futures entry breakout" unit="days" value={f.tech.enterN} range={LIMITS.enterN} onChange={(enterN) => set('tech', { enterN })} />
            <Num label="Futures exit" unit="days" value={f.tech.exitN} range={LIMITS.exitN} onChange={(exitN) => set('tech', { exitN })} />
          </div>
        </>
      )}
      {mode === 'funda' && (
        <>
          <Chips
            label="Show verdicts"
            options={FUNDA_VERDICTS.map((v) => [v, VERDICT_TEXT[v].label])}
            on={(v) => f.funda.verdicts.includes(v)} onToggle={(v) => set('funda', { verdicts: flip(f.funda.verdicts, v) })}
          />
          <div className="fgrid">
            <Num label="Cheap: PEG up to" step={0.1} value={f.funda.pegCheap} range={LIMITS.pegCheap} onChange={(pegCheap) => set('funda', { pegCheap })} />
            <Num label="Fair: PEG up to" step={0.1} value={f.funda.pegFair} range={LIMITS.pegFair} onChange={(pegFair) => set('funda', { pegFair })} />
            <Num label="Expensive: PEG above" step={0.1} value={f.funda.pegPricey} range={LIMITS.pegPricey} onChange={(pegPricey) => set('funda', { pegPricey })} />
            <Num label="Return on equity at least" unit="%" value={f.funda.roeMin} range={LIMITS.roeMin} onChange={(roeMin) => set('funda', { roeMin })} />
            <Num label="Net margin at least" unit="%" value={f.funda.marginMin} range={LIMITS.marginMin} onChange={(marginMin) => set('funda', { marginMin })} />
            <Num label="Debt to equity at most" step={0.1} value={f.funda.debtMax} range={LIMITS.debtMax} onChange={(debtMax) => set('funda', { debtMax })} />
            <Num label="Dividend yield at least" unit="%" step={0.5} value={f.funda.yieldMin} range={LIMITS.yieldMin} onChange={(yieldMin) => set('funda', { yieldMin })} />
          </div>
        </>
      )}
      <button className="link" disabled={isDefaultFilter(f, mode)} onClick={reset}>Reset to defaults</button>
    </div>
  );
}

// Results that do not match the filters stay one tap away.
function Rest({ n, children }: { n: number; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  if (n === 0) return null;
  return (
    <>
      <button className="rest" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? 'Hide' : 'Show'} {n} not matching</button>
      {open && children}
    </>
  );
}

// ---------- Screener ----------

export function Screener({ list, onOpen, finnhubKey, onSettings, info, onToggleInfo, filters, onFilters }: {
  list: Holding[]; onOpen: (symbol: string) => void; finnhubKey: string; onSettings: () => void; info: boolean; onToggleInfo: () => void;
  filters: Filters; onFilters: (f: Filters) => void;
}) {
  const [mode, setMode] = useState<FilterTab>('macro');
  const [open, setOpen] = useState(false);
  const [rev, setRev] = useState(0);
  const [nonce, setNonce] = useState(0);

  const sym = useMemo(() => screenSymbols(list, filters.universe), [list, filters.universe]);
  const symbols = useMemo(
    () => (mode === 'macro' ? sym.macro : mode === 'quant' ? sym.quant : mode === 'tech' ? [...sym.stocks, ...sym.futures] : []),
    [mode, sym],
  );
  const st = useCloses(symbols, nonce);
  const name = (s: string) => list.find((h) => h.symbol === s) ?? holdingFor(s);

  const update = (next: Filters) => { onFilters(normalizeFilters(next)); setRev((r) => r + 1); };
  const set = <K extends FilterTab>(tab: K, patch: Partial<Filters[K]>) => update({ ...filters, [tab]: { ...filters[tab], ...patch } });
  const pick = (
    <div className="ranges" role="group" aria-label="Stocks to screen">
      <button aria-pressed={filters.universe === 'watchlist'} onClick={() => update({ ...filters, universe: 'watchlist' })}>My watchlist</button>
      <button aria-pressed={filters.universe === 'large'} onClick={() => update({ ...filters, universe: 'large' })}>30 large caps</button>
    </div>
  );
  const bar = (right: ReactNode) => (
    <>
      <div className="refresh">
        <button className="link" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? 'Hide filters' : isDefaultFilter(filters, mode) ? 'Filters' : 'Filters (edited)'}
        </button>
        {right}
      </div>
      {open && (
        <Rev.Provider value={rev}>
          <FilterPanel mode={mode} f={filters} set={set} reset={() => update({ ...filters, [mode]: DEFAULT_FILTERS[mode] })} />
        </Rev.Provider>
      )}
    </>
  );

  return (
    <>
      <div className="modes" role="group" aria-label="Screen type">
        {(Object.keys(MODE_NAME) as FilterTab[]).map((m) => (
          <button key={m} aria-pressed={mode === m} onClick={() => setMode(m)}>{MODE_NAME[m]}</button>
        ))}
        <button className="info" aria-pressed={info} aria-label={info ? 'Hide explanations' : 'Show explanations'} onClick={onToggleInfo}>Info</button>
      </div>
      {mode !== 'funda' && bar(
        <button className="link" onClick={() => setNonce((n) => n + 1)}>{st.loading ? `Loading ${st.done} of ${symbols.length}` : 'Refresh prices'}</button>,
      )}
      {mode !== 'funda' && st.error && <div className="err">{st.error}</div>}
      {mode !== 'funda' && !st.error && st.failed > 0 && !st.loading && <p className="note">{st.failed} of {symbols.length} symbols could not be loaded.</p>}
      {mode === 'macro' && <Macro data={st.data} onOpen={onOpen} loading={st.loading} info={info} f={filters.macro} />}
      {mode === 'quant' && <Quant data={st.data} symbols={sym.quant} name={name} onOpen={onOpen} pick={pick} loading={st.loading} info={info} f={filters.quant} />}
      {mode === 'tech' && <Technical data={st.data} stocks={sym.stocks} futures={sym.futures} name={name} onOpen={onOpen} pick={pick} loading={st.loading} info={info} f={filters.tech} />}
      {mode === 'funda' && <Fundamental stocks={sym.stocks} name={name} onOpen={onOpen} pick={pick} finnhubKey={finnhubKey} onSettings={onSettings} info={info} f={filters.funda} bar={bar} />}
    </>
  );
}

function Macro({ data, onOpen, loading, info, f }: { data: Record<string, number[]>; onOpen: (s: string) => void; loading: boolean; info: boolean; f: MacroFilter }) {
  const rows = useMemo(() => {
    const r: Record<string, MacroRow> = {};
    for (const s of MACRO_SET) if (data[s]?.length > 60) r[s] = macroRow(s, data[s], f);
    return r;
  }, [data, f]);
  const reads = useMemo(() => (loading ? [] : macroRead(rows)), [rows, loading]);
  const aligned = Object.values(rows).filter((r) => r.trend !== 'mixed').sort((a, b) => Math.abs(b.r3m ?? 0) - Math.abs(a.r3m ?? 0));
  // While loading, symbols without data yet stay in the list as placeholders.
  const shown = MACRO_SET.filter((s) => (rows[s] ? macroMatch(rows[s], f) : loading));
  const hidden = MACRO_SET.filter((s) => !shown.includes(s));
  const item = (s: string) => {
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
  };

  return (
    <>
      {info && <p className="note">Top-down view in the style of Stanley Druckenmiller: read liquidity from bonds and the dollar first, then follow the strongest trends that agree with it.</p>}
      {reads.length > 0 && (
        <ul className="reads">
          {reads.map((r) => (
            <li key={r.title} className={r.tone}>
              <b>{r.title}</b>
              {info && <span>{r.text}</span>}
            </li>
          ))}
        </ul>
      )}
      <div className="section-h">
        <h2>Cross-asset trends</h2>
        <span className="hint">{f.trend === 'any' || loading ? '' : `${shown.length} of ${MACRO_SET.length} · `}1 month, 3 months</span>
      </div>
      {shown.length === 0 && <p className="note">No matches.</p>}
      {shown.length > 0 && <ul className="ledger">{shown.map(item)}</ul>}
      <Rest n={hidden.length}><ul className="ledger">{hidden.map(item)}</ul></Rest>
      {info && aligned.length > 0 && !loading && (
        <p className="note">
          Clearest trends now: {aligned.slice(0, 4).map((r) => `${labelOf(CATALOG[r.symbol])} ${r.trend === 'up' ? 'up' : 'down'} ${pct(r.r3m)} in 3 months`).join('; ')}.
        </p>
      )}
      {info && (
        <p className="fine pad">
          Uptrend means price is above its {f.fast}-day average and the {f.fast}-day is above the {f.slow}-day. Downtrend is the reverse.
          This is a rules-based summary of price trends, not investment advice.
        </p>
      )}
    </>
  );
}

function Quant(p: {
  data: Record<string, number[]>; symbols: string[]; name: (s: string) => Holding; onOpen: (s: string) => void;
  pick: ReactNode; loading: boolean; info: boolean; f: QuantFilter;
}) {
  const rows = useMemo(() => {
    const out: QuantRow[] = [];
    for (const s of p.symbols) if (p.data[s]?.length > 25) out.push(quantRow(s, p.data[s], p.f));
    return out.sort((a, b) => b.strength - a.strength);
  }, [p.data, p.symbols, p.f]);
  const hits = rows.filter((r) => quantMatch(r, p.f));
  const rest = rows.filter((r) => !quantMatch(r, p.f));

  return (
    <>
      {p.info && <p className="note">Statistical screen in the spirit of Jim Simons: ignore the story, rank by numbers. Short-term stretch (z-score, RSI) checked against the long-term trend, plus 6-month momentum.</p>}
      {p.pick}
      <div className="section-h"><h2>Signals</h2><span className="hint">{hits.length} of {rows.length}</span></div>
      {hits.length === 0 && (
        <p className="note">
          {p.loading ? 'Scanning'
            : p.symbols.length === 0 ? 'Your watchlist is empty. Add tickers, or switch to 30 large caps.'
              : p.info ? 'Nothing matches right now. With the standard thresholds that is the normal state on most days.' : 'No matches.'}
        </p>
      )}
      {hits.length > 0 && (
        <ul className="ledger">
          {hits.map((r) => {
            const h = p.name(r.symbol);
            const sig = SIGNAL_TEXT[r.signal];
            return (
              <li key={r.symbol}>
                <button className="qrow" onClick={() => p.onOpen(r.symbol)}>
                  <span className="who"><span className="sym">{labelOf(h)}</span><span className="name">{h.name}</span></span>
                  <span className={`tr ${sig.tone}`}>{sig.label}</span>
                  {p.info && <span className="why">{signalWhy(r.signal, p.f)}</span>}
                  <Stats r={r} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <Rest n={rest.length}>
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
      </Rest>
      {p.info && (
        <p className="fine pad">
          z-score is how many standard deviations the price sits from its 20-day average. RSI(2) near 0 or 100 marks a short-term extreme.
          The numbers under each name are z-score, RSI(2), 6-month return and, for signals, yearly volatility.
          Renaissance's real models are secret and far more complex; this is a simple, transparent screen built on the same idea of trading statistics rather than opinions. Not investment advice.
        </p>
      )}
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
  onOpen: (s: string) => void; pick: ReactNode; loading: boolean; info: boolean; f: TechFilter;
}) {
  const template = useMemo(() => {
    const rows: TemplateRow[] = [];
    for (const s of p.stocks) { const r = p.data[s] && trendTemplate(s, p.data[s], p.f); if (r) rows.push(r); }
    // Fewest failed required checks first; the relative-strength order is kept within each group.
    return rankTemplate(rows, 8, p.f.rsMin)
      .map((r) => ({ r, score: templateScore(r, p.f.checks) }))
      .sort((a, b) => a.score.fails.length - b.score.fails.length);
  }, [p.data, p.stocks, p.f]);
  const trends = useMemo(() => {
    const rows: TurtleState[] = [];
    for (const s of p.futures) { const r = p.data[s] && turtle(s, p.data[s], p.f.enterN, p.f.exitN); if (r) rows.push(r); }
    return rows.sort((a, b) => Math.abs(b.pos) - Math.abs(a.pos) || b.days - a.days);
  }, [p.data, p.futures, p.f]);
  const pass = template.filter((x) => x.score.fails.length === 0);
  const fail = template.filter((x) => x.score.fails.length > 0);
  const tShown = trends.filter((t) => turtleMatch(t, p.f));
  const tHidden = trends.filter((t) => !turtleMatch(t, p.f));
  const short = templateShort(p.f);

  const stock = ({ r, score }: (typeof template)[number]) => {
    const h = p.name(r.symbol);
    const ok = score.fails.length === 0;
    return (
      <li key={r.symbol}>
        <button className="qrow" onClick={() => p.onOpen(r.symbol)}>
          <span className="who"><span className="sym">{labelOf(h)}</span><span className="name">{h.name}</span></span>
          <span className={`tr ${ok ? 'pos' : score.passed <= score.total / 2 ? 'neg' : 'flat'}`}>{ok ? '▲ ' : ''}{score.passed} of {score.total} checks</span>
          {!ok && <span className="why">Fails: {score.fails.map((i) => short[i]).join(', ')}.</span>}
          <span className="stats num">
            {r.rs !== null && <span>RS {r.rs}</span>}
            <span>{r.fromHigh < 0.05 ? 'At 52-week high' : `${r.fromHigh.toFixed(0)}% below high`}</span>
            <span>{r.fromLow.toFixed(0)}% above low</span>
          </span>
        </button>
      </li>
    );
  };
  const future = (t: TurtleState) => {
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
  };

  return (
    <>
      {p.info && <p className="note">Two rule sets: Mark Minervini's trend template to find stocks in a confirmed uptrend, and a Turtle-style breakout rule (Richard Dennis) for futures.</p>}
      {p.pick}
      <div className="section-h"><h2>Stocks: trend template</h2><span className="hint">{pass.length} of {template.length} pass</span></div>
      {template.length === 0 && <p className="note">{p.loading ? 'Scanning' : p.stocks.length ? 'Needs about a year of price history per stock.' : 'No stocks on your watchlist. Switch to 30 large caps.'}</p>}
      {template.length > 0 && pass.length === 0 && <p className="note">No stock passes every required check.</p>}
      {pass.length > 0 && <ul className="ledger">{pass.map(stock)}</ul>}
      <Rest n={fail.length}><ul className="ledger">{fail.map(stock)}</ul></Rest>
      {p.info && template.length > 0 && template[0].r.rs === null && p.f.checks[7] && (
        <p className="note">Relative strength is skipped with fewer than 8 stocks. Use 30 large caps to include it.</p>
      )}

      <div className="section-h"><h2>Futures: trend following</h2><span className="hint">{p.f.enterN}-day entry, {p.f.exitN}-day exit</span></div>
      {trends.length === 0 && <p className="note">{p.loading ? 'Scanning' : 'No futures data.'}</p>}
      {trends.length > 0 && tShown.length === 0 && <p className="note">No matches.</p>}
      {tShown.length > 0 && <ul className="ledger">{tShown.map(future)}</ul>}
      <Rest n={tHidden.length}><ul className="ledger">{tHidden.map(future)}</ul></Rest>
      {p.info && (
        <p className="fine pad">
          The trend template is from Minervini's published criteria; relative strength here is ranked only within the list being screened.
          The futures rule uses closing prices and no position sizing, and simple breakout rules have earned far less since the 1990s than they did for the original Turtles. Neither is backtested in this app. Not investment advice.
        </p>
      )}
    </>
  );
}

function Fundamental(p: {
  stocks: string[]; name: (s: string) => Holding; onOpen: (s: string) => void; pick: ReactNode;
  finnhubKey: string; onSettings: () => void; info: boolean; f: FundaFilter; bar: (right: ReactNode) => ReactNode;
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

  // The verdicts are worked out here from the downloaded numbers, so changing a filter needs no new download.
  const ranked = useMemo(() => rankFundamentals(state.rows.map((r) => judge(r, p.f))), [state.rows, p.f]);
  const hits = ranked.filter((x) => fundaMatch(x, p.f));
  const rest = ranked.filter((x) => !fundaMatch(x, p.f));
  const labels = qualityLabels(p.f);

  const intro = p.info && <p className="note">Peter Lynch's test (is the P/E justified by growth?) combined with Warren Buffett's (is it a high-quality business with little debt?).</p>;
  if (!p.finnhubKey) {
    return (
      <>
        {p.bar(null)}
        {intro}
        <div className="empty-state">
          <b>Add a Finnhub key to load company financials</b>
          <span>Earnings, margins and debt come from Finnhub. The key is free at finnhub.io and stays on this phone.</span>
          <button className="btn" onClick={p.onSettings}>Open Settings</button>
        </div>
      </>
    );
  }
  const f1 = (v: number | null, suffix = '') => (v === null ? '—' : `${v.toFixed(Math.abs(v) >= 100 ? 0 : 1)}${suffix}`);
  const row = (f: Fundamentals) => {
    const h = p.name(f.symbol);
    const v = VERDICT_TEXT[f.verdict];
    const fails = f.quality.map((ok, i) => (ok ? null : labels[i])).filter(Boolean);
    return (
      <li key={f.symbol}>
        <button className="qrow" onClick={() => p.onOpen(f.symbol)}>
          <span className="who"><span className="sym">{labelOf(h)}</span><span className="name">{h.name}</span></span>
          <span className={`tr ${v.tone}`}>{v.label}</span>
          {p.info && <span className="why">{verdictWhy(f.verdict, p.f)}</span>}
          {f.verdict !== 'no-data' && f.qualityKnown > 0 && fails.length > 0 && fails.length < 4 && <span className="why">Not met: {fails.join('; ').toLowerCase()}.</span>}
          {f.verdict !== 'no-data' && (
            <span className="stats num wrap">
              <span>P/E {f1(f.pe)}</span>
              <span>Growth {f1(f.growth, '%')}</span>
              <span>PEG {f.peg === null ? '—' : f.peg.toFixed(2)}</span>
              <span>ROE {f1(f.roe, '%')}</span>
              <span>Margin {f1(f.margin, '%')}</span>
              <span>Debt/equity {f.debtEquity === null ? '—' : f.debtEquity.toFixed(2)}</span>
              <span>Dividend {f.yieldPct ? `${f.yieldPct.toFixed(1)}%` : 'none'}</span>
            </span>
          )}
        </button>
      </li>
    );
  };
  return (
    <>
      {p.bar(
        <button className="link" onClick={() => setNonce((n) => n + 1)}>{state.loading ? `Loading ${state.done} of ${p.stocks.length}` : 'Refresh financials'}</button>,
      )}
      {intro}
      {p.pick}
      {state.error && <div className="err">{state.error}</div>}
      {!state.error && state.failed > 0 && !state.loading && <p className="note">{state.failed} of {p.stocks.length} stocks could not be loaded.</p>}
      <div className="section-h"><h2>Matches</h2><span className="hint">{hits.length} of {ranked.length}</span></div>
      {hits.length === 0 && (
        <p className="note">{state.loading ? 'Loading' : p.stocks.length === 0 ? 'No stocks on your watchlist. Switch to 30 large caps.' : 'No matches.'}</p>
      )}
      {hits.length > 0 && <ul className="ledger">{hits.map(row)}</ul>}
      <Rest n={rest.length}><ul className="ledger">{rest.map(row)}</ul></Rest>
      {p.info && (
        <p className="fine pad">
          PEG is the P/E divided by yearly earnings growth (5-year where available). Quality checks: {labels.join('; ').toLowerCase()}.
          These ratios mislead for banks and insurers, where debt is the business, and for companies with large buybacks, which inflate return on equity. Not investment advice.
        </p>
      )}
    </>
  );
}
