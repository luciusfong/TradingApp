import { describe, it, expect } from 'vitest';
import { scoreText, scoreHeadline, aggregate } from '../src/lib/sentiment';
import { parseRss, enrich, isLowValue, eventOf, sourceWeight, decodeEntities } from '../src/lib/news';
import { parseYahooQuote, parseYahooChart, parseFinnhubQuote } from '../src/lib/market';
import { cleanSymbol } from '../src/lib/store';

describe('sentiment', () => {
  const pos = [
    'Nvidia beats estimates and raises guidance as AI demand surges',
    'Apple shares hit record high after strong iPhone sales',
    'Morgan Stanley upgrades Tesla, raises price target',
    'FDA approves Pfizer drug, shares jump',
    'Microsoft announces $60 billion share buyback',
    'Stocks rally as Fed signals rate cut',
  ];
  const neg = [
    'Tesla shares plunge after company misses estimates',
    'Intel cuts guidance, announces layoffs',
    'SEC probe into Boeing widens; shares tumble',
    'Company files for bankruptcy after fraud scandal',
    'Goldman downgrades Apple on weak demand',
    'Meta sued in antitrust lawsuit, stock falls sharply',
  ];
  const neu = [
    'Apple to hold annual developer conference in June',
    'What time does the stock market open on Monday',
    'Tesla names location for shareholder meeting',
  ];
  it.each(pos)('positive: %s', (h) => expect(scoreText(h).label).toBe('positive'));
  it.each(neg)('negative: %s', (h) => expect(scoreText(h).label).toBe('negative'));
  it.each(neu)('neutral: %s', (h) => expect(scoreText(h).label).toBe('neutral'));

  it('flips on negation', () => {
    expect(scoreText('Company fails to beat estimates').score).toBeLessThan(0);
    expect(scoreText('Shares did not fall despite warning').score).toBeGreaterThan(scoreText('Shares fall after warning').score);
  });
  it('phrases win over bare words', () => {
    expect(scoreText('Fed delivers rate cut').score).toBeGreaterThan(0);
    expect(scoreText('Airline cuts guidance').score).toBeLessThan(0);
  });
  it('stays inside -1..1 and reports hits', () => {
    const s = scoreText('crash plunge collapse fraud bankruptcy scandal');
    expect(s.score).toBeGreaterThanOrEqual(-1);
    expect(s.hits.length).toBe(6);
  });
  it('headline dominates summary', () => {
    const s = scoreHeadline('Shares plunge on profit warning', 'Analysts remain optimistic about growth');
    expect(s.label).toBe('negative');
  });
  it('aggregate weights recent items more', () => {
    const now = Date.now();
    const a = aggregate([
      { score: 0.8, time: now - 3600e3, weight: 1 },
      { score: -0.8, time: now - 96 * 3600e3, weight: 1 },
    ], now);
    expect(a.score).toBeGreaterThan(0.5);
    expect(aggregate([], now).label).toBe('neutral');
  });
});

