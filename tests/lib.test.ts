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

import { sma, ret, zscore, rsi, annualVol, trendOf, macroRow, macroRead, quantRow } from '../src/lib/screen';
import { CATALOG, holdingFor, labelOf } from '../src/lib/store';

const ramp = (n: number, start: number, step: number) => Array.from({ length: n }, (_, i) => start + i * step);

describe('screens', () => {
  it('basic statistics', () => {
    expect(sma([1, 2, 3, 4], 2)).toBe(3.5);
    expect(sma([1], 2)).toBeNull();
    expect(ret([100, 110], 1)).toBeCloseTo(10);
    expect(ret([100, 110, 121], 1, 1)).toBeCloseTo(10);
    expect(ret([100], 5)).toBeNull();
    expect(zscore([...Array(19).fill(10), 10], 20)).toBe(0);
    expect(zscore([...ramp(19, 100, 0.1), 80], 20)!).toBeLessThan(-2);
    expect(annualVol(Array(30).fill(50), 20)).toBe(0);
  });
  it('RSI(2) hits the extremes', () => {
    expect(rsi(ramp(10, 100, 1), 2)).toBe(100);
    expect(rsi(ramp(10, 100, -1), 2)).toBeCloseTo(0);
    expect(rsi([1, 1, 1, 1], 2)).toBe(50);
  });
  it('classifies trend', () => {
    expect(trendOf(ramp(250, 100, 0.5))).toBe('up');
    expect(trendOf(ramp(250, 300, -0.5))).toBe('down');
    expect(trendOf([...ramp(200, 100, 0.5), ...ramp(50, 200, -1.2)])).toBe('mixed');
  });
  it('reads the macro backdrop', () => {
    const up = (s: string) => macroRow(s, ramp(250, 100, 0.5));
    const dn = (s: string) => macroRow(s, ramp(250, 300, -0.5));
    const easing = macroRead({ 'UB=F': up('UB=F'), 'DX-Y.NYB': dn('DX-Y.NYB'), 'NQ=F': up('NQ=F'), 'GC=F': up('GC=F'), 'CL=F': dn('CL=F'), 'HG=F': up('HG=F') });
    expect(easing[0].title).toBe('Liquidity is easing');
    expect(easing[1].text).toMatch(/agrees with the liquidity/);
    expect(easing.some((r) => r.title === 'Gold is leading')).toBe(true);
    expect(easing.some((r) => r.title === 'Growth signal is positive')).toBe(true);
    const tight = macroRead({ 'UB=F': dn('UB=F'), 'DX-Y.NYB': up('DX-Y.NYB'), 'NQ=F': up('NQ=F') });
    expect(tight[0].title).toBe('Liquidity is tightening');
    expect(tight[1].text).toMatch(/against liquidity/);
    expect(macroRead({})).toEqual([]);
    expect(up('X').r1m).toBeGreaterThan(0);
    expect(up('X').spark.length).toBe(63);
  });
  it('finds quant signals', () => {
    const dip = quantRow('A', [...ramp(245, 100, 0.5), 215, 208, 200, 196, 192]);
    expect(dip.signal).toBe('dip-uptrend');
    const spike = quantRow('B', [...ramp(245, 300, -0.5), 185, 192, 199, 204, 208]);
    expect(spike.signal).toBe('spike-downtrend');
    const calm = quantRow('C', Array.from({ length: 250 }, (_, i) => 100 + Math.sin(i / 3)));
    expect(calm.signal).toBe('none');
    expect(dip.strength).toBeGreaterThan(calm.strength);
    expect(quantRow('D', [10, 11]).z).toBeNull();
  });
  it('maps broker-style names to data symbols', () => {
    expect(cleanSymbol('clmain')).toBe('CL=F');
    expect(cleanSymbol('NQmain')).toBe('NQ=F');
    expect(cleanSymbol('ubmain')).toBe('UB=F');
    expect(cleanSymbol('GCMAIN')).toBe('GC=F');
    expect(cleanSymbol('usdindex')).toBe('DX-Y.NYB');
    expect(cleanSymbol('dxy')).toBe('DX-Y.NYB');
    expect(labelOf(CATALOG['CL=F'])).toBe('CLmain');
    expect(labelOf(holdingFor('AMD'))).toBe('AMD');
  });
});

import { trendTemplate, rankTemplate, turtle } from '../src/lib/screen';
import { parseMetrics, rankFundamentals } from '../src/lib/fundamentals';
import { isFuture } from '../src/lib/store';

