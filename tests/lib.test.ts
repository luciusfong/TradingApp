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

import { categoryOf, groupOf, GROUPS } from '../src/lib/news';
import { applyOrder, breakdown, newAccount } from '../src/lib/paper';

describe('news categories', () => {
  it('sorts headlines into categories', () => {
    expect(categoryOf('Nvidia CEO sells $40 million in shares, Form 4 shows')).toBe('insider');
    expect(categoryOf('Berkshire trims Apple stake in latest 13F')).toBe('institutional');
    expect(categoryOf('Acme files 8-K disclosing new credit facility')).toBe('sec');
    expect(categoryOf('FDA approves new obesity drug from Lilly')).toBe('fda');
    expect(categoryOf('Microsoft to acquire gaming studio')).toBe('ma');
    expect(categoryOf('Apple announces $90 billion share buyback')).toBe('corpfund');
    expect(categoryOf('Oil jumps as new sanctions hit Russia')).toBe('geopolitical');
    expect(categoryOf('Fed holds interest rates steady')).toBe('economics');
    expect(categoryOf('AI chip demand lifts semiconductor makers')).toBe('tech');
    expect(categoryOf('Wall Street closes higher as bank earnings beat')).toBe('financial');
    expect(categoryOf('Sunny weather expected')).toBe('other');
    expect(categoryOf('Quarterly update', 'SEC.gov')).toBe('sec');
    expect(categoryOf('Chipmaker files for IPO on Nasdaq')).toBe('ipo');
    expect(categoryOf('Klarna shares jump in market debut')).toBe('ipo');
    expect(categoryOf('Fintech prices its IPO at $24 a share')).toBe('ipo');
  });
  it('rolls categories up into major groups', () => {
    expect(groupOf('insider')).toBe('filings');
    expect(groupOf('fda')).toBe('filings');
    expect(groupOf('geopolitical')).toBe('news');
    expect(groupOf('ma')).toBe('corporate');
    expect(GROUPS.flatMap((g) => g.cats).length).toBe(14);
    expect(groupOf('ipo')).toBe('corporate');
    expect(enrich(parseRss(RSS)).every((n) => !!n.category)).toBe(true);
  });
});

describe('paper account', () => {
  it('buys, averages cost and sells with realised profit', () => {
    let a = newAccount();
    a = applyOrder(a, { symbol: 'AAPL', side: 'buy', qty: 10, price: 100 });
    a = applyOrder(a, { symbol: 'AAPL', side: 'buy', qty: 10, price: 120 });
    expect(a.positions.AAPL).toEqual({ qty: 20, avgCost: 110 });
    expect(a.cash).toBe(97800);
    a = applyOrder(a, { symbol: 'AAPL', side: 'sell', qty: 5, price: 130 });
    expect(a.realized).toBe(100);
    expect(a.positions.AAPL.qty).toBe(15);
    expect(a.cash).toBe(98450);
    a = applyOrder(a, { symbol: 'AAPL', side: 'sell', qty: 15, price: 110 });
    expect(a.positions.AAPL).toBeUndefined();
    expect(a.trades.length).toBe(4);
  });
  it('rejects orders it cannot fill', () => {
    const a = newAccount();
    expect(() => applyOrder(a, { symbol: 'AAPL', side: 'buy', qty: 1000, price: 200 })).toThrow(/Not enough buying power/);
    expect(() => applyOrder(a, { symbol: 'AAPL', side: 'sell', qty: 1001, price: 200 })).toThrow(/Not enough buying power/);
    expect(() => applyOrder(a, { symbol: 'AAPL', side: 'buy', qty: 1.5, price: 200 })).toThrow(/whole number/);
  });
  it('sells short and buys to cover', () => {
    let a = applyOrder(newAccount(), { symbol: 'TSLA', side: 'sell', qty: 100, price: 300 });
    expect(a.positions.TSLA).toEqual({ qty: -100, avgCost: 300 });
    expect(a.cash).toBe(130000);
    let b = breakdown(a, { TSLA: 270 });
    expect(b.equity).toBe(103000);
    expect(b.rows[0]).toMatchObject({ short: true, exposure: 27000, pnl: 3000 });
    expect(b.rows[0].pnlPct).toBeCloseTo(10);
    expect(b.required).toBe(13500);
    a = applyOrder(a, { symbol: 'TSLA', side: 'buy', qty: 100, price: 270 });
    expect(a.positions.TSLA).toBeUndefined();
    expect(a.realized).toBe(3000);
    expect(a.cash).toBe(103000);
    // selling more than is held flips the position
    a = applyOrder(a, { symbol: 'AAPL', side: 'buy', qty: 10, price: 100 });
    a = applyOrder(a, { symbol: 'AAPL', side: 'sell', qty: 30, price: 110 });
    expect(a.positions.AAPL).toEqual({ qty: -20, avgCost: 110 });
    expect(a.realized).toBe(3100);
  });
  it('trades futures on margin with a contract multiplier', () => {
    let a = applyOrder(newAccount(), { symbol: 'ES=F', side: 'buy', qty: 2, price: 6000, mult: 50, future: true });
    expect(a.cash).toBe(100000);
    expect(a.positions['ES=F']).toEqual({ qty: 2, avgCost: 6000, mult: 50, future: true });
    const b = breakdown(a, { 'ES=F': 6010 });
    expect(b.rows[0].exposure).toBe(601000);
    expect(b.rows[0].pnl).toBe(1000);
    expect(b.equity).toBe(101000);
    expect(b.required).toBeCloseTo(60100);
    expect(() => applyOrder(a, { symbol: 'ES=F', side: 'buy', qty: 2, price: 6000 })).toThrow(/Not enough buying power/);
    a = applyOrder(a, { symbol: 'ES=F', side: 'sell', qty: 3, price: 5990 });
    expect(a.realized).toBe(-1000);
    expect(a.cash).toBe(99000);
    expect(a.positions['ES=F']).toMatchObject({ qty: -1, avgCost: 5990, mult: 50 });
    // closing is always allowed, even with no buying power left
    const broke = { ...a, cash: 0 };
    expect(applyOrder(broke, { symbol: 'ES=F', side: 'buy', qty: 1, price: 5990 }).positions['ES=F']).toBeUndefined();
  });
  it('breaks positions down by value, profit and weight', () => {
    let a = newAccount();
    a = applyOrder(a, { symbol: 'AAPL', side: 'buy', qty: 100, price: 100 });
    a = applyOrder(a, { symbol: 'MSFT', side: 'buy', qty: 50, price: 400 });
    const b = breakdown(a, { AAPL: 110 });
    expect(b.equity).toBe(101000);
    expect(b.rows[0].symbol).toBe('MSFT');
    expect(b.rows[0].priced).toBe(false);
    expect(b.rows[1].pnl).toBe(1000);
    expect(b.rows[1].pnlPct).toBeCloseTo(10);
    expect(b.rows[1].weight).toBeCloseTo(10.89, 1);
    expect(b.total).toBe(1000);
    expect(b.longExp).toBe(31000);
    expect(b.shortExp).toBe(0);
    expect(b.buyingPower).toBe(70000);
  });
});

