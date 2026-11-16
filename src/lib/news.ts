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
  category: Category;
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

export type Category = 'sec' | 'fda' | 'insider' | 'institutional' | 'geopolitical' | 'tech' | 'financial' | 'economics' | 'ma' | 'ipo' | 'private' | 'dividend' | 'corpfund' | 'other';
export type Group = 'filings' | 'news' | 'corporate' | 'other';
export const CATEGORY_NAME: Record<Category, string> = {
  sec: 'SEC filings', fda: 'FDA approvals', insider: 'Insider', institutional: 'Institutional',
  geopolitical: 'Geopolitical', tech: 'Tech', financial: 'Financial', economics: 'Economics',
  ma: 'M&A', ipo: 'IPOs', private: 'Private markets', dividend: 'Dividends', corpfund: 'Corporate funds', other: 'Other',
};
export const GROUPS: { id: Group; name: string; cats: Category[] }[] = [
  { id: 'filings', name: 'Filings', cats: ['sec', 'fda', 'insider', 'institutional'] },
  { id: 'news', name: 'News', cats: ['geopolitical', 'tech', 'financial', 'economics'] },
  { id: 'corporate', name: 'Corporate', cats: ['ma', 'ipo', 'private', 'dividend', 'corpfund'] },
  { id: 'other', name: 'Other', cats: ['other'] },
];
export const groupOf = (c: Category): Group => GROUPS.find((g) => g.cats.includes(c))!.id;

