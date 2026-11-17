// Keeps the background strategy job honest. The Android job runs the paper
// strategies in Java (native/java/Strategies.java). This test builds a set of
// accounts, rules and price moves, runs them through the TypeScript rules and
// writes the inputs and results to native/test/strategy-fixture.txt. The Java
// side (native/test/StrategyCrossCheck.java, `npm run test:native`) replays the
// same inputs and must end with the same cash, positions, rule states and fills.
//
// After changing a strategy or paper-account rule, regenerate with
// `UPDATE_FIXTURE=1 npm test`, then make Strategies.java match.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { newAccount, type Account } from '../src/lib/paper';
import { runRules, type Rule } from '../src/lib/strategy';

const FIXTURE = 'native/test/strategy-fixture.txt';
const SYMS = ['AAA', 'BBB', 'CCC', 'DDD', 'FUT'];

function rng(seed: number) {
  let s = seed | 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) | 0; return ((s >>> 8) & 0xffff) / 0x10000; };
}

function build(seed: number) {
  const r = rng(seed);
  const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  const px = (lo: number, hi: number) => Math.round((lo + r() * (hi - lo)) * 100) / 100;
  const base: Record<string, number> = { AAA: px(20, 400), BBB: px(20, 400), CCC: px(20, 400), DDD: px(5, 80), FUT: px(1000, 6000) };
  const a: Account = { ...newAccount(), cash: Math.round(px(5000, 100000)), realized: px(-500, 500) };
  for (const s of SYMS) {
    const roll = r();
    if (s === 'FUT') { if (roll < 0.4) a.positions.FUT = { qty: pick([1, 2, -1]), avgCost: px(base.FUT * 0.95, base.FUT * 1.05), mult: 50, future: true }; continue; }
    if (roll < 0.55) a.positions[s] = { qty: 1 + Math.floor(r() * 120), avgCost: px(base[s] * 0.7, base[s] * 1.3) };
    else if (roll < 0.65) a.positions[s] = { qty: -(1 + Math.floor(r() * 40)), avgCost: px(base[s] * 0.8, base[s] * 1.2) };
  }
  const rules: Rule[] = [];
  const n = 1 + Math.floor(r() * 3);
  for (let i = 0; i < n; i++) {
    const s = pick(SYMS.slice(0, 4));
    const tp = r() < 0.7 ? px(base[s] * 1.0, base[s] * 1.15) : null;
    const sl = r() < 0.6 || tp === null ? px(base[s] * 0.85, base[s] * 1.0) : null;
    rules.push({ id: `p${i}`, kind: 'price', symbol: s, takeProfit: tp, stopLoss: sl, qty: r() < 0.5 ? null : 1 + Math.floor(r() * 60), on: r() < 0.9, created: 0 });
  }
  if (r() < 0.7) {
    const k = 1 + Math.floor(r() * 4);
    const chosen = SYMS.slice(0, 4).filter(() => r() < 0.7).slice(0, k);
    if (chosen.length) {
      rules.push({
        id: 'r', kind: 'rebalance', targets: chosen.map((s) => ({ symbol: s, weight: Math.round(px(5, 90 / chosen.length)) })),
        drift: pick([1, 3, 5, 10]), auto: r() < 0.85, on: r() < 0.9, created: 0,
      });
    }
  }
  const steps: { time: number; prices: Record<string, number> }[] = [];
  const cur = { ...base };
  for (let t = 0; t < 4; t++) {
    const prices: Record<string, number> = {};
    for (const s of SYMS) {
      cur[s] = Math.max(1, Math.round(cur[s] * (1 + (r() - 0.5) * 0.25) * 100) / 100);
      if (r() < 0.92) prices[s] = cur[s];
    }
    steps.push({ time: 1_800_000_000_000 + t * 3_600_000, prices });
  }
  return { a, rules, steps };
}

const n = (v: number | null | undefined) => (v === null || v === undefined ? '-' : String(v));

function fixture(): string {
  const out: string[] = ['# Written by tests/strategycross.test.ts. Regenerate with: UPDATE_FIXTURE=1 npm test'];
  for (let c = 0; c < 300; c++) {
    let { a, rules, steps } = build(7919 * (c + 1));
    out.push(`CASE ${c}`, `ACCT ${n(a.start)} ${n(a.cash)} ${n(a.realized)}`);
    for (const [s, p] of Object.entries(a.positions)) out.push(`POS ${s} ${n(p.qty)} ${n(p.avgCost)} ${n(p.mult ?? 1)} ${p.future ? 1 : 0}`);
    for (const r of rules) {
      if (r.kind === 'price') out.push(`PRULE ${r.id} ${r.symbol} ${n(r.takeProfit)} ${n(r.stopLoss)} ${n(r.qty)} ${r.on ? 1 : 0}`);
      else out.push(`RRULE ${r.id} ${n(r.drift)} ${r.auto ? 1 : 0} ${r.on ? 1 : 0} ${r.targets.map((t) => `${t.symbol}:${n(t.weight)}`).join(',')}`);
    }
    for (const st of steps) {
      const res = runRules(a, rules, st.prices, st.time);
      a = res.account;
      rules = res.rules;
      out.push(`STEP ${st.time} ${Object.entries(st.prices).map(([s, p]) => `${s}=${n(p)}`).join(',') || '-'}`);
      out.push(`WANT ${n(a.cash)} ${n(a.realized)} ${Object.entries(a.positions).map(([s, p]) => `${s}:${n(p.qty)}:${n(p.avgCost)}`).join('|') || '-'} `
        + `${rules.map((r) => `${r.id}:${r.on ? 1 : 0}:${r.kind === 'rebalance' ? n(r.last) : '-'}`).join('|') || '-'} `
        + `${res.fired.map((f) => `${f.ruleId}:${f.ok ? 1 : 0}`).join('|') || '-'} ${a.trades.length}`);
      for (const f of res.fired) if (f.ok) out.push(`TEXT ${f.text}`);
    }
    out.push('END');
  }
  return out.join('\n') + '\n';
}

describe('background strategy fixture', () => {
  it('matches the fixture the Java job is checked against', () => {
    const text = fixture();
    if (process.env.UPDATE_FIXTURE || !existsSync(FIXTURE)) writeFileSync(FIXTURE, text);
    expect(readFileSync(FIXTURE, 'utf8')).toBe(text);
    const fills = (text.match(/^TEXT /gm) || []).length;
    expect(fills).toBeGreaterThan(100); // the cases exercise both rule kinds
    expect(text).toMatch(/^TEXT Rebalanced with/m);
    expect(text).toMatch(/^TEXT Sold .*reached target/m);
    expect(text).toMatch(/^TEXT Sold .*fell to stop/m);
  });
});