import { widgetPaper, widgetWatchlist } from '../src/lib/native';

describe('widget data', () => {
  it('mirrors the watchlist and paper account for the home-screen widgets', () => {
    expect(widgetWatchlist([{ symbol: 'AAPL', name: 'Apple' }, CATALOG['CL=F']])).toEqual([
      { s: 'AAPL', l: 'AAPL', n: 'Apple' },
      { s: 'CL=F', l: 'CLmain', n: 'Crude oil futures' },
    ]);
    const a = applyOrder(newAccount(), { symbol: 'AAPL', side: 'buy', qty: 10, price: 100 });
    expect(widgetPaper(a)).toEqual({ cash: 99000, start: 100000, positions: [{ s: 'AAPL', l: 'AAPL', q: 10, c: 100, m: 1, f: false }] });
  });
});

import { DEFAULT_FILTERS, fundaMatch, isDefaultFilter, macroMatch, normalizeFilters, quantMatch, screenSymbols, turtleMatch } from '../src/lib/filters';
import { judge, qualityLabels, verdictWhy } from '../src/lib/fundamentals';
import { signalWhy, templateScore, templateShort } from '../src/lib/screen';
import { alertItems, alertKey } from '../src/lib/alerts';
import { alertConfig } from '../src/lib/native';
import { gatewayBase, gatewayError, parseAccounts, parsePositions, parseSummary } from '../src/lib/ibkr';
import { HttpError } from '../src/lib/http';
import { isIndexSymbol, majorCurrency, toLocal } from '../src/lib/market';

