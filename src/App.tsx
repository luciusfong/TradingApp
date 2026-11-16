import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';
import { Chart } from './Chart';
import { Screener } from './Screener';
import { Trading } from './Trading';
import { errorText } from './lib/http';
import { loadFilters, saveFilters, type Filters } from './lib/filters';
import { gatewayBase, gatewayError, ibkrAccounts } from './lib/ibkr';
import { getFx, getQuote, getSeries, isIndexSymbol, lookupName, majorCurrency, toLocal, type Fx, type LocalPrice, type Quote, type Range, type Series, dividendSummary, getDividends, type Dividend } from './lib/market';
import { CATEGORY_NAME, GROUPS, groupOf, MARKET_DAYS, marketNews, tickerNews, type Category, type Group, type NewsItem } from './lib/news';
import { aggregate, type Label } from './lib/sentiment';
import { applyBackup, describeBackup, makeBackup, readBackup, shareBackup, type Backup } from './lib/backup';
import { loadSecret, removeSecret, saveSecret, syncAlerts, syncWidgetPaper, syncWidgetWatchlist, takeNavTab } from './lib/native';
import { checkStrategies } from './lib/strategyRun';
import { wiseErrorText, wiseProfiles, type WiseLink } from './lib/wise';
import { WiseView } from './Wise';
import { cleanSymbol, CURRENCIES, holdingFor, isFuture, labelOf, loadPaper, loadSettings, loadWatchlist, saveSettings, saveWatchlist, type Holding, type Settings } from './lib/store';

type Tab = 'watchlist' | 'screener' | 'news' | 'trading' | 'settings';
const TABS: Tab[] = ['watchlist', 'screener', 'news', 'trading', 'settings'];
const TAB_NAME: Record<Tab, string> = { watchlist: 'Watchlist', screener: 'Screener', news: 'Market news', trading: 'Trading', settings: 'Profile' };
type Load<T> = { data?: T; error?: string; loading: boolean; at?: number };