// First match wins, so the narrow disclosure types sit above the broad topics.
const CATEGORIES: [Category, RegExp][] = [
  ['insider', /\binsider (buy|sell|sale|trad|purchas|transaction)|\bform 4\b|10b5-1|\b(ceo|cfo|coo|cto|director|chairman|president|executive|officer|founder)s? (sells?|sold|buys?|bought|dumps?|unloads?|offloads?|purchases?|acquires?) .{0,40}\b(shares|stock)\b/i],
  ['institutional', /\b13[fdg]\b|\bhedge funds?\b|\binstitutional (investors?|holders?|ownership|buying|selling)|\b(berkshire|blackrock|vanguard|state street|bridgewater|citadel|renaissance technologies|pershing square|ark invest|tiger global|norges bank|elliott management|soros)\b|\b(raises|boosts|trims|cuts|increases|reduces|takes|discloses|builds|exits|sells|dumps|adds to) .{0,30}\b(stake|position|holdings?)\b|\bactivist investor|\bpension funds?\b|\bsovereign wealth/i],
  ['ipo', /\bipos?\b|\binitial public offering|\b(goes|going|go|went) public\b|\b(market|trading|stock market|nasdaq|nyse) debut\b|\bdebuts? on (the )?(nasdaq|nyse|new york stock exchange)|\bdirect listing|\bspac\b|\bupsized? offering|\bprices? (its )?(ipo|offering) at\b/i],
  ['sec', /\bsec filings?\b|\b(8-k|10-k|10-q|s-1|s-3|424b\d?|def ?14a|20-f|6-k)\b|\bform (8|10|s|20)-|\bfiles? (with the sec|for (an )?ipo|for bankruptcy|for chapter|a prospectus|registration)|\bfiled with the sec|\bproxy (statement|filing)|\bannual report\b|\b(regulatory|securities) filings?\b|\bshelf (offering|registration)|sec\.gov/i],
  ['fda', /\bfda\b|\bpdufa\b|\bclinical (trial|hold)|\bphase (1|2|3|i|ii|iii)\b|\bdrug approval|\b(nda|bla|snda)\b|510\(k\)|\bbreakthrough therapy|\bfast[- ]track designation|\borphan drug/i],
  // Private equity and venture capital: funding rounds, buyout firms, fund raises. Above M&A so a buyout by a private-equity firm lands here.
  ['private', /\bprivate[- ]equity\b|\bventure[- ]capital\b|\bvc[- ]backed\b|\bvcs\b|\b(funding|financing|seed|pre-seed) round\b|\bseries [a-h]\b(?! shares)|\b(raises|raised|secures|secured|lands|landed) \$[\d.,]+ ?(billion|million|bn|mn|b|m)\b.{0,60}\b(round|valuation)\b|\b(closes|closed) .{0,40}\bfund\b|\bat an? \$[\d.,]+ ?(billion|million|bn|b|m)? ?valuation|\bunicorns?\b|\btake[- ]private\b|\bleveraged buyout|\blbo\b|\bbuyout (firm|fund|group|shop)s?\b|\bgrowth equity\b|\b(blackstone|kkr|carlyle|apollo global|tpg|thoma bravo|silver lake|bain capital|warburg pincus|advent international|vista equity|hellman & friedman|cvc capital|sequoia|andreessen horowitz|a16z|y combinator|founders fund|softbank vision fund|general catalyst|lightspeed venture)\b/i],
  ['ma', /\b(acquires?|acquired|acquiring|acquisition|merger|merges?|merged|takeover|buyout|spin[- ]?off|divest\w*|tender offer)\b|\bdeal to (buy|acquire)\b|\b(to|will) (buy|acquire) .{1,50} (for|in) \$/i],
  ['dividend', /\b(dividends?|ex-dividend|ex-div|payout ratio|dividend (hike|cut|increase|raise|suspension|yield)|special dividend|distribution per share|dividend aristocrats?|dividend kings?|yield stocks?)\b|\b(declares|raises|hikes|cuts|suspends|boosts|lifts|maintains|reinstates|slashes) (its )?(quarterly|monthly|annual|interim|final|special)? ?(cash )?(dividend|payout|distribution)/i],
  ['corpfund', /\b(buybacks?|repurchases?|repurchase program|corporate venture|venture arm|capital (return|allocation)|capex|capital expenditures?|bitcoin treasury|treasury strategy|bond (sale|offering)|debt offering|share (sale|offering)|secondary offering)\b|\b(invests?|investing|to invest|commits?|pledges?) \$[\d.,]+ ?(billion|million|bn|mn|b|m)\b/i],
  ['geopolitical', /\bgeopolit|\b(war|wars|sanctions?|tariffs?|military|missiles?|invasion|ceasefire|nato|opec\+?|embargo|airstrikes?|coup|summit)\b|\btrade (war|deal|talks|truce|tensions)|\bexport (controls?|bans?|curbs)|\b(china|chinese|russia|russian|ukraine|iran|israel|taiwan|north korea|middle east|gaza|venezuela|beijing|kremlin|strait of hormuz|red sea)\b/i],
  ['economics', /\b(fed|fomc|powell|inflation|cpi|ppi|pce|payrolls|unemployment|jobless|gdp|recession|ecb|boj|pmi|stagflation|economy|economic|economists?)\b|\bfederal reserve|\binterest rates?\b|\brate (cut|hike)s?\b|\bjobs report|\btreasury yields?|\bcentral banks?\b|\bbank of (england|japan|canada)|\bconsumer (spending|confidence|sentiment|prices)|\bretail sales|\bhousing starts/i],
  ['tech', /\b(ai|chips?|chipmakers?|semiconductors?|software|cloud|cyberattack|cybersecurity|iphone|android|robotaxi|robots?|robotics|quantum|startups?|big tech|nvidia|apple|microsoft|google|alphabet|meta|amazon|tesla|openai|anthropic|amd|intel|tsmc|broadcom|oracle|palantir|netflix|samsung|qualcomm)\b|\bartificial intelligence|\bdata cent(er|re)s?\b|\btech (stocks?|giants?|sector|shares)/i],
  ['financial', /\b(earnings|revenue|profits?|eps|guidance|outlook|stocks?|shares|wall street|s&p|dow|nasdaq|markets?|bonds?|yields?|banks?|upgrades?|downgrades?|price target|ipo|investors?|rally|rallies|sell-?off|bitcoin|crypto|oil|crude|gold|dollar|futures|quarterly results)\b/i],
];
export function categoryOf(title: string, source = ''): Category {
  if (/sec\.gov/i.test(source)) return 'sec';
  if (/fda\.gov/i.test(source)) return 'fda';
  for (const [c, re] of CATEGORIES) if (re.test(title)) return c;
  return 'other';
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
      category: categoryOf(r.title, r.source),
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

// Market news window: long enough that Friday's close is still there on a Sunday, short enough to stay current.
export const MARKET_DAYS = 3;

export async function marketNews(): Promise<NewsItem[]> {
  const res = await Promise.allSettled([
    fetchRss(`stock market when:${MARKET_DAYS}d`),
    fetchRss(`Federal Reserve OR inflation OR tariffs OR earnings when:${MARKET_DAYS}d`),
    fetchRss(`site:reuters.com/markets OR site:reuters.com/business when:${MARKET_DAYS}d`),
    fetchRss(`"SEC filing" OR "8-K" OR "10-Q" OR "13F" OR "files for IPO" when:${MARKET_DAYS}d`),
    fetchRss(`"FDA approval" OR "FDA approves" OR "FDA rejects" OR PDUFA when:${MARKET_DAYS}d`),
    fetchRss(`"insider buying" OR "insider selling" OR "Form 4" OR "hedge fund" stake when:${MARKET_DAYS}d`),
    fetchRss(`merger OR acquisition OR buyout OR "share buyback" when:${MARKET_DAYS}d`),
    fetchRss(`IPO OR "initial public offering" OR "goes public" OR "market debut" when:${MARKET_DAYS}d`),
    fetchRss(`"private equity" OR "venture capital" OR "funding round" OR buyout when:${MARKET_DAYS}d`),
    fetchRss(`dividend OR "ex-dividend" OR "dividend hike" OR "dividend cut" when:${MARKET_DAYS}d`),
    fetchRss(`geopolitical OR sanctions OR tariffs markets when:${MARKET_DAYS}d`),
    fetchRss(`AI OR semiconductor OR "big tech" stocks when:${MARKET_DAYS}d`),
  ]);
  const raw = res.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
  if (!raw.length && res.every((r) => r.status === 'rejected')) throw (res[0] as PromiseRejectedResult).reason;
  // Google's when: filter is loose with OR searches and lets months-old stories through, so enforce the window here.
  const cutoff = Date.now() - MARKET_DAYS * 864e5;
  return enrich(raw.filter((r) => r.time >= cutoff));
}