describe('screener filters', () => {
  it('cleans up saved filters and keeps related numbers consistent', () => {
    const f = normalizeFilters({ universe: 'large', macro: { fast: 300, slow: 10, trend: 'sideways' }, quant: { z: 'x', rsiLow: 60, signals: ['momentum', 'nope'] }, tech: { enterN: 20, exitN: 50, checks: [false] }, funda: { pegCheap: 3, pegFair: 1, pegPricey: 2 } });
    expect(f.universe).toBe('large');
    expect(f.macro).toEqual({ trend: 'any', fast: 150, slow: 151 });
    expect(f.quant.z).toBe(2);
    expect(f.quant.rsiLow).toBe(49);
    expect(f.quant.signals).toEqual(['momentum']);
    expect(f.tech.exitN).toBe(20);
    expect(f.tech.checks).toEqual([false, true, true, true, true, true, true, true]);
    expect([f.funda.pegCheap, f.funda.pegFair, f.funda.pegPricey]).toEqual([3, 3, 3]);
    expect(isDefaultFilter(f, 'quant')).toBe(false);
    expect(isDefaultFilter(normalizeFilters(null), 'tech')).toBe(true);
  });
  it('applies adjustable quant thresholds', () => {
    const calm = [...ramp(245, 100, 0.5), 222.4, 222.1, 221.6, 221.2, 220.6];
    expect(quantRow('A', calm).signal).toBe('momentum'); // a mild dip is not a signal at the standard thresholds
    const loose = quantRow('A', calm, { z: 0.5, rsiLow: 40, rsiHigh: 60, mom: 20 });
    expect(loose.signal).toBe('dip-uptrend');
    expect(quantMatch(loose, { ...DEFAULT_FILTERS.quant })).toBe(true);
    expect(quantMatch(loose, { ...DEFAULT_FILTERS.quant, signals: ['momentum'] })).toBe(false);
    expect(signalWhy('stretched-up', { z: 1.5, rsiLow: 5, rsiHigh: 95, mom: 20 })).toMatch(/1\.5 standard deviations/);
  });
  it('lets macro averages and the trend filter be changed', () => {
    const a = [...ramp(200, 100, 0.5), ...ramp(50, 200, -1.2)];
    expect(macroRow('X', a).trend).toBe('mixed');
    expect(macroRow('X', a, { fast: 10, slow: 30 }).trend).toBe('down');
    expect(macroMatch(macroRow('X', a), { trend: 'any', fast: 50, slow: 200 })).toBe(true);
    expect(macroMatch(macroRow('X', a), { trend: 'up', fast: 50, slow: 200 })).toBe(false);
  });
  it('scores the trend template against only the required checks', () => {
    const pullback = trendTemplate('PB', [...ramp(230, 100, 1), ...ramp(20, 320, -4)])!;
    const all = templateScore(pullback, Array(8).fill(true));
    expect(all.total).toBe(7); // relative strength is not ranked for a single stock
    expect(all.fails).toEqual(pullback.checks.map((ok, i) => (ok ? -1 : i)).filter((i) => i >= 0));
    expect(all.fails).toContain(6);
    expect(all.passed).toBe(7 - all.fails.length);
    // Switch off exactly the failing checks and the stock passes.
    const required = Array.from({ length: 8 }, (_, i) => !all.fails.includes(i));
    expect(templateScore(pullback, required)).toEqual({ total: 7 - all.fails.length, passed: 7 - all.fails.length, fails: [] });
    const loose = trendTemplate('PB', [...ramp(230, 100, 1), ...ramp(20, 320, -4)], { lowPct: 30, highPct: 40, rsMin: 70 })!;
    expect(loose.checks[6]).toBe(true);
    expect(templateShort({ lowPct: 20, highPct: 15, rsMin: 80 })[5]).toBe('20% off low');
    const many = rankTemplate(Array.from({ length: 10 }, (_, i) => trendTemplate(`S${i}`, ramp(250, 100, 0.1 + i * 0.1))!), 8, 20);
    expect(many.filter((r) => r.checks[7]).length).toBeGreaterThan(rankTemplate(many.map((r) => ({ ...r })), 8, 90).filter((r) => r.checks[7]).length);
  });
  it('filters futures by position and never lets the exit window exceed the entry window', () => {
    const flat = Array.from({ length: 80 }, (_, i) => 100 + (i % 2));
    const long = turtle('L', [...flat, 103, 104, 105, 106])!;
    expect(turtleMatch(long, { ...DEFAULT_FILTERS.tech, pos: 'open' })).toBe(true);
    expect(turtleMatch(long, { ...DEFAULT_FILTERS.tech, pos: 'short' })).toBe(false);
    expect(turtleMatch(turtle('F', flat)!, { ...DEFAULT_FILTERS.tech, pos: 'open' })).toBe(false);
    expect(turtle('L', [...flat, 103, 104, 105, 106], 20, 60)!.pos).toBe(turtle('L', [...flat, 103, 104, 105, 106], 20, 20)!.pos);
    expect(turtle('T', ramp(15, 1, 1), 10, 5)).toBeNull();
  });
  it('re-judges fundamentals when thresholds change, without new data', () => {
    const f = parseMetrics('A', { peTTM: 60, epsGrowth5Y: 12, roeTTM: 40, netProfitMarginTTM: 25, 'totalDebt/totalEquityQuarterly': 0.2 });
    expect(f.verdict).toBe('quality-pricey');
    expect(judge(f, { ...DEFAULT_FILTERS.funda, pegFair: 6, pegPricey: 6 }).verdict).toBe('quality-fair');
    expect(judge(f, { ...DEFAULT_FILTERS.funda, roeMin: 50, marginMin: 30, debtMax: 0.1 }).quality).toEqual([false, false, false, true]);
    expect(fundaMatch(f, DEFAULT_FILTERS.funda)).toBe(false);
    expect(fundaMatch(f, { ...DEFAULT_FILTERS.funda, verdicts: ['quality-pricey'] })).toBe(true);
    expect(qualityLabels({ ...DEFAULT_FILTERS.funda, debtMax: 2 })[2]).toBe('Debt no more than 2 times equity');
    expect(verdictWhy('quality-fair', { ...DEFAULT_FILTERS.funda, pegFair: 1.2 })).toMatch(/PEG 1\.2 or lower/);
  });
  it('lists what the alert job should look for', () => {
    const list = [{ symbol: 'AAPL', name: 'Apple' }, CATALOG['CL=F']];
    expect(screenSymbols(list, 'watchlist').stocks).toEqual(['AAPL']);
    expect(screenSymbols(list, 'watchlist').quant).toEqual(['AAPL', 'CL=F']);
    expect(screenSymbols(list, 'large').stocks.length).toBe(30);
    const cfg = alertConfig(true, list, DEFAULT_FILTERS);
    expect(cfg.on).toBe(true);
    expect(cfg.futures).toContain('CL=F');
    expect(cfg.labels['CL=F']).toBe('CLmain');
    expect(cfg.labels.AAPL).toBeUndefined();
    const dip = [...ramp(245, 100, 0.5), 215, 208, 200, 196, 192];
    const up = ramp(250, 100, 0.6);
    const items = alertItems({ AAPL: dip, 'CL=F': up, 'GC=F': ramp(250, 300, -0.5) }, cfg).map(alertKey);
    expect(items).toContain('quant:AAPL:dip-uptrend');
    expect(items).toContain('macro:CL=F:up');
    expect(items).toContain('macro:GC=F:down');
    expect(items).toContain('turtle:CL=F:long');
    expect(alertItems({ 'CL=F': up }, { ...cfg, f: { ...cfg.f, macro: { ...cfg.f.macro, trend: 'down' } } }).some((i) => i.tab === 'macro')).toBe(false);
  });
});