const money = (v: number) => v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const signed = (v: number, d = 2) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(d)}`;
const dir = (v: number) => (v > 0.0001 ? 'pos' : v < -0.0001 ? 'neg' : 'flat');
const arrow = (v: number) => (v > 0.0001 ? '▲' : v < -0.0001 ? '▼' : '■');
const MOOD: Record<Label, string> = { positive: 'Positive', negative: 'Negative', neutral: 'Neutral' };
function localMoney(v: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency, currencyDisplay: 'narrowSymbol' }).format(v);
  } catch {
    return `${currency} ${money(v)}`;
  }
}

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

// Headlines filtered by major group (Filings, News, Corporate, Other), then by category within it.
function NewsList({ items, hideLow }: { items: NewsItem[]; hideLow: boolean }) {
  const [group, setGroup] = useState<Group | 'all'>('all');
  const [cat, setCat] = useState<Category | null>(null);
  const all = hideLow ? items.filter((n) => !n.lowValue) : items;
  if (!all.length) return <p className="note">No headlines in the last few days.</p>;
  const count = (c: Category) => all.filter((n) => n.category === c).length;
  const active = GROUPS.find((g) => g.id === group);
  const shown = all.filter((n) => (group === 'all' || groupOf(n.category) === group) && (!cat || n.category === cat));
  return (
    <>
    <div className="cats" role="group" aria-label="News group">
      <button aria-pressed={group === 'all'} onClick={() => { setGroup('all'); setCat(null); }}>All <span className="num">{all.length}</span></button>
      {GROUPS.map((g) => (
        <button key={g.id} aria-pressed={group === g.id} onClick={() => { setGroup(g.id); setCat(null); }}>
          {g.name} <span className="num">{g.cats.reduce((s, c) => s + count(c), 0)}</span>
        </button>
      ))}
    </div>
    {active && active.cats.length > 1 && (
      <div className="cats sub" role="group" aria-label={`${active.name} category`}>
        {active.cats.map((c) => (
          <button key={c} aria-pressed={cat === c} onClick={() => setCat(cat === c ? null : c)}>{CATEGORY_NAME[c]} <span className="num">{count(c)}</span></button>
        ))}
      </div>
    )}
    {!shown.length && <p className="note">No headlines in this category right now.</p>}
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
                  <span className="chip cat">{CATEGORY_NAME[n.category]}</span>
                  {n.event && n.event !== CATEGORY_NAME[n.category] && <span className="chip">{n.event}</span>}
                  {n.similar > 0 && <span>+{n.similar} similar</span>}
                  {n.lowValue && <span>Low value</span>}
                </span>
              </span>
            </a>
          </li>
        );
      })}
    </ul>
    </>
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
  const [filters, setFilters] = useState<Filters>(loadFilters);
  // The Wise token lives in its own store, apart from the settings (see loadSecret).
  const [wise, setWise] = useState<WiseLink | null>(null);
  useEffect(() => { loadSecret<WiseLink>('wise').then((v) => { if (v && typeof v.token === 'string' && v.token) setWise({ token: v.token, sandbox: v.sandbox === true }); }); }, []);
  const [fx, setFx] = useState<Record<string, Fx>>({});
  const key = settings.finnhubKey;
  const local = settings.currency;
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
  // Paper strategies: checked when the app opens and every minute while it is open.
  const [toast, setToast] = useState('');
  useEffect(() => {
    let live = true;
    const tick = () => {
      if (document.visibilityState !== 'visible') return;
      checkStrategies(key).then((fired) => {
        if (live && fired.length) { setToast(fired.map((f) => f.text).join(' ')); setTimeout(() => live && setToast(''), 8000); }
      }).catch(() => undefined);
    };
    tick();
    const t = setInterval(tick, 60_000);
    return () => { live = false; clearInterval(t); };
  }, [key]);
  // Keep the home-screen widget and the background alert job in step with the app.
  useEffect(() => { syncWidgetWatchlist(list); }, [list]);
  useEffect(() => { syncWidgetPaper(loadPaper()); }, []);
  useEffect(() => { syncAlerts(settings.notify, list, filters); }, [settings.notify, list, filters]);
  // A tapped alert opens the app on the Screener.
  useEffect(() => {
    const check = () => {
      if (document.visibilityState !== 'visible') return;
      takeNavTab().then((t) => {
        if (!t || !TABS.includes(t as Tab)) return;
        if (location.hash.length > 1) location.hash = '';
        setTab(t as Tab);
      });
    };
    check();
    document.addEventListener('visibilitychange', check);
    return () => document.removeEventListener('visibilitychange', check);
  }, []);

  // Local-currency view: one exchange rate per currency the quotes are in, refreshed every few minutes.
  const quoteCurrencies = useMemo(() => {
    const set = new Set<string>();
    for (const q of Object.values(quotes)) if (q.data) set.add(majorCurrency(q.data.currency ?? 'USD')[0]);
    return [...set].sort().join(',');
  }, [quotes]);
  const fxTick = Math.floor(Math.max(0, ...Object.values(quotes).map((q) => q.at ?? 0)) / 300_000);
  useEffect(() => {
    if (!local) return;
    let live = true;
    for (const c of quoteCurrencies.split(',')) {
      if (!c || c === local) continue;
      getFx(c, local).then((v) => { if (live) setFx((m) => ({ ...m, [`${c}>${local}`]: v })); }).catch(() => { /* the local line is simply left out */ });
    }
    return () => { live = false; };
  }, [local, quoteCurrencies, fxTick]);
  const localOf = (symbol: string, q?: Quote): LocalPrice | null => {
    if (!local || !q || isIndexSymbol(symbol)) return null;
    const [currency, scale] = majorCurrency(q.currency ?? 'USD');
    if (currency === local) return scale === 1 ? null : toLocal(q, { rate: 1, prev: 1 }, scale);
    const rate = fx[`${currency}>${local}`];
    return rate ? toLocal(q, rate, scale) : null;
  };
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
  const updateFilters = (f: Filters) => { setFilters(f); saveFilters(f); };
  const toggleInfo = () => updateSettings({ ...settings, showInfo: !settings.showInfo });

  if (detail && holding) {
    return (
      <Detail
        holding={holding}
        quote={quotes[detail]}
        news={news[detail]}
        local={localOf(detail, quotes[detail]?.data)}
        currency={local}
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
                const loc = localOf(h.symbol, q?.data);
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
                      {loc && (
                        <span className="loc num">
                          ≈ {localMoney(loc.price, local)} <span className={dir(loc.changePct)}>{arrow(loc.changePct)} {signed(loc.changePct)}%</span>
                        </span>
                      )}
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
            {settings.showInfo && list.length > 0 && <p className="note">Bars show each recent headline, oldest to newest. Blue is positive, orange is negative, grey is neutral.</p>}
          </>
        )}
        {tab === 'news' && (
          <>
            {market.error && <div className="err">{market.error}</div>}
            {market.loading && !market.data && <p className="note spin">Reading headlines</p>}
            {market.data && (
              <>
                <MoodCard items={market.data} hideLow={settings.hideLowValue} title={`Market mood, last ${MARKET_DAYS} days`} />
                <NewsList items={market.data} hideLow={settings.hideLowValue} />
              </>
            )}
          </>
        )}
        {tab === 'screener' && <Screener list={list} onOpen={(sym) => go(`t/${encodeURIComponent(sym)}`)} finnhubKey={key} onSettings={() => setTab('settings')} info={settings.showInfo} onToggleInfo={toggleInfo} filters={filters} onFilters={updateFilters} />}
        {tab === 'trading' && <Trading list={list} finnhubKey={key} onOpen={(sym) => go(`t/${encodeURIComponent(sym)}`)} info={settings.showInfo} onToggleInfo={toggleInfo} gateway={settings.ibkrUrl} onSettings={() => setTab('settings')} />}
        {tab === 'settings' && <SettingsView settings={settings} onChange={updateSettings} wise={wise} onWise={setWise} />}
      </main>
      {toast && <div className="toast" role="status" onClick={() => setToast('')}>{toast}</div>}
      <nav className="tabs" aria-label="Sections">
        {TABS.map((t) => (
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
  holding: Holding; quote?: Load<Quote>; news?: Load<NewsItem[]>; hideLow: boolean; local: LocalPrice | null; currency: string;
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
          {p.local && (
            <div className="loc num">
              ≈ {localMoney(p.local.price, p.currency)}, <span className={dir(p.local.change)}>{arrow(p.local.change)} {signed(p.local.change)} ({signed(p.local.changePct)}%)</span> today in {p.currency}
            </div>
          )}
          {p.quote?.error && !q && <div className="err" style={{ margin: '10px 0' }}>{p.quote.error}</div>}
        </div>
        <div className="ranges" role="group" aria-label="Chart range">
          {(['1D', '5D', '1M', '6M', '1Y'] as Range[]).map((r) => (
            <button key={r} aria-pressed={range === r} onClick={() => setRange(r)}>{r}</button>
          ))}
        </div>
        {series.data ? <Chart series={series.data} range={range} />
          : <div className="chart"><div className={`empty ${series.loading ? 'spin' : ''}`}>{series.loading ? 'Loading chart' : series.error}</div></div>}

        {!isFuture(symbol) && !isIndexSymbol(symbol) && <Dividends symbol={symbol} price={q?.price ?? 0} />}
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

function SettingsView({ settings, onChange, wise, onWise }: { settings: Settings; onChange: (s: Settings) => void; wise: WiseLink | null; onWise: (w: WiseLink | null) => void }) {
  const [keyDraft, setKeyDraft] = useState(settings.finnhubKey);
  const saved = keyDraft.trim() === settings.finnhubKey;
  const [ibDraft, setIbDraft] = useState(settings.ibkrUrl);
  const [ibTest, setIbTest] = useState<{ ok: boolean; text: string } | 'busy' | null>(null);
  const ibSaved = ibDraft.trim() === settings.ibkrUrl;
  const [notifyMsg, setNotifyMsg] = useState('');
  const testGateway = async () => {
    const base = gatewayBase(ibDraft);
    if (!base) { setIbTest({ ok: false, text: 'Enter the gateway address, for example https://192.168.1.20:5000.' }); return; }
    setIbTest('busy');
    try {
      const accounts = await ibkrAccounts(base);
      setIbTest({ ok: true, text: `Connected. Account ${accounts.map((a) => a.id).join(', ')}.` });
    } catch (e) {
      setIbTest({ ok: false, text: gatewayError(e) });
    }
  };
  // Android 13 and later only shows notifications after the user allows them.
  const setNotify = async (on: boolean) => {
    setNotifyMsg('');
    if (on && Capacitor.isNativePlatform()) {
      try {
        const r = await LocalNotifications.requestPermissions();
        if (r.display !== 'granted') {
          setNotifyMsg('Notifications are blocked for TradingApp. Allow them in Android settings, then switch this on again.');
          return;
        }
      } catch (e) {
        setNotifyMsg(errorText(e));
        return;
      }
    }
    onChange({ ...settings, notify: on });
  };
  return (
    <>
    <div className="section-h"><h2>Wallet</h2><span className="hint">Wise</span></div>
    <WiseView link={wise} onSettings={() => document.getElementById('wise')?.scrollIntoView({ behavior: 'smooth', block: 'center' })} info={settings.showInfo} />
    <div className="section-h"><h2>Connections and settings</h2></div>
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
      <div className="field">
        <label htmlFor="ib">IBKR gateway address</label>
        <div className="row2">
          <input id="ib" value={ibDraft} onChange={(e) => { setIbDraft(e.target.value); setIbTest(null); }} placeholder="https://computer-address:5000" inputMode="url" autoCapitalize="off" autoCorrect="off" spellCheck={false} />
          <button className="btn" disabled={ibSaved} onClick={() => onChange({ ...settings, ibkrUrl: ibDraft.trim() })}>{ibSaved && settings.ibkrUrl ? 'Saved' : 'Save'}</button>
        </div>
        <button className="test" disabled={ibTest === 'busy' || !ibDraft.trim()} onClick={testGateway}>{ibTest === 'busy' ? 'Testing' : 'Test connection'}</button>
        {ibTest && ibTest !== 'busy' && (ibTest.ok ? <p className="help ok">{ibTest.text}</p> : <div className="err flush">{ibTest.text}</div>)}
        <p className="help">
          IBKR gives individual accounts no API key. The app reads from IBKR's Client Portal Gateway, a program that runs on a computer
          you log in to; this is that computer's address. Read-only: the Trading tab shows your account and positions, and the app cannot place live orders.
        </p>
      </div>
      <WiseSettings wise={wise} onWise={onWise} />
      <div className="field">
        <label htmlFor="ccy">Also show prices in</label>
        <select id="ccy" value={settings.currency} onChange={(e) => onChange({ ...settings, currency: e.target.value })}>
          <option value="">Off</option>
          {CURRENCIES.map(([c, name]) => <option key={c} value={c}>{c}, {name}</option>)}
        </select>
        <p className="help">Adds each price and today's change converted to this currency, so the change includes the exchange-rate move.</p>
      </div>
      <BackupSettings />
      <label className="toggle">
        <span>
          <b>Screener alerts</b>
          <p className="help">Checks your Screener filters about once an hour in the background and notifies you of new matches on the Macro, Quant and Technical tabs.</p>
          {notifyMsg && <p className="help warn">{notifyMsg}</p>}
        </span>
        <input type="checkbox" checked={settings.notify} onChange={(e) => setNotify(e.target.checked)} />
      </label>
      <label className="toggle">
        <span>
          <b>Hide low-value articles</b>
          <p className="help">Stock-pick lists, "should you buy" pieces and after-the-fact explainers. They are also left out of the mood score.</p>
        </span>
        <input type="checkbox" checked={settings.hideLowValue} onChange={(e) => onChange({ ...settings, hideLowValue: e.target.checked })} />
      </label>
      <label className="toggle">
        <span>
          <b>Show explanations</b>
          <p className="help">Descriptions of each screen and the financial terms it uses. Also switched by the Info button on the Screener and Trading tabs.</p>
        </span>
        <input type="checkbox" checked={settings.showInfo} onChange={(e) => onChange({ ...settings, showInfo: e.target.checked })} />
      </label>
      <p className="fine">
        Sentiment is scored on this phone by matching finance words and phrases in each headline. It reads wording, not meaning, so
        treat it as a rough signal. Prices can be delayed. This app is for information only and is not investment advice.
      </p>
    </div>
    </>
  );
}

function WiseSettings({ wise, onWise }: { wise: WiseLink | null; onWise: (w: WiseLink | null) => void }) {
  const [token, setToken] = useState('');
  const [sandbox, setSandbox] = useState(false);
  const [state, setState] = useState<{ ok: boolean; text: string } | 'busy' | null>(null);
  // The token is only stored once Wise has accepted it.
  const connect = async () => {
    const link: WiseLink = { token: token.trim(), sandbox };
    setState('busy');
    try {
      const profiles = await wiseProfiles(link);
      if (!profiles.length) throw new Error('Wise listed no profiles for this token.');
      await saveSecret('wise', link);
      onWise(link);
      setToken('');
      setState({ ok: true, text: `Connected to ${profiles.map((p) => p.name).join(', ')}.` });
    } catch (e) {
      setState({ ok: false, text: wiseErrorText(e) });
    }
  };
  const remove = async () => {
    await removeSecret('wise').catch(() => undefined);
    onWise(null);
    setState(null);
  };
  return (
    <div className="field">
      <label htmlFor="wise">Wise API token</label>
      {wise ? (
        <>
          {(!state || state === 'busy') && <p className="help ok">Connected{wise.sandbox ? ' in test mode' : ''}.</p>}
          {state && state !== 'busy' && state.ok && <p className="help ok">{state.text}</p>}
          <button className="test" onClick={remove}>Remove token from this phone</button>
        </>
      ) : (
        <>
          <div className="row2">
            <input id="wise" type="password" value={token} onChange={(e) => { setToken(e.target.value); setState(null); }} placeholder="Paste token" autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false} />
            <button className="btn" disabled={!token.trim() || state === 'busy'} onClick={connect}>{state === 'busy' ? 'Checking' : 'Connect'}</button>
          </div>
          <label className="check"><input type="checkbox" checked={sandbox} onChange={(e) => setSandbox(e.target.checked)} /> Test mode: this is a Wise sandbox token</label>
          {state && state !== 'busy' && !state.ok && <div className="err flush">{state.text}</div>}
        </>
      )}
      <p className="help">
        Create the token in Wise under Settings, Integrations and tools, API tokens. The Trading tab then shows your balances and can draft a
        transfer to a saved bank recipient. The app cannot pay for a transfer: you approve and pay each one inside Wise. The token stays on
        this phone, is left out of backups, and can be revoked in Wise at any time. Treat it like a password.
      </p>
    </div>
  );
}

function BackupSettings() {
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [found, setFound] = useState<Backup | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const save = async () => {
    setFound(null);
    try {
      const shared = await shareBackup(makeBackup((k) => localStorage.getItem(k)));
      setMsg(shared ? { ok: true, text: 'Backup file made. Keep it wherever you chose to send it.' } : null);
    } catch (e) {
      setMsg({ ok: false, text: errorText(e) });
    }
  };
  const picked = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const r = readBackup(await file.text());
    if ('error' in r) { setFound(null); setMsg({ ok: false, text: r.error }); } else { setMsg(null); setFound(r.backup); }
  };
  const restore = () => {
    if (!found) return;
    applyBackup(found, (k) => localStorage.getItem(k), (k, v) => localStorage.setItem(k, v));
    location.reload();
  };
  return (
    <div className="field">
      <label>Backup</label>
      <div className="row2">
        <button className="btn" onClick={save}>Save a backup</button>
        <button className="btn sell" onClick={() => picker.current?.click()}>Restore from a file</button>
        <input ref={picker} type="file" hidden onChange={picked} />
      </div>
      {found && (
        <div className="card flush">
          <span>{describeBackup(found)} Restoring replaces what is on this phone now.</span>
          <div className="row2">
            <button className="btn" onClick={restore}>Replace and restore</button>
            <button className="btn quiet" onClick={() => setFound(null)}>Cancel</button>
          </div>
        </div>
      )}
      {msg && (msg.ok ? <p className="help ok">{msg.text}</p> : <div className="err flush">{msg.text}</div>)}
      <p className="help">
        Puts your watchlist, settings, Screener filters and paper account in one file. Android then asks where to send it: Google Drive,
        OneDrive, Gmail or anywhere else. API keys and tokens are left out.
      </p>
    </div>
  );
}

function Dividends({ symbol, price }: { symbol: string; price: number }) {
  const [divs, setDivs] = useState<Dividend[] | null>(null);
  useEffect(() => {
    let live = true;
    setDivs(null);
    getDividends(symbol).then((d) => live && setDivs(d)).catch(() => live && setDivs([]));
    return () => { live = false; };
  }, [symbol]);
  if (!divs) return null;
  const date = (t: number) => new Date(t).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  if (!divs.length) return <p className="note">No cash dividends in the last two years.</p>;
  const s = dividendSummary(divs, price);
  return (
    <>
      <div className="section-h"><h2>Dividends</h2><span className="hint">{s.perYear ? `${s.perYear} in the last 12 months` : 'none in the last 12 months'}</span></div>
      <dl className="kv one num pad-x">
        <div><dt>Paid in the last 12 months</dt><dd>{money(s.total)} per share</dd></div>
        {price > 0 && s.total > 0 && <div><dt>Yield at today's price</dt><dd>{s.yieldPct.toFixed(2)}%</dd></div>}
        {s.last && <div><dt>Most recent</dt><dd>{money(s.last.amount)}, ex-date {date(s.last.date)}</dd></div>}
      </dl>
    </>
  );
}
