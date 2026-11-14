// On-device finance sentiment scorer. Rule-based: weighted phrases and words,
// negation flips, clamped to [-1, 1]. Tuned for headlines, not long text.

export type Label = 'positive' | 'negative' | 'neutral';
export interface Sentiment {
  score: number; // -1..1
  label: Label;
  hits: string[]; // matched terms, for showing "why"
}

// Phrases are matched first and consume their tokens, so "rate cut" is not
// also scored by the bare word "cut".
const PHRASES: Record<string, number> = {
  'beats estimates': 2.5, 'beat estimates': 2.5, 'beats expectations': 2.5, 'beat expectations': 2.5,
  'tops estimates': 2.5, 'tops expectations': 2.5, 'top estimates': 2.5, 'better than expected': 2.5,
  'misses estimates': -2.5, 'missed estimates': -2.5, 'misses expectations': -2.5, 'missed expectations': -2.5,
  'falls short': -2, 'fell short': -2, 'worse than expected': -2.5, 'weaker than expected': -2.5,
  'stronger than expected': 2.5,
  'raises guidance': 3, 'raised guidance': 3, 'raises outlook': 3, 'raises forecast': 3, 'lifts forecast': 3,
  'boosts outlook': 3, 'hikes dividend': 2.5, 'raises dividend': 2.5, 'dividend increase': 2,
  'cuts guidance': -3, 'cut guidance': -3, 'lowers guidance': -3, 'cuts outlook': -3, 'cuts forecast': -3,
  'lowers forecast': -3, 'slashes forecast': -3, 'cuts dividend': -3, 'suspends dividend': -3,
  'profit warning': -3, 'going concern': -3.5, 'chapter 11': -3.5,
  'record high': 2.5, 'all time high': 2.5, 'record revenue': 2.5, 'record profit': 2.5, 'record low': -2.5,
  'price target raised': 2, 'raises price target': 2, 'price target cut': -2, 'cuts price target': -2,
  'lowers price target': -2, 'initiates coverage': 0.5,
  'stock buyback': 1.5, 'share buyback': 1.5, 'share repurchase': 1.5,
  'rate cut': 1, 'rate cuts': 1, 'rate hike': -1, 'rate hikes': -1,
  'cuts costs': 0.5, 'cost cuts': 0.5, 'cuts prices': -0.5, 'cuts jobs': -1.5, 'job cuts': -1.5,
  'short seller': -2, 'sell off': -2.5, 'selloff': -2.5, 'data breach': -2.5, 'class action': -2,
  'trading halted': -2, 'sec charges': -3, 'sec probe': -2.5, 'antitrust suit': -2.5,
  'fda approval': 3, 'fda approves': 3, 'wins approval': 2.5, 'fda rejects': -3, 'clinical hold': -3,
  'wins contract': 2.5, 'awarded contract': 2.5, 'strategic partnership': 1.5,
  'supply shortage': -1.5, 'strong demand': 2, 'weak demand': -2, 'soft demand': -1.5,
  'market share gains': 2, 'loses market share': -2, 'trade war': -2,
};