describe('IBKR gateway', () => {
  it('tidies the address the user types', () => {
    expect(gatewayBase(' 192.168.1.20:5000 ')).toBe('https://192.168.1.20:5000');
    expect(gatewayBase('https://pc.tail1234.ts.net/v1/api/')).toBe('https://pc.tail1234.ts.net');
    expect(gatewayBase('http://localhost:5000')).toBe('http://localhost:5000');
    expect(gatewayBase('')).toBeNull();
    expect(gatewayBase('not a url')).toBeNull();
  });
  it('reads accounts, positions and the summary from IBKR-shaped replies', () => {
    expect(parseAccounts([{ id: 'U1234567', accountId: 'U1234567', accountTitle: 'Jane Doe', currency: 'USD' }, {}])).toEqual([{ id: 'U1234567', title: 'Jane Doe', currency: 'USD' }]);
    const pos = parsePositions([
      { acctId: 'U1234567', conid: 756733, contractDesc: 'SPY', position: 5.0, mktPrice: 471.16000365, mktValue: 2355.8, currency: 'USD', avgCost: 434.93, avgPrice: 434.93, realizedPnl: 0.0, unrealizedPnl: 181.15, assetClass: 'STK' },
      { conid: 76792991, contractDesc: 'TSLA', ticker: 'TSLA', position: -7.0, mktPrice: 250.73399355, mktValue: -1755.14, currency: 'USD', avgCost: 221.67142855, unrealizedPnl: -203.44, assetClass: 'STK' },
      { conid: 1, contractDesc: 'OLD', position: 0, mktValue: 0 },
    ]);
    expect(pos.map((p) => p.symbol)).toEqual(['SPY', 'TSLA']);
    expect(pos[0]).toMatchObject({ qty: 5, value: 2355.8, avgCost: 434.93, pnl: 181.15, currency: 'USD' });
    expect(pos[0].pnlPct).toBeCloseTo(8.33, 1);
    expect(pos[1].qty).toBe(-7);
    expect(pos[1].pnlPct).toBeCloseTo(-13.11, 1);
    expect(parsePositions(null)).toEqual([]);
    const sum = parseSummary({ netliquidation: { amount: 215587.72, currency: 'USD', isNull: false }, totalcashvalue: { amount: 10000 }, buyingpower: { amount: 36000 }, availablefunds: { amount: null } });
    expect(sum).toEqual({ netLiq: 215587.72, cash: 10000, buyingPower: 36000, available: null, currency: 'USD' });
    expect(parseSummary({}).netLiq).toBeNull();
  });
  it('explains connection failures', () => {
    expect(gatewayError(new HttpError(401, 'x'))).toMatch(/not logged in/);
    expect(gatewayError(new Error('javax.net.ssl.SSLHandshakeException: Trust anchor for certification path not found.'))).toMatch(/certificate/);
    expect(gatewayError(new Error('Failed to connect to /192.168.1.20:5000'))).toMatch(/Could not reach/);
    expect(gatewayError(new Error('Cleartext HTTP traffic to 192.168.1.20 not permitted'))).toMatch(/https/);
  });
});

