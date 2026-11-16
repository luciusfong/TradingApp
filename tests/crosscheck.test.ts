// Keeps the Android alert job honest. The job re-implements the Screener's rules
// in Java (native/java/Screens.java). This test writes down, for a set of
// generated price series and filter settings, exactly which alert keys the
// TypeScript rules produce (native/test/fixture.txt). The Java side reads the
// same file, regenerates the same prices and must produce the same keys
// (native/test/CrossCheck.java, run in CI and by `npm run test:native`).
//
// If you change a screening rule, this test fails until the fixture is
// regenerated with `UPDATE_FIXTURE=1 npm test`, and then the Java check fails
// until Screens.java is changed to match.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { alertItems, alertKey, type AlertConfig } from '../src/lib/alerts';
import { DEFAULT_FILTERS, normalizeFilters, type Filters } from '../src/lib/filters';

const FIXTURE = 'native/test/fixture.txt';

// Prices are built from whole-number cents with a 32-bit generator, so Java can
// rebuild exactly the same numbers. Kinds: 0 random, 1 uptrend ending in a sharp
// dip, 2 downtrend ending in a spike, 3 strong uptrend, 4 drifting sideways.
export function series(seed: number, kind: number, len: number): number[] {
  let s = seed | 0;
  const next = () => { s = (Math.imul(s, 1664525) + 1013904223) | 0; return (s >>> 8) & 0xffff; };
  const drift = [0, 60, -60, 120, 0][kind];
  let p = 2000 + (next() % 30000);
  const vol = 600 + (next() % 1400);
  const out: number[] = [];
  for (let i = 0; i < len; i++) {
    let change = drift + Math.trunc((((next() % 2001) - 1000) * vol) / 1000);
    if (kind === 1 && i >= len - 3) change -= 2500;
    if (kind === 2 && i >= len - 3) change += 2500;
    p = Math.max(100, p + Math.trunc((p * change) / 100000));
    out.push(p / 100);
  }
  return out;
}

interface Sym { name: string; seed: number; kind: number; len: number }
interface Case { name: string; syms: Sym[]; lists: Pick<AlertConfig, 'macro' | 'quant' | 'stocks' | 'futures'>; f: Filters }

function makeCase(name: string, seed: number, count: number, raw: unknown, shortEvery = 0): Case {
  const syms: Sym[] = Array.from({ length: count }, (_, i) => ({
    name: `S${i}`,
    seed: seed * 1000 + i * 7919,
    kind: i % 5,
    // A few short histories, to cover the "not enough data" paths.
    len: shortEvery && i % shortEvery === shortEvery - 1 ? [221, 100, 61, 40, 20][(i / shortEvery | 0) % 5] : 252,
  }));
  const names = syms.map((x) => x.name);
  return {
    name,
    syms,
    lists: { macro: names.slice(0, 8), quant: names, stocks: names.filter((_, i) => i % 4 !== 3), futures: names.filter((_, i) => i % 4 === 3 || i < 6) },
    f: normalizeFilters(raw),
  };
}