const WORDS: Record<string, number> = {
  // positive
  surge: 2.5, surges: 2.5, surged: 2.5, surging: 2.5, soar: 2.5, soars: 2.5, soared: 2.5, soaring: 2.5,
  jump: 2, jumps: 2, jumped: 2, rally: 2, rallies: 2, rallied: 2, climb: 1.5, climbs: 1.5, climbed: 1.5,
  rise: 1.2, rises: 1.2, rose: 1.2, rising: 1.2, gain: 1.5, gains: 1.5, gained: 1.5, rebound: 1.5,
  rebounds: 1.5, recover: 1.3, recovers: 1.3, recovery: 1.3, beat: 1.5, beats: 1.5, tops: 1.2,
  upgrade: 2.5, upgrades: 2.5, upgraded: 2.5, outperform: 2, outperforms: 2, overweight: 1.5, bullish: 2,
  buy: 0.8, strong: 1.2, strength: 1.2, robust: 1.5, growth: 1, grows: 1, grew: 1, expands: 1, expansion: 1,
  profit: 1, profits: 1, profitable: 1.5, record: 1, boost: 1.5, boosts: 1.5, boosted: 1.5,
  win: 1.5, wins: 1.5, won: 1.5, approval: 1.5, approved: 1.5, approves: 1.5, breakthrough: 2,
  optimism: 1.5, optimistic: 1.5, upbeat: 1.5, momentum: 1, accelerates: 1.5, accelerating: 1.5,
  exceeds: 2, exceeded: 2, outpaces: 1.5, tailwind: 1.2, tailwinds: 1.2, windfall: 1.5, booming: 2, boom: 1.5,
  // negative
  plunge: -2.5, plunges: -2.5, plunged: -2.5, plummet: -2.5, plummets: -2.5, plummeted: -2.5,
  crash: -3, crashes: -3, crashed: -3, tumble: -2.5, tumbles: -2.5, tumbled: -2.5, sink: -2, sinks: -2,
  sank: -2, slump: -2, slumps: -2, slumped: -2, slide: -1.5, slides: -1.5, slid: -1.5, drop: -1.5,
  drops: -1.5, dropped: -1.5, fall: -1.2, falls: -1.2, fell: -1.2, falling: -1.2, decline: -1.3,
  declines: -1.3, declined: -1.3, dip: -1, dips: -1, loss: -1.5, losses: -1.5, lose: -1.2, loses: -1.2,
  lost: -1.2, miss: -1.5, misses: -1.5, missed: -1.5, downgrade: -2.5, downgrades: -2.5, downgraded: -2.5,
  underperform: -2, underweight: -1.5, bearish: -2, sell: -0.8, weak: -1.5, weakness: -1.5, weaker: -1.5,
  cut: -1, cuts: -1, slash: -1.5, slashes: -1.5, slashed: -1.5, layoffs: -2, layoff: -2,
  lawsuit: -2, sues: -1.5, sued: -2, probe: -2, investigation: -2, subpoena: -2.5, fraud: -3.5,
  scandal: -3, recall: -2, recalls: -2, bankruptcy: -3.5, bankrupt: -3.5, default: -2.5, defaults: -2.5,
  warning: -1.5, warns: -1.5, warned: -1.5, fine: -1.5, fined: -2, penalty: -1.5, ban: -2, banned: -2,
  tariff: -1.2, tariffs: -1.2, sanctions: -1.5, delay: -1.2, delays: -1.2, delayed: -1.2, halt: -1.5,
  halts: -1.5, halted: -1.5, concern: -1, concerns: -1, fears: -1.5, fear: -1.5, worries: -1.2, risk: -0.8,
  risks: -0.8, uncertainty: -1, volatile: -0.8, pressure: -1, headwind: -1.2, headwinds: -1.2,
  shortfall: -2, deficit: -1, downturn: -2, recession: -2, inflation: -0.8, crisis: -2.5, collapse: -3,
  collapses: -3, collapsed: -3, struggles: -1.5, struggling: -1.5, disappoints: -2, disappointing: -2,
  resigns: -1.5, ousted: -2, fired: -1.5, hack: -2, hacked: -2.5, breach: -2, outage: -1.5, shutdown: -1.5,
  strike: -1.2, glut: -1.5, overvalued: -1.5, bubble: -1.5, dilution: -1.5, dilutive: -1.5, writedown: -2,
  impairment: -2, restatement: -2.5, delisting: -3, delisted: -3,
};

