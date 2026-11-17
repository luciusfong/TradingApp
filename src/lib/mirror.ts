// Keeps the Android background job's copy of the paper account and strategies in
// step with the app (native/java/StrategyCheck.java). Every change to the account,
// the rules or the log bumps a revision number; the copy carries that number.
// When the job acts while the app is closed it writes the next revision with
// from = "bg", and the app adopts that copy the next time it opens.
import { Preferences } from '@capacitor/preferences';
import { loadPaper, read, write } from './store';
import { loadLog, loadRules } from './strategy';

const KEY = 'strategy.state';
export const PAPER_EVENT = 'ta-paper-changed';

const subs = new Set<() => void>();
export const onLocalChange = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };
/** Called by savePaper, saveRules and saveLog. */
export function localChanged() {
  write('ta.rev', read<number>('ta.rev', 0) + 1);
  subs.forEach((f) => f());
}

export function mirrorStrategies(bg: boolean) {
  const state = { rev: read<number>('ta.rev', 0), from: 'app', bg, paper: loadPaper(), rules: loadRules(), log: loadLog() };
  return Preferences.set({ key: KEY, value: JSON.stringify(state) }).catch(() => undefined);
}

/** Takes over what the background job did while the app was closed. Returns its new activity entries, newest first. */
// Calls made at the same moment share one read, so each of them sees what was taken over.
let inflight: Promise<{ text: string }[]> | null = null;
export function adoptBackground(): Promise<{ text: string }[]> {
  inflight ??= adopt().finally(() => { inflight = null; });
  return inflight;
}
async function adopt(): Promise<{ text: string }[]> {
  let s: any;
  try {
    const { value } = await Preferences.get({ key: KEY });
    s = value ? JSON.parse(value) : null;
  } catch {
    return [];
  }
  if (!s || s.from !== 'bg' || typeof s.rev !== 'number' || s.rev <= read<number>('ta.rev', 0)) return [];
  if (!s.paper || !Array.isArray(s.rules) || !Array.isArray(s.log)) return [];
  const seen = Math.max(0, ...loadLog().map((f) => f.time));
  const fresh = s.log.filter((f: any) => f && f.bg && typeof f.time === 'number' && f.time > seen && typeof f.text === 'string');
  write('ta.paper', s.paper);
  write('ta.rules', s.rules);
  write('ta.rulelog', s.log);
  write('ta.rev', s.rev);
  window.dispatchEvent(new Event(PAPER_EVENT));
  return fresh;
}