describe('technical screens', () => {
  it('trend template passes a steady uptrend and fails a downtrend', () => {
    const up = trendTemplate('UP', ramp(250, 100, 0.6))!;
    expect(up.checks).toEqual([true, true, true, true, true, true, true]);
    expect(up.fromHigh).toBeCloseTo(0);
    const dn = trendTemplate('DN', ramp(250, 300, -0.6))!;
    expect(dn.passed).toBe(0);
    expect(trendTemplate('SHORT', ramp(100, 1, 1))).toBeNull();
  });
  it('fails only the near-high check after a deep pullback', () => {
    const a = [...ramp(230, 100, 1), ...ramp(20, 320, -4)];
    const r = trendTemplate('PB', a)!;
    expect(r.checks[6]).toBe(false);
    expect(r.checks[5]).toBe(true);
    expect(r.checks[4]).toBe(false);
  });
  it('ranks relative strength only with enough names', () => {
    const few = rankTemplate([trendTemplate('A', ramp(250, 100, 0.6))!, trendTemplate('B', ramp(250, 100, 0.1))!]);
    expect(few[0].symbol).toBe('A');
    expect(few[0].rs).toBeNull();
    expect(few[0].checks.length).toBe(7);
    const many = rankTemplate(Array.from({ length: 10 }, (_, i) => trendTemplate(`S${i}`, ramp(250, 100, 0.1 + i * 0.1))!));
    expect(many[0].symbol).toBe('S9');
    expect(many[0].rs).toBe(99);
    expect(many[0].passed).toBe(8);
    expect(many.find((r) => r.symbol === 'S0')!.rs).toBe(1);
    expect(many.find((r) => r.symbol === 'S0')!.checks[7]).toBe(false);
  });
  it('turtle goes long on a breakout and exits on a 20-day low', () => {
    const flat = Array.from({ length: 80 }, (_, i) => 100 + (i % 2));
    expect(turtle('F', flat)!.pos).toBe(0);
    const long = turtle('L', [...flat, 103, 104, 105, 106])!;
    expect(long.pos).toBe(1);
    expect(long.days).toBe(3);
    expect(long.entry).toBe(103);
    expect(long.pnl).toBeCloseTo((106 / 103 - 1) * 100);
    expect(long.exit).toBe(100);
    const out = turtle('X', [...flat, ...ramp(30, 103, 1), 110])!;
    expect(out.pos).toBe(0);
    expect(out.breakUp).toBe(132);
    // A close that is both a 20-day and a 55-day low exits and reverses the same day.
    expect(turtle('R', [...flat, 103, 104, 105, 106, 99.5])!.pos).toBe(-1);
    const short = turtle('S', [...flat, 98, 97, 96])!;
    expect(short.pos).toBe(-1);
    expect(short.pnl).toBeGreaterThan(0);
    expect(short.exit).toBe(101);
    expect(turtle('T', [1, 2, 3])).toBeNull();
  });
});

describe('fundamentals', () => {
  it('scores quality at a fair price', () => {
    const f = parseMetrics('GOOD', { peTTM: 21, epsGrowth5Y: 18, roeTTM: 32, netProfitMarginTTM: 24, 'totalDebt/totalEquityQuarterly': 0.4 });
    expect(f.peg).toBeCloseTo(1.167, 2);
    expect(f.quality).toEqual([true, true, true, true]);
    expect(f.verdict).toBe('quality-fair');
  });
  it('separates expensive quality, cheap junk and loss-makers', () => {
    expect(parseMetrics('A', { peTTM: 60, epsGrowth5Y: 12, roeTTM: 40, netProfitMarginTTM: 25, 'totalDebt/totalEquityQuarterly': 0.2 }).verdict).toBe('quality-pricey');
    expect(parseMetrics('B', { peTTM: 6, epsGrowth5Y: 12, roeTTM: 5, netProfitMarginTTM: 3, 'totalDebt/totalEquityQuarterly': 3 }).verdict).toBe('cheap-weak');
    expect(parseMetrics('C', { peTTM: null, epsGrowth5Y: -8, roeTTM: -12, netProfitMarginTTM: -20 }).verdict).toBe('no-earnings');
    expect(parseMetrics('D', { peTTM: 45, epsGrowth5Y: 9, roeTTM: 8, netProfitMarginTTM: 6 }).verdict).toBe('pricey');
    expect(parseMetrics('SPY', {}).verdict).toBe('no-data');
  });
  it('falls back across fields and normalises percent debt ratios', () => {
    const f = parseMetrics('E', { peNormalizedAnnual: 15, epsGrowth3Y: 15, roe5Y: 20, 'totalDebt/totalEquityAnnual': 85 });
    expect(f.pe).toBe(15);
    expect(f.growthBasis).toBe('3-year');
    expect(f.debtEquity).toBeCloseTo(0.85);
    expect(f.qualityKnown).toBe(3);
    expect(f.verdict).toBe('quality-fair');
  });
  it('ranks best verdicts first', () => {
    const rows = rankFundamentals([parseMetrics('D', { peTTM: 45, epsGrowth5Y: 9 }), parseMetrics('G', { peTTM: 21, epsGrowth5Y: 18, roeTTM: 32, netProfitMarginTTM: 24, 'totalDebt/totalEquityQuarterly': 0.4 })]);
    expect(rows[0].symbol).toBe('G');
  });
  it('knows futures from stocks', () => {
    expect(isFuture('CL=F')).toBe(true);
    expect(isFuture('DX-Y.NYB')).toBe(true);
    expect(isFuture('SI=F')).toBe(true);
    expect(isFuture('AAPL')).toBe(false);
    expect(isFuture('BRK-B')).toBe(false);
  });
});
