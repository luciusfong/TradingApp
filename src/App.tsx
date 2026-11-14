import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Chart } from './Chart';
import { Screener } from './Screener';
import { errorText } from './lib/http';
import { getQuote, getSeries, lookupName, type Quote, type Range, type Series } from './lib/market';
import { marketNews, tickerNews, type NewsItem } from './lib/news';
import { aggregate, type Label } from './lib/sentiment';
import { cleanSymbol, holdingFor, labelOf, loadSettings, loadWatchlist, saveSettings, saveWatchlist, type Holding, type Settings } from './lib/store';

type Tab = 'watchlist' | 'screener' | 'news' | 'settings';
const TAB_NAME: Record<Tab, string> = { watchlist: 'Watchlist', screener: 'Screener', news: 'Market news', settings: 'Settings' };
type Load<T> = { data?: T; error?: string; loading: boolean; at?: number };

const money = (v: number) => v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const signed = (v: number, d = 2) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(d)}`;
const dir = (v: number) => (v > 0.0001 ? 'pos' : v < -0.0001 ? 'neg' : 'flat');
const arrow = (v: number) => (v > 0.0001 ? '▲' : v < -0.0001 ? '▼' : '■');
const MOOD: Record<Label, string> = { positive: 'Positive', negative: 'Negative', neutral: 'Neutral' };

function ago(t: number): string {
  const m = Math.max(0, Math.round((Date.now() - t) / 60000));
  if (m < 1) return 'now';
  if (m < 60) return `${m}m ago`;
  if (m < 1440) return `${Math.round(m / 60)}h ago`;
  return `${Math.round(m / 1440)}d ago`;
}

function useHash(): [string, (h: string) => void] {
  const [hash, setHash] = useState(() => location.hash.slice(1));
  useEffect(() => {
    const on = () => setHash(location.hash.slice(1));
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);
  return [hash, (h) => { location.hash = h; }];
}

function moodOf(items: NewsItem[], hideLow: boolean) {
  const used = items.filter((n) => !(hideLow && n.lowValue));
  return aggregate(used.map((n) => ({ score: n.sentiment.score, time: n.time, weight: n.weight * (1 + Math.min(n.similar, 5) * 0.15) })));
}

function Tape({ items, max = 24 }: { items: NewsItem[]; max?: number }) {
  const shown = [...items].sort((a, b) => a.time - b.time).slice(-max);
  return (
    <span className="tape" aria-hidden="true">
      {shown.map((n) => (
        <i
          key={n.id}
          className={n.sentiment.label === 'positive' ? 'p' : n.sentiment.label === 'negative' ? 'n' : ''}
          style={{ height: `${n.sentiment.label === 'neutral' ? 30 : 45 + Math.abs(n.sentiment.score) * 55}%` }}
        />
      ))}
    </span>
  );
}

function NewsList({ items, hideLow }: { items: NewsItem[]; hideLow: boolean }) {
  const shown = hideLow ? items.filter((n) => !n.lowValue) : items;
  if (!shown.length) return <p className="note">No headlines in the last few days.</p>;
  return (
    <ul className="news">
      {shown.slice(0, 60).map((n) => {
        const l = n.sentiment.label;
        return (
          <li key={n.id} className={n.lowValue ? 'low' : ''}>
            <a href={n.url} target="_blank" rel="noreferrer">
              <span className={`bar ${l === 'positive' ? 'p' : l === 'negative' ? 'n' : ''}`} />
              <span>
                <span className="hl">{n.title}</span>
                <span className="meta">
                  <span className={`s num ${l === 'positive' ? 'pos' : l === 'negative' ? 'neg' : 'flat'}`}>
                    {MOOD[l]} {l !== 'neutral' && signed(n.sentiment.score)}
                  </span>
                  <b>{n.source}</b>
                  <span>{ago(n.time)}</span>
                  {n.event && <span className="chip">{n.event}</span>}
                  {n.similar > 0 && <span>+{n.similar} similar</span>}
                  {n.lowValue && <span>Low value</span>}
                </span>
              </span>
            </a>
          </li>
        );
      })}
    </ul>
  );
}

export default function App() {
  const [hash, go] = useHash();
  const [tab, setTab] = useState<Tab>('watchlist');
  const [list, setList] = useState<Holding[]>(loadWatchlist);
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [quotes, setQuotes] = useState<Record<string, Load<Quote>>>({});
  const [news, setNews] = useState<Record<string, Load<NewsItem[]>>>({});
  const [market, setMarket] = useState<Load<NewsItem[]>>({ loading: false });
  const [editing, setEditing] = useState(false);
  const key = settings.finnhubKey;
  const listRef = useRef(list);
  listRef.current = list;

  const loadSymbol = useCallback(async (h: Holding) => {
    const s = h.symbol;
    setQuotes((q) => ({ ...q, [s]: { ...q[s], loading: true } }));
    setNews((n) => ({ ...n, [s]: { ...n[s], loading: true } }));
    getQuote(s, key)
      .then((data) => {
        setQuotes((q) => ({ ...q, [s]: { data, loading: false, at: Date.now() } }));
        if (!h.name && data.name) {
          const next = listRef.current.map((x) => (x.symbol === s ? { ...x, name: data.name } : x));
          setList(next); saveWatchlist(next);
        }
      })
      .catch((e) => setQuotes((q) => ({ ...q, [s]: { data: q[s]?.data, error: errorText(e), loading: false } })));
    tickerNews(s, h.name, key, h.q)
      .then((data) => setNews((n) => ({ ...n, [s]: { data, loading: false, at: Date.now() } })))
      .catch((e) => setNews((n) => ({ ...n, [s]: { data: n[s]?.data, error: errorText(e), loading: false } })));
  }, [key]);

  const refreshAll = useCallback(() => { listRef.current.forEach((h, i) => setTimeout(() => loadSymbol(h), i * 250)); }, [loadSymbol]);
  const loadMarket = useCallback(() => {
    setMarket((m) => ({ ...m, loading: true }));
    marketNews()
      .then((data) => setMarket({ data, loading: false, at: Date.now() }))
      .catch((e) => setMarket((m) => ({ data: m.data, error: errorText(e), loading: false })));
  }, []);

  useEffect(() => { refreshAll(); }, [refreshAll]);
  useEffect(() => {
    const id = setInterval(() => { if (document.visibilityState === 'visible') refreshAll(); }, 90_000);
    return () => clearInterval(id);
  }, [refreshAll]);
  useEffect(() => { if (tab === 'news' && !market.data && !market.loading) loadMarket(); }, [tab, market.data, market.loading, loadMarket]);

  const detail = hash.startsWith('t/') ? cleanSymbol(decodeURIComponent(hash.slice(2))) : '';
  const inList = list.some((h) => h.symbol === detail);
  const holding = detail ? list.find((h) => h.symbol === detail) ?? holdingFor(detail) : undefined;
  // Opened from the screener: not on the watchlist, so nothing has loaded it yet.
  useEffect(() => {
    if (detail && !inList) loadSymbol(holdingFor(detail));
  }, [detail, inList, loadSymbol]);

  const addSymbol = async (raw: string): Promise<string | null> => {
    const symbol = cleanSymbol(raw);
    if (!symbol) return 'Type a ticker symbol, like AMD.';
    if (list.some((h) => h.symbol === symbol)) return `${labelOf(holdingFor(symbol))} is already on your watchlist.`;
    try {
      const q = await getQuote(symbol, key);
      const name = q.name ?? (await lookupName(symbol, key));
      const h: Holding = { name, ...holdingFor(symbol) };
      const next = [...list, h];
      setList(next); saveWatchlist(next);
      setQuotes((s) => ({ ...s, [symbol]: { data: q, loading: false, at: Date.now() } }));
      loadSymbol(h);
      return null;
    } catch (e) {
      return errorText(e);
    }
  };
  const removeSymbol = (symbol: string, goBack = false) => {
    const next = list.filter((h) => h.symbol !== symbol);
    setList(next); saveWatchlist(next);
    if (!next.length) setEditing(false);
    if (goBack) history.back();
  };
  const addHolding = (h: Holding) => {
    if (list.some((x) => x.symbol === h.symbol)) return;
    const next = [...list, h];
    setList(next); saveWatchlist(next);
  };
  const updateSettings = (s: Settings) => { setSettings(s); saveSettings(s); };

  if (detail && holding) {
    return (
      <Detail
        holding={holding}
        quote={quotes[detail]}
        news={news[detail]}
        hideLow={settings.hideLowValue}
        onToggleLow={() => updateSettings({ ...settings, hideLowValue: !settings.hideLowValue })}
        onRefresh={() => loadSymbol(holding)}
        inList={inList}
        onRemove={() => removeSymbol(detail, true)}
        onAdd={() => addHolding({ ...holding, name: holding.name ?? quotes[detail]?.data?.name })}
      />
    );
  }

  const newest = Math.max(0, ...Object.values(quotes).map((q) => q.at ?? 0));
  return (
    <div className="app">
      <header className="top">
        <h1>{TAB_NAME[tab]}</h1>
        {tab === 'watchlist' && (
          <span className="acts">
            {!editing && <button className="stamp" onClick={refreshAll}>{newest ? `Updated ${ago(newest)}` : 'Loading'} · Refresh</button>}
            {list.length > 0 && <button className="stamp strong" onClick={() => setEditing(!editing)}>{editing ? 'Done' : 'Edit'}</button>}
          </span>
        )}
        {tab === 'news' && <button className="stamp" onClick={loadMarket}>{market.loading ? 'Loading' : market.at ? `Updated ${ago(market.at)}` : ''} · Refresh</button>}
      </header>
      <main className="body">
        {tab === 'watchlist' && (
          <>
            <ul className="ledger">
              {list.map((h) => {
                const q = quotes[h.symbol];
                const n = news[h.symbol];
                const mood = n?.data ? moodOf(n.data, settings.hideLowValue) : null;
                const visible = n?.data?.filter((x) => !(settings.hideLowValue && x.lowValue)) ?? [];
                return (
                  <li key={h.symbol}>
                    {editing ? (
                      <div className="row edit">
                        <span><span className="sym">{labelOf(h)}</span><span className="name">{h.name}</span></span>
                        <button className="del" onClick={() => removeSymbol(h.symbol)} aria-label={`Remove ${labelOf(h)} from watchlist`}>Remove</button>
                      </div>
                    ) : (
                    <button className="row" onClick={() => go(`t/${encodeURIComponent(h.symbol)}`)}>
                      <span><span className="sym">{labelOf(h)}</span><span className="name">{h.name}</span></span>
                      <span className="px num">{q?.data ? money(q.data.price) : q?.error ? '—' : <span className="skel spin">…</span>}</span>
                      <span className="mood">
                        {mood && visible.length ? (
                          <>
                            <Tape items={visible} />
                            <span className={mood.label === 'positive' ? 'pos' : mood.label === 'negative' ? 'neg' : 'flat'}>
                              {MOOD[mood.label]} <span className="num">{signed(mood.score)}</span>
                            </span>
                          </>
                        ) : n?.error ? <span className="skel">News unavailable</span>
                          : n?.loading ? <span className="skel spin">Reading headlines</span>
                          : <span className="skel">No recent headlines</span>}
                      </span>
                      <span className={`chg num ${q?.data ? dir(q.data.change) : 'flat'}`}>
                        {q?.data ? `${arrow(q.data.change)} ${signed(q.data.changePct)}%` : q?.error ? 'No quote' : ''}
                      </span>
                    </button>
                    )}
                  </li>
                );
              })}
            </ul>
            {Object.values(quotes).find((q) => q.error && !q.data) && (
              <div className="err">{Object.values(quotes).find((q) => q.error && !q.data)!.error}</div>
            )}
            {list.length === 0 && <p className="note">Your watchlist is empty. Add a ticker below.</p>}
            <AddForm onAdd={addSymbol} />
            <p className="note">Bars show each recent headline, oldest to newest. Blue is positive, orange is negative, grey is neutral.</p>
          </>
        )}
        {tab === 'news' && (
          <>
            {market.error && <div className="err">{market.error}</div>}
            {market.loading && !market.data && <p className="note spin">Reading headlines</p>}
            {market.data && (
              <>
                <MoodCard items={market.data} hideLow={settings.hideLowValue} title="Market mood, last 24 hours" />
                <NewsList items={market.data} hideLow={settings.hideLowValue} />
              </>
            )}
          </>
        )}
        {tab === 'screener' && <Screener list={list} onOpen={(sym) => go(`t/${encodeURIComponent(sym)}`)} />}
        {tab === 'settings' && <SettingsView settings={settings} onChange={updateSettings} />}
      </main>
      <nav className="tabs" aria-label="Sections">
        {(['watchlist', 'screener', 'news', 'settings'] as Tab[]).map((t) => (
          <button key={t} aria-current={tab === t ? 'page' : undefined} onClick={() => { setTab(t); setEditing(false); }}>
            {t === 'news' ? 'News' : TAB_NAME[t]}
          </button>
        ))}
      </nav>
    </div>
  );
}

function AddForm({ onAdd }: { onAdd: (s: string) => Promise<string | null> }) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <form
        className="add"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          const err = await onAdd(value);
          setBusy(false);
          setError(err);
          if (!err) setValue('');
        }}
      >
        <input value={value} onChange={(e) => setValue(e.target.value)} placeholder="Ticker, e.g. AMD or ESmain" aria-label="Ticker symbol" autoCapitalize="characters" autoCorrect="off" spellCheck={false} />
        <button className="btn" disabled={busy || !value.trim()}>{busy ? 'Adding' : 'Add ticker'}</button>
      </form>
      {error && <div className="err">{error}</div>}
    </>
  );
}

function MoodCard({ items, hideLow, title }: { items: NewsItem[]; hideLow: boolean; title: string }) {
  const visible = items.filter((n) => !(hideLow && n.lowValue));
  const mood = moodOf(items, hideLow);
  const counts = useMemo(() => {
    const c = { positive: 0, negative: 0, neutral: 0 };
    visible.forEach((n) => c[n.sentiment.label]++);
    return c;
  }, [visible]);
  if (!visible.length) return null;
  return (
    <section className="mood-card">
      <div className="head">
        <span>{title}</span>
        <span className={`verdict ${mood.label === 'positive' ? 'pos' : mood.label === 'negative' ? 'neg' : 'flat'}`}>
          {MOOD[mood.label]} <span className="num">{signed(mood.score)}</span>
        </span>
      </div>
      <Tape items={visible} max={48} />
      <div className="axis"><span>Older</span><span className="num">{counts.positive} positive, {counts.negative} negative, {counts.neutral} neutral</span><span>Newest</span></div>
    </section>
  );
}

function Detail(p: {
  holding: Holding; quote?: Load<Quote>; news?: Load<NewsItem[]>; hideLow: boolean;
  onToggleLow: () => void; onRefresh: () => void; onRemove: () => void; onAdd: () => void; inList: boolean;
}) {
  const [range, setRange] = useState<Range>('1D');
  const [series, setSeries] = useState<Load<Series>>({ loading: true });
  const symbol = p.holding.symbol;
  useEffect(() => {
    let live = true;
    setSeries((s) => ({ data: s.data, loading: true }));
    getSeries(symbol, range)
      .then((data) => live && setSeries({ data, loading: false }))
      .catch((e) => live && setSeries({ error: errorText(e), loading: false }));
    return () => { live = false; };
  }, [symbol, range, p.quote?.at]);

  const q = p.quote?.data;
  const hidden = p.news?.data?.filter((n) => n.lowValue).length ?? 0;
  return (
    <div className="app">
      <header className="top">
        <button className="back" onClick={() => history.back()}>‹ Back</button>
        <button className="stamp" onClick={p.onRefresh}>{p.quote?.loading ? 'Loading' : q ? `Price ${ago(q.time)}` : ''} · Refresh</button>
      </header>
      <main className="body">
        <div className="hero">
          <div className="co">{labelOf(p.holding)}{p.holding.name ? `, ${p.holding.name}` : ''}</div>
          <div className="px num">{q ? money(q.price) : '—'}</div>
          {q && <div className={`chg num ${dir(q.change)}`}>{arrow(q.change)} {signed(q.change)} ({signed(q.changePct)}%) today</div>}
          {p.quote?.error && !q && <div className="err" style={{ margin: '10px 0' }}>{p.quote.error}</div>}
        </div>
        <div className="ranges" role="group" aria-label="Chart range">
          {(['1D', '5D', '1M', '6M', '1Y'] as Range[]).map((r) => (
            <button key={r} aria-pressed={range === r} onClick={() => setRange(r)}>{r}</button>
          ))}
        </div>
        {series.data ? <Chart series={series.data} range={range} />
          : <div className="chart"><div className={`empty ${series.loading ? 'spin' : ''}`}>{series.loading ? 'Loading chart' : series.error}</div></div>}

        {p.news?.data && <MoodCard items={p.news.data} hideLow={p.hideLow} title="News mood, last 4 days" />}
        <div className="section-h">
          <h2>Headlines</h2>
          {hidden > 0 && <button onClick={p.onToggleLow}>{p.hideLow ? `Show ${hidden} low-value` : 'Hide low-value'}</button>}
        </div>
        {p.news?.error && <div className="err">{p.news.error}</div>}
        {p.news?.loading && !p.news.data && <p className="note spin">Reading headlines</p>}
        {p.news?.data && <NewsList items={p.news.data} hideLow={p.hideLow} />}
        {p.inList
          ? <button className="remove" onClick={p.onRemove}>Remove {labelOf(p.holding)} from watchlist</button>
          : <button className="remove add" onClick={p.onAdd}>Add {labelOf(p.holding)} to watchlist</button>}
      </main>
    </div>
  );
}

function SettingsView({ settings, onChange }: { settings: Settings; onChange: (s: Settings) => void }) {
  const [keyDraft, setKeyDraft] = useState(settings.finnhubKey);
  const saved = keyDraft.trim() === settings.finnhubKey;
  return (
    <div className="settings">
      <div className="field">
        <label htmlFor="fh">Finnhub API key (optional)</label>
        <div className="row2">
          <input id="fh" value={keyDraft} onChange={(e) => setKeyDraft(e.target.value)} placeholder="Paste key" autoCapitalize="off" autoCorrect="off" spellCheck={false} />
          <button className="btn" disabled={saved} onClick={() => onChange({ ...settings, finnhubKey: keyDraft.trim() })}>{saved && settings.finnhubKey ? 'Saved' : 'Save key'}</button>
        </div>
        <p className="help">
          Without a key the app uses Yahoo Finance for prices and Google News for headlines. A free key from finnhub.io adds
          real-time US quotes and Finnhub's company news feed. The key stays on this phone.
        </p>
      </div>
      <label className="toggle">
        <span>
          <b>Hide low-value articles</b>
          <p className="help">Stock-pick lists, "should you buy" pieces and after-the-fact explainers. They are also left out of the mood score.</p>
        </span>
        <input type="checkbox" checked={settings.hideLowValue} onChange={(e) => onChange({ ...settings, hideLowValue: e.target.checked })} />
      </label>
      <p className="fine">
        Sentiment is scored on this phone by matching finance words and phrases in each headline. It reads wording, not meaning, so
        treat it as a rough signal. Prices can be delayed. This app is for information only and is not investment advice.
      </p>
    </div>
  );
}
