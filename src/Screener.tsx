import { useEffect, useMemo, useState } from 'react';
import { errorText } from './lib/http';
import { getSeries } from './lib/market';
import { macroRead, macroRow, quantRow, SIGNAL_TEXT, type MacroRow, type QuantRow, type Trend } from './lib/screen';
import { CATALOG, holdingFor, labelOf, LARGE_CAPS, MACRO_SET, type Holding } from './lib/store';

type Mode = 'macro' | 'quant';
type Universe = 'watchlist' | 'large';

// One year of daily closes per symbol, kept for 15 minutes so switching views is instant.
const cache = new Map<string, { closes: number[]; at: number }>();
const TTL = 15 * 60_000;
let handledNonce = 0;

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
    setState({ data: {}, done: 0, failed: 0, loading: true });
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

export function Screener({ list, onOpen }: { list: Holding[]; onOpen: (symbol: string) => void }) {
  const [mode, setMode] = useState<Mode>('macro');
  const [universe, setUniverse] = useState<Universe>('watchlist');
  const [nonce, setNonce] = useState(0);

  const symbols = useMemo(
    () => (mode === 'macro' ? MACRO_SET : universe === 'large' ? LARGE_CAPS : list.map((h) => h.symbol)),
    [mode, universe, list],
  );
  const st = useCloses(symbols, nonce);
  const name = (s: string) => list.find((h) => h.symbol === s) ?? holdingFor(s);

  return (
    <>
      <div className="ranges" role="group" aria-label="Screen type">
        <button aria-pressed={mode === 'macro'} onClick={() => setMode('macro')}>Macro</button>
        <button aria-pressed={mode === 'quant'} onClick={() => setMode('quant')}>Quant</button>
        <span className="grow" />
        <button className="link" onClick={() => setNonce((n) => n + 1)}>{st.loading ? `Loading ${st.done}/${symbols.length}` : 'Refresh'}</button>
      </div>
      {st.error && <div className="err">{st.error}</div>}
      {!st.error && st.failed > 0 && !st.loading && <p className="note">{st.failed} of {symbols.length} symbols could not be loaded.</p>}
      {mode === 'macro'
        ? <Macro data={st.data} onOpen={onOpen} loading={st.loading} />
        : <Quant data={st.data} symbols={symbols} name={name} onOpen={onOpen} universe={universe} setUniverse={setUniverse} loading={st.loading} />}
    </>
  );
}

function Macro({ data, onOpen, loading }: { data: Record<string, number[]>; onOpen: (s: string) => void; loading: boolean }) {
  const rows = useMemo(() => {
    const r: Record<string, MacroRow> = {};
    for (const s of MACRO_SET) if (data[s]?.length > 60) r[s] = macroRow(s, data[s]);
    return r;
  }, [data]);
  const reads = useMemo(() => (loading ? [] : macroRead(rows)), [rows, loading]);
  const aligned = Object.values(rows).filter((r) => r.trend !== 'mixed').sort((a, b) => Math.abs(b.r3m ?? 0) - Math.abs(a.r3m ?? 0));

  return (
    <>
      <p className="note">Top-down view in the style of Stanley Druckenmiller: read liquidity from bonds and the dollar first, then follow the strongest trends that agree with it.</p>
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
      <p className="fine pad">Uptrend means price is above its 50-day average and the 50-day is above the 200-day. Downtrend is the reverse. This is a rules-based summary of price trends, not investment advice.</p>
    </>
  );
}

function Quant(p: {
  data: Record<string, number[]>; symbols: string[]; name: (s: string) => Holding; onOpen: (s: string) => void;
  universe: Universe; setUniverse: (u: Universe) => void; loading: boolean;
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
      <p className="note">Statistical screen in the spirit of Jim Simons: ignore the story, rank by numbers. Short-term stretch (z-score, RSI) checked against the long-term trend, plus 6-month momentum.</p>
      <div className="ranges" role="group" aria-label="Universe">
        <button aria-pressed={p.universe === 'watchlist'} onClick={() => p.setUniverse('watchlist')}>My watchlist</button>
        <button aria-pressed={p.universe === 'large'} onClick={() => p.setUniverse('large')}>30 large caps</button>
      </div>
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
      <p className="fine pad">
        z-score is how many standard deviations the price sits from its 20-day average. RSI(2) below 5 or above 95 marks a short-term extreme.
        Renaissance's real models are secret and far more complex; this is a simple, transparent screen built on the same idea of trading statistics rather than opinions. Not investment advice.
      </p>
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