const CASES: Case[] = [
  makeCase('defaults', 1, 40, {}),
  makeCase('defaults with short histories', 2, 45, {}, 6),
  makeCase('small list, no relative strength', 3, 7, {}),
  makeCase('loose quant, fast macro, short turtle', 4, 40, {
    macro: { trend: 'up', fast: 20, slow: 100 },
    quant: { z: 1.5, rsiLow: 15, rsiHigh: 85, mom: 10, signals: ['dip-uptrend', 'momentum', 'stretched-up'] },
    tech: { checks: [true, true, false, true, true, true, true, true], lowPct: 15, highPct: 40, rsMin: 40, enterN: 20, exitN: 10, pos: 'long' },
  }),
  makeCase('strict quant, downtrends, shorts only', 5, 40, {
    macro: { trend: 'down', fast: 30, slow: 150 },
    quant: { z: 2.5, rsiLow: 2, rsiHigh: 98, mom: 35, signals: ['spike-downtrend', 'stretched-down'] },
    tech: { checks: [true, true, true, true, true, false, false, false], lowPct: 50, highPct: 10, rsMin: 90, enterN: 100, exitN: 50, pos: 'short' },
  }, 9),
  makeCase('only relative strength required', 6, 30, {
    tech: { checks: [false, false, false, false, false, false, false, true], rsMin: 55, enterN: 30, exitN: 30, pos: 'open' },
  }),
  makeCase('no template checks, mixed macro', 7, 24, {
    macro: { trend: 'mixed' },
    quant: { z: 1, rsiLow: 30, rsiHigh: 70, mom: 0, signals: ['momentum', 'stretched-down', 'stretched-up', 'dip-uptrend', 'spike-downtrend'] },
    tech: { checks: Array(8).fill(false), enterN: 10, exitN: 5 },
  }, 5),
  makeCase('everything deselected', 8, 20, { quant: { signals: [] }, tech: { pos: 'long', enterN: 120, exitN: 120 } }),
];

function expectedKeys(c: Case): string[] {
  const data: Record<string, number[]> = {};
  for (const s of c.syms) data[s.name] = series(s.seed, s.kind, s.len);
  return alertItems(data, { ...c.lists, f: c.f }).map(alertKey).sort();
}

function render(): string {
  const out: string[] = ['# Written by tests/crosscheck.test.ts. Regenerate with: UPDATE_FIXTURE=1 npm test'];
  for (const c of CASES) {
    out.push(`CASE ${c.name}`);
    for (const s of c.syms) out.push(`SYM ${s.name} ${s.seed} ${s.kind} ${s.len}`);
    for (const k of ['macro', 'quant', 'stocks', 'futures'] as const) out.push(`LIST ${k} ${c.lists[k].join(',')}`);
    const { macro, quant, tech } = c.f;
    const params: [string, string | number][] = [
      ['macroTrend', macro.trend], ['fast', macro.fast], ['slow', macro.slow],
      ['z', quant.z], ['rsiLow', quant.rsiLow], ['rsiHigh', quant.rsiHigh], ['mom', quant.mom], ['signals', quant.signals.join(',')],
      ['checks', tech.checks.map((x) => (x ? 1 : 0)).join(',')], ['lowPct', tech.lowPct], ['highPct', tech.highPct], ['rsMin', tech.rsMin],
      ['enterN', tech.enterN], ['exitN', tech.exitN], ['pos', tech.pos],
    ];
    for (const [k, v] of params) out.push(`PARAM ${k} ${v}`);
    for (const k of expectedKeys(c)) out.push(`EXPECT ${k}`);
    out.push('END');
  }
  return out.join('\n') + '\n';
}

describe('alert rules fixture', () => {
  it('normalises empty filters to the defaults', () => {
    expect(normalizeFilters({})).toEqual(DEFAULT_FILTERS);
    expect(JSON.stringify(normalizeFilters({}))).toBe(JSON.stringify(DEFAULT_FILTERS));
  });
  it('covers every tab and every quant signal', () => {
    const all = CASES.flatMap(expectedKeys);
    for (const part of ['macro:', 'tech:', 'turtle:', ':up', ':down', ':long', ':short', ':dip-uptrend', ':spike-downtrend', ':stretched-down', ':stretched-up', ':momentum']) {
      expect(all.some((k) => k.includes(part)), part).toBe(true);
    }
    expect(expectedKeys(CASES[CASES.length - 1]).some((k) => k.startsWith('quant:'))).toBe(false);
  });
  it('matches the fixture the Java rules are checked against', () => {
    const text = render();
    if (process.env.UPDATE_FIXTURE || !existsSync(FIXTURE)) writeFileSync(FIXTURE, text);
    expect(readFileSync(FIXTURE, 'utf8')).toBe(text);
  });
});
