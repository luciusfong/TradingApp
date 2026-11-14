import { httpGet } from './http';
import { scoreHeadline, type Sentiment } from './sentiment';

export interface NewsItem {
  id: string;
  title: string;
  source: string;
  url: string;
  time: number; // ms epoch
  summary: string;
  sentiment: Sentiment;
  weight: number; // source weight 0.3..1.5
  event: string | null;
  lowValue: boolean;
  similar: number; // other outlets carrying the same story
}

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, n) => ENT[n.toLowerCase()] ?? m);
}

function tag(block: string, name: string): string {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
  if (!m) return '';
  return m[1].replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/, '$1').trim();
}

export function stripHtml(s: string): string {
  return decodeEntities(decodeEntities(s).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

export interface RawItem { title: string; source: string; url: string; time: number; summary: string }

// Regex RSS parser: runs the same in the app's webview and in Node tests.
export function parseRss(xml: string): RawItem[] {
  const out: RawItem[] = [];
  const items = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) ?? [];
  for (const block of items) {
    let title = stripHtml(tag(block, 'title'));
    let source = stripHtml(tag(block, 'source'));
    const url = decodeEntities(tag(block, 'link'));
    const time = Date.parse(tag(block, 'pubDate')) || Date.now();
    // Google News titles end with " - Publisher"
    const cut = title.lastIndexOf(' - ');
    if (cut > 0) {
      const tail = title.slice(cut + 3);
      if (!source) source = tail;
      if (tail === source) title = title.slice(0, cut);
    }
    let summary = stripHtml(tag(block, 'description'));
    // Google's description just repeats the headline and publisher
    if (summary.toLowerCase().startsWith(title.toLowerCase().slice(0, 40))) summary = '';
    if (title && url) out.push({ title, source: source || 'Unknown', url, time, summary });
  }
  return out;
}

const SOURCE_WEIGHT: [RegExp, number][] = [
  [/reuters|associated press|^ap news|bloomberg|wall street journal|wsj|financial times|dow jones/i, 1.5],
  [/sec\.gov|business wire|pr newswire|globenewswire|globe newswire/i, 1.4],
  [/cnbc|barron|marketwatch|yahoo finance|the economist|nikkei|new york times|washington post|bbc|axios|the information/i, 1.2],
  [/seeking alpha|investing\.com|benzinga|thestreet|investor's business daily|forbes|fortune|business insider|techcrunch|the verge/i, 0.9],
  [/motley fool|zacks|insidermonkey|insider monkey|24\/7 wall st|tipranks|simply wall st|investorplace|marketbeat|stocktwits/i, 0.5],
];
export function sourceWeight(source: string): number {
  for (const [re, w] of SOURCE_WEIGHT) if (re.test(source)) return w;
  return 0.8;
}

const EVENTS: [string, RegExp][] = [
  ['Earnings', /\b(earnings|eps|(beats?|tops?|miss(es|ed)?) (estimates|expectations|forecasts)|quarterly results|q[1-4] results|revenue (beat|miss)|profit (rises|falls|jumps|drops)|reports? (first|second|third|fourth)[- ]quarter)\b/i],
  ['Guidance', /\b(guidance|outlook|forecast|profit warning)\b/i],
  ['M&A', /\b(acquire[sd]?|acquisition|merger|merge[sd]?|takeover|buyout|to buy|stake in|spin[- ]?off|divest)\b/i],
  ['Analyst', /\b(upgrade[sd]?|downgrade[sd]?|price target|initiates? coverage|outperform|underperform|overweight|underweight)\b/i],
  ['Legal', /\b(lawsuit|sue[sd]?|probe|investigation|antitrust|sec charges|settle(s|ment)?|fine[sd]?|subpoena|court|regulator[sy]?|ban(ned|s)?)\b/i],
  ['Leadership', /\b(ceo|cfo|chief executive|resign(s|ed)?|steps down|appoint(s|ed)?|ousted|names new)\b/i],
  ['Product', /\b(launch(es|ed)?|unveil(s|ed)?|recall(s|ed)?|fda|approval|approves?|rollout|partnership|contract)\b/i],
  ['Macro', /\b(fed|federal reserve|interest rates?|rate (cut|hike)s?|inflation|cpi|jobs report|payrolls|gdp|tariffs?|treasury yields?|recession)\b/i],
];
export function eventOf(text: string): string | null {
  for (const [name, re] of EVENTS) if (re.test(text)) return name;
  return null;
}

// Listicles, stock-picking opinion and after-the-fact explainers.
const LOW_VALUE = /(\b\d+\s+(best|top|stocks?|reasons?|things)\b|stocks? to (buy|sell|watch|avoid)|should you (buy|sell)|is it (too late|time) to|here'?s (why|what|how)|what to know|prediction:|could (make you|turn \$)|millionaire|better buy|why .{2,40} (stock|shares) (is|are|was|were) (up|down|rising|falling|jumping|soaring|sinking|plunging|moving|trading)|if you('d| had) invested|motley fool|buy the dip\?|my top|i'd buy)/i;
export function isLowValue(title: string): boolean {
  return LOW_VALUE.test(title);
}

const STOP = new Set('a an the of to in on for and or as at by with from is are was were be has have its it this that after over amid says say new stock stocks shares share inc corp company'.split(' '));
export function titleKey(title: string): Set<string> {
  return new Set(
    title.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 1 && !STOP.has(w)),
  );
}
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

// Group near-identical headlines; keep the best-sourced one and count the rest.
export function enrich(raw: RawItem[], threshold = 0.55): NewsItem[] {
  const clusters: { key: Set<string>; best: NewsItem; count: number }[] = [];
  const seenUrl = new Set<string>();
  for (const r of raw) {
    if (seenUrl.has(r.url)) continue;
    seenUrl.add(r.url);
    const item: NewsItem = {
      id: r.url,
      ...r,
      sentiment: scoreHeadline(r.title, r.summary),
      weight: sourceWeight(r.source),
      event: eventOf(r.title),
      lowValue: isLowValue(r.title) || isLowValue(r.source),
      similar: 0,
    };
    const key = titleKey(r.title);
    const hit = clusters.find((c) => jaccard(c.key, key) >= threshold);
    if (hit) {
      hit.count++;
      const better = item.weight > hit.best.weight || (item.weight === hit.best.weight && item.time < hit.best.time);
      if (better) { hit.best = item; hit.key = key; }
    } else clusters.push({ key, best: item, count: 1 });
  }
  return clusters
    .map((c) => ({ ...c.best, similar: c.count - 1 }))
    .sort((a, b) => b.time - a.time);
}

const gnews = (q: string) =>
  `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;

async function fetchRss(q: string): Promise<RawItem[]> {
  const body = await httpGet(gnews(q), 'text');
  return parseRss(String(body));
}

async function finnhubNews(symbol: string, key: string): Promise<RawItem[]> {
  const day = (d: Date) => d.toISOString().slice(0, 10);
  const to = new Date();
  const from = new Date(Date.now() - 5 * 864e5);
  const url = `https://finnhub.io/api/v1/company-news?symbol=${encodeURIComponent(symbol)}&from=${day(from)}&to=${day(to)}&token=${encodeURIComponent(key)}`;
  const data = await httpGet(url, 'json');
  if (!Array.isArray(data)) return [];
  return data.slice(0, 60).map((n: any) => ({
    title: stripHtml(String(n.headline ?? '')),
    source: String(n.source ?? 'Finnhub'),
    url: String(n.url ?? ''),
    time: Number(n.datetime ?? 0) * 1000,
    summary: stripHtml(String(n.summary ?? '')).slice(0, 400),
  })).filter((n) => n.title && n.url);
}

export async function tickerNews(symbol: string, name: string | undefined, finnhubKey: string, customQuery?: string): Promise<NewsItem[]> {
  const q = customQuery ?? (name ? `"${symbol}" OR "${name}" stock when:3d` : `${symbol} stock when:3d`);
  const jobs: Promise<RawItem[]>[] = [fetchRss(q)];
  if (finnhubKey && !customQuery) jobs.push(finnhubNews(symbol, finnhubKey));
  const res = await Promise.allSettled(jobs);
  const raw = res.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
  if (!raw.length && res.every((r) => r.status === 'rejected')) throw (res[0] as PromiseRejectedResult).reason;
  const cutoff = Date.now() - 4 * 864e5;
  return enrich(raw.filter((r) => r.time >= cutoff));
}

export async function marketNews(): Promise<NewsItem[]> {
  const res = await Promise.allSettled([
    fetchRss('stock market when:1d'),
    fetchRss('Federal Reserve OR inflation OR tariffs OR earnings when:1d'),
    fetchRss('site:reuters.com/markets OR site:reuters.com/business when:1d'),
  ]);
  const raw = res.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
  if (!raw.length && res.every((r) => r.status === 'rejected')) throw (res[0] as PromiseRejectedResult).reason;
  return enrich(raw);
}