describe('local currency', () => {
  it('combines the move in the ticker with the move in the exchange rate', () => {
    const l = toLocal({ price: 110, prevClose: 100 }, { rate: 4.4, prev: 4.5 });
    expect(l.price).toBeCloseTo(484);
    expect(l.changePct).toBeCloseTo(7.556, 2);
    expect(l.change).toBeCloseTo(34);
    expect(toLocal({ price: 250, prevClose: 250 }, { rate: 5.7, prev: 5.7 }, 0.01).price).toBeCloseTo(14.25);
  });
  it('knows pence-quoted listings and index symbols', () => {
    expect(majorCurrency('GBp')).toEqual(['GBP', 0.01]);
    expect(majorCurrency('USD')).toEqual(['USD', 1]);
    expect(isIndexSymbol('DX-Y.NYB')).toBe(true);
    expect(isIndexSymbol('^GSPC')).toBe(true);
    expect(isIndexSymbol('AAPL')).toBe(false);
    expect(parseYahooQuote('1155.KL', { chart: { result: [{ meta: { regularMarketPrice: 10.2, chartPreviousClose: 10, currency: 'MYR' }, timestamp: [1], indicators: { quote: [{ close: [10.2] }] } }] } }).currency).toBe('MYR');
  });
});

import { applyBackup, backupName, describeBackup, makeBackup, readBackup } from '../src/lib/backup';
import { parseAccountDetails, parseBalances, parseProfiles, parseQuote, parseRecipients, parseTransfer, parseTransfers, wiseMessage } from '../src/lib/wise';

describe('private markets news', () => {
  it('files private equity and venture capital headlines', () => {
    expect(categoryOf('Anthropic raises $10 billion at a $350 billion valuation')).toBe('private');
    expect(categoryOf('Startup lands $50 million funding round led by Sequoia')).toBe('private');
    expect(categoryOf('KKR to acquire healthcare group for $4 billion')).toBe('private');
    expect(categoryOf('Blackstone closes $20 billion real estate fund')).toBe('private');
    expect(categoryOf('Private equity firms circle UK retailer')).toBe('private');
    expect(categoryOf('Fintech closes Series C to expand in Asia')).toBe('private');
    expect(groupOf('private')).toBe('corporate');
  });
  it('leaves public-company deals and raises where they were', () => {
    expect(categoryOf('Microsoft to acquire gaming studio for $2 billion')).toBe('ma');
    expect(categoryOf('Apple announces $90 billion share buyback')).toBe('corpfund');
    expect(categoryOf('Utility raises $2 billion in bond sale to fund new plants')).toBe('corpfund');
    expect(categoryOf('VC-backed chip designer files for IPO')).toBe('ipo');
    expect(categoryOf('Company converts Series A shares ahead of results')).not.toBe('private');
    expect(GROUPS.flatMap((g) => g.cats).length).toBe(14);
  });
});