const RSS = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>x</title>
<item><title>Nvidia beats estimates as AI demand surges - Reuters</title><link>https://news.google.com/rss/articles/AAA?oc=5</link><guid isPermaLink="false">1</guid><pubDate>Fri, 13 Nov 2026 21:10:00 GMT</pubDate><description>&lt;a href="https://news.google.com/rss/articles/AAA"&gt;Nvidia beats estimates as AI demand surges&lt;/a&gt;&amp;nbsp;&amp;nbsp;&lt;font color="#6f6f6f"&gt;Reuters&lt;/font&gt;</description><source url="https://www.reuters.com">Reuters</source></item>
<item><title>Nvidia beats estimates as demand for AI chips surges - CNBC</title><link>https://news.google.com/rss/articles/BBB?oc=5</link><pubDate>Fri, 13 Nov 2026 21:30:00 GMT</pubDate><description>x</description><source url="https://www.cnbc.com">CNBC</source></item>
<item><title>3 AI Stocks to Buy Before Nvidia&#39;s Next Move - The Motley Fool</title><link>https://news.google.com/rss/articles/CCC?oc=5</link><pubDate>Fri, 13 Nov 2026 12:00:00 GMT</pubDate><description>x</description><source url="https://www.fool.com">The Motley Fool</source></item>
<item><title><![CDATA[AT&T names new CFO - Bloomberg]]></title><link>https://news.google.com/rss/articles/DDD?oc=5</link><pubDate>Fri, 13 Nov 2026 10:00:00 GMT</pubDate><source url="https://www.bloomberg.com">Bloomberg</source></item>
</channel></rss>`;

describe('news', () => {
  it('parses Google News RSS', () => {
    const items = parseRss(RSS);
    expect(items.length).toBe(4);
    expect(items[0]).toMatchObject({ title: 'Nvidia beats estimates as AI demand surges', source: 'Reuters', summary: '' });
    expect(items[0].url).toBe('https://news.google.com/rss/articles/AAA?oc=5');
    expect(new Date(items[0].time).toISOString()).toBe('2026-11-13T21:10:00.000Z');
    expect(items[2].title).toBe("3 AI Stocks to Buy Before Nvidia's Next Move");
    expect(items[3].title).toBe('AT&T names new CFO');
  });
  it('dedupes same story and keeps the better source', () => {
    const out = enrich(parseRss(RSS));
    expect(out.length).toBe(3);
    const nv = out.find((o) => o.title.startsWith('Nvidia beats'))!;
    expect(nv.source).toBe('Reuters');
    expect(nv.similar).toBe(1);
    expect(nv.sentiment.label).toBe('positive');
    expect(nv.event).toBe('Earnings');
    expect(out[0].time).toBeGreaterThanOrEqual(out[1].time);
  });
  it('flags low-value pieces', () => {
    expect(isLowValue('3 AI Stocks to Buy Before Nvidia\'s Next Move')).toBe(true);
    expect(isLowValue('Why Tesla Stock Is Soaring Today')).toBe(true);
    expect(isLowValue('Should You Buy Apple Before Earnings?')).toBe(true);
    expect(isLowValue('Apple reports fourth-quarter results')).toBe(false);
    expect(isLowValue('Fed holds rates steady')).toBe(false);
  });
  it('tags events and weights sources', () => {
    expect(eventOf('Microsoft to acquire gaming studio')).toBe('M&A');
    expect(eventOf('Fed holds interest rates steady')).toBe('Macro');
    expect(eventOf('Tesla CEO steps down')).toBe('Leadership');
    expect(eventOf('Sunny weather expected')).toBeNull();
    expect(sourceWeight('Reuters')).toBeGreaterThan(sourceWeight('The Motley Fool'));
  });
  it('decodes entities', () => expect(decodeEntities('A &amp; B &#39;x&#x27;')).toBe("A & B 'x'"));
});

describe('market parsers', () => {
  const yahoo = { chart: { result: [{ meta: { regularMarketPrice: 231.5, chartPreviousClose: 228, regularMarketTime: 1794603600, shortName: 'Apple Inc.' }, timestamp: [1794580200, 1794580500, 1794580800], indicators: { quote: [{ close: [229.1, null, 231.5] }] } }], error: null } };
  it('reads a Yahoo quote', () => {
    const q = parseYahooQuote('AAPL', yahoo);
    expect(q.price).toBe(231.5);
    expect(q.change).toBeCloseTo(3.5);
    expect(q.changePct).toBeCloseTo(1.535, 2);
    expect(q.name).toBe('Apple Inc.');
  });
  it('drops null candles', () => {
    const { series } = parseYahooChart(yahoo);
    expect(series.c).toEqual([229.1, 231.5]);
    expect(series.t.length).toBe(2);
  });
  it('throws a readable error on unknown symbol', () => {
    expect(() => parseYahooChart({ chart: { result: null, error: { description: 'No data found, symbol may be delisted' } } })).toThrow(/No data found/);
    expect(() => parseFinnhubQuote('ZZZZ', { c: 0, d: null, dp: null, h: 0, l: 0, o: 0, pc: 0, t: 0 })).toThrow();
  });
  it('reads a Finnhub quote', () => {
    const q = parseFinnhubQuote('AAPL', { c: 231.5, d: 3.5, dp: 1.5351, h: 232, l: 228, o: 229, pc: 228, t: 1794603600 });
    expect(q.changePct).toBeCloseTo(1.5351);
    expect(q.source).toBe('finnhub');
  });
  it('cleans symbols', () => {
    expect(cleanSymbol(' brk.b ')).toBe('BRK.B');
    expect(cleanSymbol('aapl; drop')).toBe('AAPLDROP');
  });
});