const NEGATORS = new Set(['not', 'no', 'never', "isn't", "doesn't", "didn't", "won't", 'without', 'fails', 'failed', 'unable', 'despite']);
const BOOST: Record<string, number> = { sharply: 1.4, massive: 1.4, huge: 1.3, strongly: 1.3, significantly: 1.3, slightly: 0.6, modestly: 0.6, marginally: 0.5 };

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/all-time/g, 'all time')
    .replace(/sell-off/g, 'selloff')
    .replace(/[^a-z0-9'%$.\s-]/g, ' ')
    .replace(/[-.]+(?=\s|$)/g, ' ')
    .split(/\s+/)
    .map((t) => t.replace(/^[-'.]+|[-'.]+$/g, ''))
    .filter(Boolean);
}

export function scoreText(text: string): Sentiment {
  const toks = tokenize(text);
  const used = new Array(toks.length).fill(false);
  const hits: string[] = [];
  let sum = 0;
  let n = 0;

  const apply = (start: number, len: number, weight: number, term: string) => {
    let w = weight;
    // look back up to 3 tokens for a negator or an intensifier
    for (let j = Math.max(0, start - 3); j < start; j++) {
      if (NEGATORS.has(toks[j])) w = -w * 0.7;
      else if (BOOST[toks[j]]) w *= BOOST[toks[j]];
    }
    const after = toks[start + len];
    if (after && BOOST[after]) w *= BOOST[after];
    sum += w;
    n++;
    hits.push(term);
    for (let k = start; k < start + len; k++) used[k] = true;
  };

  for (let len = 4; len >= 2; len--) {
    for (let i = 0; i + len <= toks.length; i++) {
      if (used.slice(i, i + len).some(Boolean)) continue;
      const p = toks.slice(i, i + len).join(' ');
      if (PHRASES[p] !== undefined) apply(i, len, PHRASES[p], p);
    }
  }
  for (let i = 0; i < toks.length; i++) {
    if (used[i]) continue;
    if (PHRASES[toks[i]] !== undefined) apply(i, 1, PHRASES[toks[i]], toks[i]);
    else if (WORDS[toks[i]] !== undefined) apply(i, 1, WORDS[toks[i]], toks[i]);
  }

  if (n === 0) return { score: 0, label: 'neutral', hits };
  // Normalise: one strong term saturates near +-0.75, mixed terms cancel out.
  const raw = sum / Math.sqrt(n);
  const score = Math.max(-1, Math.min(1, Math.tanh(raw / 2.6)));
  const label: Label = score >= 0.15 ? 'positive' : score <= -0.15 ? 'negative' : 'neutral';
  return { score: Math.round(score * 100) / 100, label, hits };
}

// Headline carries the signal; the snippet only nudges it.
export function scoreHeadline(title: string, summary = ''): Sentiment {
  const t = scoreText(title);
  if (!summary) return t;
  const s = scoreText(summary);
  if (s.hits.length === 0) return t;
  if (t.hits.length === 0) return { ...s, score: Math.round(s.score * 60) / 100, label: labelOf(s.score * 0.6) };
  const score = Math.round((t.score * 0.75 + s.score * 0.25) * 100) / 100;
  return { score, label: labelOf(score), hits: [...t.hits, ...s.hits] };
}

export function labelOf(score: number): Label {
  return score >= 0.15 ? 'positive' : score <= -0.15 ? 'negative' : 'neutral';
}

export interface Scored {
  score: number;
  time: number; // ms epoch
  weight: number; // source weight
}

// Recency-weighted mean: an item loses half its weight every `halfLifeH` hours.
export function aggregate(items: Scored[], now = Date.now(), halfLifeH = 24): { score: number; label: Label; n: number } {
  let num = 0;
  let den = 0;
  for (const it of items) {
    const ageH = Math.max(0, (now - it.time) / 3.6e6);
    const w = it.weight * Math.pow(0.5, ageH / halfLifeH);
    num += it.score * w;
    den += w;
  }
  const score = den > 0 ? Math.round((num / den) * 100) / 100 : 0;
  return { score, label: labelOf(score), n: items.length };
}