describe('Wise', () => {
  it('reads profiles in both of the shapes Wise has used', () => {
    expect(parseProfiles([{ id: 11, type: 'PERSONAL', fullName: 'Sarah Jenkins' }, { id: 12, type: 'BUSINESS', businessName: 'Acme Ltd', fullName: 'Acme Ltd' }]))
      .toEqual([{ id: 11, type: 'personal', name: 'Sarah Jenkins' }, { id: 12, type: 'business', name: 'Acme Ltd' }]);
    expect(parseProfiles([{ id: 21, type: 'personal', details: { firstName: 'Oliver', lastName: 'Wilson' } }, { type: 'personal' }])).toEqual([{ id: 21, type: 'personal', name: 'Oliver Wilson' }]);
    expect(parseProfiles({ error: 'x' })).toEqual([]);
  });
  it('reads balances and saved recipients', () => {
    const balances = parseBalances([
      { id: 1, currency: 'EUR', type: 'STANDARD', amount: { value: 0, currency: 'EUR' } },
      { id: 2, currency: 'USD', type: 'STANDARD', amount: { value: 310.86, currency: 'USD' } },
      { id: 3, currency: 'MYR' },
    ]);
    expect(balances).toEqual([{ id: 2, currency: 'USD', amount: 310.86 }, { id: 1, currency: 'EUR', amount: 0 }]);
    const page = { content: [
      { id: 40, currency: 'GBP', active: true, name: { fullName: 'John Doe' }, accountSummary: '(04-00-75) 37778842', longAccountSummary: 'GBP account ending in 8842', ownedByCustomer: false },
      { id: 41, currency: 'MYR', active: true, accountHolderName: 'Me Myself', accountSummary: 'Maybank 1234', ownedByCustomer: true },
      { id: 42, currency: 'USD', active: false, name: { fullName: 'Old' } },
    ], seekPositionForNext: 42, size: 20 };
    expect(parseRecipients(page)).toEqual([
      { id: 40, currency: 'GBP', name: 'John Doe', summary: 'GBP account ending in 8842', own: false },
      { id: 41, currency: 'MYR', name: 'Me Myself', summary: 'Maybank 1234', own: true },
    ]);
    expect(parseRecipients(null)).toEqual([]);
  });
  it('takes the pay-from-balance option out of a quote', () => {
    const raw = {
      id: 'a0123456-b789', sourceCurrency: 'USD', targetCurrency: 'MYR', sourceAmount: 1000, payOut: 'BANK_TRANSFER', rate: 4.42, expirationTime: '2026-11-16T06:00:00Z',
      paymentOptions: [
        { payIn: 'BANK_TRANSFER', payOut: 'BANK_TRANSFER', sourceAmount: 1000, targetAmount: 4390, fee: { total: 6.8 }, disabled: false },
        { payIn: 'BALANCE', payOut: 'BANK_TRANSFER', sourceAmount: 1000, targetAmount: 4401.7, fee: { transferwise: 4.14, total: 4.14 }, formattedEstimatedDelivery: 'by Tuesday', disabled: false },
      ],
      notices: [{ text: 'You can have a maximum of 3 open transfers with a guaranteed rate.', link: null, type: 'WARNING' }],
    };
    expect(parseQuote(raw)).toEqual({
      id: 'a0123456-b789', sourceCurrency: 'USD', targetCurrency: 'MYR', sourceAmount: 1000, targetAmount: 4401.7, fee: 4.14, rate: 4.42,
      delivery: 'by Tuesday', expires: '2026-11-16T06:00:00Z', blocked: null, notices: ['You can have a maximum of 3 open transfers with a guaranteed rate.'],
    });
    const off = parseQuote({ ...raw, paymentOptions: [{ ...raw.paymentOptions[1], disabled: true, disabledReason: { code: 'x', message: 'Open a USD balance first.' } }] });
    expect(off!.blocked).toBe('Open a USD balance first.');
    expect(parseQuote({ ...raw, paymentOptions: [raw.paymentOptions[0]] })!.blocked).toMatch(/does not offer/);
    expect(parseQuote({ ...raw, notices: [{ text: 'Not allowed.', type: 'BLOCKED' }] })!.blocked).toBe('Not allowed.');
    expect(parseQuote({ paymentOptions: [] })).toBeNull();
    expect(parseQuote({ ...raw, paymentOptions: [{ payIn: 'BALANCE', sourceAmount: 1000 }] })).toBeNull();
  });
  it('reads a draft transfer and explains errors', () => {
    const t = parseTransfer({ id: 16521632, targetAccount: 8692237, quoteUuid: 'q', status: 'incoming_payment_waiting', rate: 4.42, created: '2026-11-16 05:30:00', details: { reference: 'to my bank' }, sourceCurrency: 'USD', sourceValue: 1000, targetCurrency: 'MYR', targetValue: 4401.7 });
    expect(t).toEqual({ id: 16521632, status: 'incoming_payment_waiting', recipientId: 8692237, reference: 'to my bank', created: '2026-11-16 05:30:00', sourceCurrency: 'USD', sourceAmount: 1000, targetCurrency: 'MYR', targetAmount: 4401.7 });
    expect(parseTransfer({ status: 'x' })).toBeNull();
    expect(parseTransfers([{ id: 1 }, {}, { id: 2 }]).map((x) => x.id)).toEqual([1, 2]);
    expect(wiseMessage(401, { error: 'unauthorized' })).toMatch(/did not accept the token/);
    expect(wiseMessage(422, { errors: [{ code: 'NOT_VALID', message: 'Transfer purpose is required.', path: 'details.transferPurpose' }] })).toBe('Wise could not accept this: Transfer purpose is required.');
    expect(wiseMessage(403, { message: 'Forbidden' })).toMatch(/read-only/);
    expect(wiseMessage(500, null)).toBe('Wise answered with an error (500).');
  });
});

