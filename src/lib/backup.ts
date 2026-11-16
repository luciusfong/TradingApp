// Backup and restore of what the app keeps on the phone: watchlist, settings,
// Screener filters and the paper account. API keys and tokens are never put in
// a backup, and alerts are left off after a restore because Android's
// notification permission belongs to the phone, not the data.
import { Capacitor } from '@capacitor/core';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';

const KEYS = ['ta.watchlist', 'ta.settings', 'ta.filters', 'ta.paper'] as const;
export interface Backup { app: 'TradingApp'; kind: 'backup'; version: 1; savedAt: string; data: Record<string, unknown> }
type Get = (key: string) => string | null;
type Set = (key: string, value: string) => void;

const parse = (text: string | null): any => {
  if (text === null) return undefined;
  try { return JSON.parse(text); } catch { return undefined; }
};
const withoutSecrets = (settings: any) => (settings && typeof settings === 'object' ? { ...settings, finnhubKey: '', notify: false } : settings);

export function makeBackup(get: Get, now = new Date()): Backup {
  const data: Record<string, unknown> = {};
  for (const k of KEYS) {
    const v = parse(get(k));
    if (v !== undefined) data[k] = k === 'ta.settings' ? withoutSecrets(v) : v;
  }
  return { app: 'TradingApp', kind: 'backup', version: 1, savedAt: now.toISOString(), data };
}

export function readBackup(text: string): { backup: Backup } | { error: string } {
  const b = parse(text);
  if (!b || b.app !== 'TradingApp' || b.kind !== 'backup' || typeof b.data !== 'object' || b.data === null) return { error: 'This file is not a TradingApp backup.' };
  if (b.version !== 1) return { error: 'This backup was made by a newer version of TradingApp. Update the app, then restore.' };
  return { backup: b as Backup };
}

export function describeBackup(b: Backup): string {
  const list = b.data['ta.watchlist'];
  const paper = b.data['ta.paper'] as any;
  const tickers = Array.isArray(list) ? list.length : 0;
  const positions = paper && typeof paper.positions === 'object' && paper.positions ? Object.keys(paper.positions).length : 0;
  const when = new Date(b.savedAt);
  const date = isNaN(when.getTime()) ? 'an unknown date' : when.toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  return `Backup from ${date}: ${tickers} watchlist ${tickers === 1 ? 'ticker' : 'tickers'}, ${positions} paper ${positions === 1 ? 'position' : 'positions'}, settings and Screener filters.`;
}

// Replaces what is on the phone with the backup. The Finnhub key already on this phone is kept.
export function applyBackup(b: Backup, get: Get, set: Set): void {
  const keep = parse(get('ta.settings'));
  for (const k of KEYS) {
    if (!(k in b.data)) continue;
    const v = k === 'ta.settings' ? { ...withoutSecrets(b.data[k]), finnhubKey: typeof keep?.finnhubKey === 'string' ? keep.finnhubKey : '' } : b.data[k];
    set(k, JSON.stringify(v));
  }
  set('ta.v3', 'true'); // the restored watchlist is the user's own; never treat it as the old pre-filled one
}

export const backupName = (now = new Date()) => `TradingApp-backup-${now.toISOString().slice(0, 10)}.json`;

// On the phone this opens Android's share sheet, so the file can go to Google
// Drive, OneDrive, Gmail or anywhere else. Returns false if the sheet was dismissed.
export async function shareBackup(b: Backup): Promise<boolean> {
  const text = JSON.stringify(b, null, 2);
  const name = backupName(new Date(b.savedAt));
  if (!Capacitor.isNativePlatform()) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    a.download = name;
    a.click();
    URL.revokeObjectURL(a.href);
    return true;
  }
  const file = await Filesystem.writeFile({ path: name, data: text, directory: Directory.Cache, encoding: Encoding.UTF8 });
  try {
    await Share.share({ title: 'TradingApp backup', files: [file.uri], dialogTitle: 'Save backup to' });
    return true;
  } catch (e) {
    if (/cancel/i.test(e instanceof Error ? e.message : String(e))) return false;
    throw e;
  }
}
