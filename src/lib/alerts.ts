// What the background alert job looks for: every symbol that currently matches a
// Screener tab's filters and is in an "active" state (a trend, a signal, a pass,
// an open breakout). The Android job (native/java/Screens.java) implements the
// same rules in Java and notifies when a key appears that was not there on its
// previous run. native/test checks the two implementations against each other.
import { macroMatch, quantMatch, turtleMatch, type Filters } from './filters';
import { macroRow, quantRow, rankTemplate, templateScore, trendTemplate, turtle, type TemplateRow } from './screen';

export interface AlertConfig {
  macro: string[];
  quant: string[];
  stocks: string[];
  futures: string[];
  f: Pick<Filters, 'macro' | 'quant' | 'tech'>;
}
export interface AlertItem { tab: 'macro' | 'quant' | 'tech' | 'turtle'; symbol: string; state: string }
export const alertKey = (i: AlertItem) => `${i.tab}:${i.symbol}:${i.state}`;

export function alertItems(data: Record<string, number[] | undefined>, c: AlertConfig): AlertItem[] {
  const out: AlertItem[] = [];
  for (const s of c.macro) {
    const a = data[s];
    if (!a || a.length <= 60) continue;
    const r = macroRow(s, a, c.f.macro);
    if (r.trend !== 'mixed' && macroMatch(r, c.f.macro)) out.push({ tab: 'macro', symbol: s, state: r.trend });
  }
  for (const s of c.quant) {
    const a = data[s];
    if (!a || a.length <= 25) continue;
    const r = quantRow(s, a, c.f.quant);
    if (quantMatch(r, c.f.quant)) out.push({ tab: 'quant', symbol: s, state: r.signal });
  }
  const rows: TemplateRow[] = [];
  for (const s of c.stocks) {
    const r = data[s] && trendTemplate(s, data[s]!, c.f.tech);
    if (r) rows.push(r);
  }
  for (const r of rankTemplate(rows, 8, c.f.tech.rsMin)) {
    if (templateScore(r, c.f.tech.checks).fails.length === 0) out.push({ tab: 'tech', symbol: r.symbol, state: 'pass' });
  }
  for (const s of c.futures) {
    const t = data[s] && turtle(s, data[s]!, c.f.tech.enterN, c.f.tech.exitN);
    if (t && t.pos !== 0 && turtleMatch(t, c.f.tech)) out.push({ tab: 'turtle', symbol: s, state: t.pos === 1 ? 'long' : 'short' });
  }
  return out;
}