describe('backup', () => {
  const store = (init: Record<string, unknown>) => {
    const m = new Map(Object.entries(init).map(([k, v]) => [k, JSON.stringify(v)]));
    return { get: (k: string) => m.get(k) ?? null, set: (k: string, v: string) => { m.set(k, v); }, read: (k: string) => JSON.parse(m.get(k) ?? 'null') };
  };
  const phone = store({
    'ta.watchlist': [{ symbol: 'AAPL' }, { symbol: 'NVDA' }],
    'ta.settings': { finnhubKey: 'SECRET-KEY', hideLowValue: true, showInfo: false, notify: true, ibkrUrl: 'https://pc.example:5000', currency: 'MYR' },
    'ta.filters': { universe: 'large' },
    'ta.paper': { start: 100000, cash: 99000, realized: 0, positions: { AAPL: { qty: 10, avgCost: 100 } }, trades: [] },
    'CapacitorStorage.secret.wise': { token: 'WISE-TOKEN' },
  });
  it('leaves keys and tokens out', () => {
    const b = makeBackup(phone.get, new Date('2026-11-16T05:40:00Z'));
    const text = JSON.stringify(b);
    expect(text).not.toContain('SECRET-KEY');
    expect(text).not.toContain('WISE-TOKEN');
    expect((b.data['ta.settings'] as any).notify).toBe(false);
    expect((b.data['ta.settings'] as any).currency).toBe('MYR');
    expect(b.savedAt).toBe('2026-11-16T05:40:00.000Z');
    expect(backupName(new Date('2026-11-16T05:40:00Z'))).toBe('TradingApp-backup-2026-11-16.json');
    expect(describeBackup(b)).toMatch(/2 watchlist tickers, 1 paper position, settings/);
  });
  it('restores onto another phone and keeps that phone\'s own key', () => {
    const text = JSON.stringify(makeBackup(phone.get));
    const other = store({ 'ta.watchlist': [{ symbol: 'TSLA' }], 'ta.settings': { finnhubKey: 'OTHER-KEY', currency: '' } });
    const r = readBackup(text);
    expect('backup' in r).toBe(true);
    if ('backup' in r) applyBackup(r.backup, other.get, other.set);
    expect(other.read('ta.watchlist')).toEqual([{ symbol: 'AAPL' }, { symbol: 'NVDA' }]);
    expect(other.read('ta.settings')).toMatchObject({ finnhubKey: 'OTHER-KEY', currency: 'MYR', notify: false, ibkrUrl: 'https://pc.example:5000' });
    expect(other.read('ta.paper').cash).toBe(99000);
    expect(other.read('ta.v3')).toBe(true);
  });
  it('rejects files that are not a backup', () => {
    expect(readBackup('hello')).toEqual({ error: 'This file is not a TradingApp backup.' });
    expect(readBackup(JSON.stringify({ app: 'Other', kind: 'backup', version: 1, data: {} }))).toHaveProperty('error');
    expect(readBackup(JSON.stringify({ app: 'TradingApp', kind: 'backup', version: 2, savedAt: '', data: {} }))).toEqual({ error: 'This backup was made by a newer version of TradingApp. Update the app, then restore.' });
  });
});

describe('Wise deposit details', () => {
  it('keeps issued details and lists sample-only currencies as not set up', () => {
    const r = parseAccountDetails([
      { id: 1, currency: { code: 'USD', name: 'US dollar' }, status: 'ACTIVE', deprecated: false, receiveOptions: [
        { type: 'LOCAL', title: 'Local', details: [{ type: 'ACCOUNT_HOLDER', title: 'Name', body: 'Test User', hidden: false }, { type: 'ACCOUNT_NUMBER', title: 'Account number', body: '8310006087', hidden: false }, { type: 'X', title: 'Internal', body: 'x', hidden: true }] },
        { type: 'INTERNATIONAL', title: 'SWIFT', details: [{ title: 'SWIFT/BIC', body: 'CMFGUS33' }] },
      ] },
      { id: null, currency: { code: 'EUR', name: 'Euro' }, status: 'AVAILABLE', receiveOptions: [{ type: 'LOCAL', details: [{ title: 'IBAN', body: 'BE00 0000 0000 0000' }] }] },
      { id: 3, currency: { code: 'GBP' }, status: 'ACTIVE', deprecated: true, receiveOptions: [] },
    ]);
    expect(r.ready).toEqual([{ currency: 'USD', name: 'US dollar', options: [
      { type: 'LOCAL', title: 'Local', fields: [{ label: 'Name', value: 'Test User' }, { label: 'Account number', value: '8310006087' }] },
      { type: 'INTERNATIONAL', title: 'SWIFT', fields: [{ label: 'SWIFT/BIC', value: 'CMFGUS33' }] },
    ] }]);
    expect(r.notSetUp).toEqual(['EUR']);
    expect(parseAccountDetails(null)).toEqual({ ready: [], notSetUp: [] });
  });
});

import { priceOrder, rebalancePlan, runRules, type PriceRule, type RebalanceRule } from '../src/lib/strategy';

describe('strategies', () => {
  const base = () => {
    let a = newAccount();
    a = applyOrder(a, { symbol: 'AAPL', side: 'buy', qty: 100, price: 200 });
    a = applyOrder(a, { symbol: 'MSFT', side: 'buy', qty: 50, price: 400 });
    return a; // 20,000 + 20,000 invested, 60,000 cash
  };
  const pr = (o: Partial<PriceRule>): PriceRule => ({ id: 'p', kind: 'price', symbol: 'AAPL', takeProfit: 250, stopLoss: 180, qty: null, on: true, created: 0, ...o });
  it('sells at the target or the stop, once', () => {
    const a = base();
    expect(priceOrder(pr({}), a, 240)).toBeNull();
    expect(priceOrder(pr({}), a, 251)!.order).toEqual({ symbol: 'AAPL', side: 'sell', qty: 100, price: 251 });
    expect(priceOrder(pr({ qty: 30 }), a, 179)!.why).toMatch(/stop/);
    expect(priceOrder(pr({ symbol: 'TSLA' }), a, 999)).toBeNull();
    const r = runRules(a, [pr({ qty: 40 })], { AAPL: 260, MSFT: 400 }, 1);
    expect(r.account.positions.AAPL.qty).toBe(60);
    expect(r.account.realized).toBe(2400);
    expect(r.rules[0].on).toBe(false);
    expect(runRules(r.account, r.rules, { AAPL: 270 }, 2).fired).toEqual([]);
  });
  it('plans whole-share rebalancing within the cash available', () => {
    const a = base();
    const plan = rebalancePlan(a, [{ symbol: 'AAPL', weight: 50 }, { symbol: 'MSFT', weight: 10 }], { AAPL: 200, MSFT: 400 });
    expect(plan.drift).toBeCloseTo(30);
    expect(plan.orders).toEqual([{ symbol: 'MSFT', side: 'sell', qty: 25, price: 400 }, { symbol: 'AAPL', side: 'buy', qty: 150, price: 200 }]);
    expect(rebalancePlan(a, [{ symbol: 'AAPL', weight: 50 }, { symbol: 'NVDA', weight: 10 }], { AAPL: 200 }).missing).toEqual(['NVDA']);
    const tight = rebalancePlan({ ...a, cash: 1000 }, [{ symbol: 'AAPL', weight: 90 }], { AAPL: 200, MSFT: 400 });
    expect(tight.orders).toEqual([{ symbol: 'AAPL', side: 'buy', qty: 5, price: 200 }]);
  });
  it('rebalances automatically only past the drift limit', () => {
    const a = base();
    const rule: RebalanceRule = { id: 'r', kind: 'rebalance', targets: [{ symbol: 'AAPL', weight: 20 }, { symbol: 'MSFT', weight: 20 }], drift: 5, auto: true, on: true, created: 0 };
    expect(runRules(a, [rule], { AAPL: 200, MSFT: 400 }).fired).toEqual([]);
    const moved = runRules(a, [rule], { AAPL: 300, MSFT: 400 }, 5);
    expect(moved.fired[0].text).toMatch(/Rebalanced with/);
    const w = breakdown(moved.account, { AAPL: 300, MSFT: 400 }).rows.find((x) => x.symbol === 'AAPL')!.weight;
    expect(Math.abs(w - 20)).toBeLessThan(1);
    expect(runRules(a, [{ ...rule, auto: false }], { AAPL: 300, MSFT: 400 }).fired).toEqual([]);
    expect(runRules(a, [{ ...rule, auto: false }], { AAPL: 300, MSFT: 400 }, 1, 'r').fired).toHaveLength(1);
  });
});

import { dividendSummary, parseDividends } from '../src/lib/market';

describe('dividends', () => {
  it('files dividend headlines under their own category', () => {
    expect(categoryOf('Coca-Cola raises quarterly dividend for 63rd straight year')).toBe('dividend');
    expect(categoryOf('Intel suspends dividend to fund factories')).toBe('dividend');
    expect(categoryOf('3 high-yield dividend stocks going ex-dividend next week')).toBe('dividend');
    expect(categoryOf('Apple announces $90 billion share buyback')).toBe('corpfund');
    expect(groupOf('dividend')).toBe('corporate');
  });
  it('reads Yahoo dividend events and sums the last year', () => {
    const now = Date.UTC(2026, 10, 16);
    const s = (d: string) => Date.parse(d) / 1000;
    const divs = parseDividends({ chart: { result: [{ events: { dividends: {
      a: { amount: 0.26, date: s('2026-08-11') }, b: { amount: 0.26, date: s('2026-05-12') }, c: { amount: 0.25, date: s('2026-02-09') },
      d: { amount: 0.25, date: s('2025-11-25') }, e: { amount: 0.25, date: s('2025-08-11') }, f: { amount: 'x', date: 1 } } } }] } });
    expect(divs).toHaveLength(5);
    expect(divs[0].amount).toBe(0.26);
    const sum = dividendSummary(divs, 200, now);
    expect(sum.perYear).toBe(4);
    expect(sum.total).toBeCloseTo(1.02);
    expect(sum.yieldPct).toBeCloseTo(0.51);
    expect(parseDividends({ chart: { result: [{}] } })).toEqual([]);
  });
  it('filters fundamentals by a minimum dividend yield', () => {
    const f = normalizeFilters({ funda: { verdicts: ['garp'], yieldMin: 2 } }).funda;
    const row: any = { verdict: 'garp', yieldPct: 1.5 };
    expect(fundaMatch(row, f)).toBe(false);
    expect(fundaMatch({ ...row, yieldPct: 3 }, f)).toBe(true);
    expect(fundaMatch({ ...row, yieldPct: null }, normalizeFilters({}).funda)).toBe(true); // no minimum by default
    expect(normalizeFilters({ funda: { yieldMin: 99 } }).funda.yieldMin).toBe(20);
  });
});
